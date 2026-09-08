// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Client-portal bank-login repair (Plaid Link update mode). A portal
// contact with `bank_repair_access` on a company can see which of that
// company's bank connections need a fresh sign-in and re-authenticate
// them without a staff-sent invite link.
//
// Authorization boundary: the company → item walk in
// `listCompanyConnections` (accounts eligible for the company under the
// portal banking NULL-company rule → plaid_account_mappings for the
// tenant → plaid_accounts → plaid_items). A plaidItemId the client sends
// is honoured ONLY if it comes back from that walk. plaid_items are
// appliance-global and may be shared with other tenants/companies —
// nothing outside the caller's company is ever echoed.
//
// Token creation and completion mirror the tokenized repair-invite path
// (bank-connect-invite.service): update-mode Link token with the ONE
// registered OAuth return URL, then `refreshItemStatus` for a truthful
// heal plus a sync kick. The client never receives an access token.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, plaidItems, portalContactCompanies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { decrypt } from '../utils/encryption.js';
import * as plaidClient from './plaid-client.service.js';
import { oauthRedirectUri } from './bank-connect-invite.service.js';
import { eligibleAccountConditions, tenantHasSingleCompany } from './portal-banking.service.js';
import { log } from '../utils/logger.js';

export const NEEDS_ATTENTION_STATUSES = ['login_required', 'pending_disconnect', 'error'] as const;

export interface PortalConnection {
  plaidItemId: string;
  institutionName: string | null;
  itemStatus: string;
  needsAttention: boolean;
  // Client-safe explanation (never the raw Plaid error text).
  message: string | null;
  lastSuccessAt: string | null;
  accounts: Array<{ name: string; mask: string | null }>;
}

// Throws unless the contact is linked to this company with
// bank_repair_access AND the company belongs to the session tenant (the
// tenant join blocks cross-tenant probes, same as assertBankingAccess).
export async function assertBankRepairAccess(tenantId: string, contactId: string, companyId: string): Promise<void> {
  const link = await db
    .select({ ok: portalContactCompanies.bankRepairAccess })
    .from(portalContactCompanies)
    .innerJoin(companies, eq(companies.id, portalContactCompanies.companyId))
    .where(and(
      eq(portalContactCompanies.contactId, contactId),
      eq(portalContactCompanies.companyId, companyId),
      eq(companies.tenantId, tenantId),
    ))
    .limit(1);
  if (link.length === 0 || !link[0]?.ok) {
    throw AppError.forbidden('Fixing bank logins is not enabled for your account', 'BANK_REPAIR_NOT_ENABLED');
  }
}

function friendlyMessage(itemStatus: string): string | null {
  switch (itemStatus) {
    case 'login_required':
      return 'Your bank needs you to sign in again before transactions can be pulled.';
    case 'pending_disconnect':
      return 'Your bank is about to disconnect this connection. Sign in again to keep it active.';
    case 'error':
      return 'This connection has stopped syncing. Signing in to your bank again usually fixes it.';
    default:
      return null;
  }
}

interface WalkRow {
  item_id: string; institution_name: string | null; item_status: string; last_success_at: Date | null;
  created_by_email: string | null; acct_name: string; mask: string | null;
}

export async function listCompanyConnections(tenantId: string, companyId: string): Promise<PortalConnection[]> {
  const single = await tenantHasSingleCompany(tenantId);
  const rows = await db.execute(sql`
    SELECT pi.id AS item_id, pi.institution_name, pi.item_status, pi.last_success_at, pi.created_by_email,
           pa.name AS acct_name, pa.mask
    FROM accounts a
    JOIN plaid_account_mappings pam ON pam.mapped_account_id = a.id AND pam.tenant_id = ${tenantId}
    JOIN plaid_accounts pa ON pa.id = pam.plaid_account_id
    JOIN plaid_items pi ON pi.id = pa.plaid_item_id AND pi.removed_at IS NULL AND pi.item_status <> 'removed'
    WHERE ${eligibleAccountConditions(tenantId, companyId, single)}
    ORDER BY pi.institution_name, pa.name
  `);
  const byItem = new Map<string, PortalConnection>();
  for (const r of rows.rows as unknown as WalkRow[]) {
    let c = byItem.get(r.item_id);
    if (!c) {
      c = {
        plaidItemId: r.item_id,
        institutionName: r.institution_name,
        itemStatus: r.item_status,
        needsAttention: (NEEDS_ATTENTION_STATUSES as readonly string[]).includes(r.item_status),
        message: friendlyMessage(r.item_status),
        lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
        accounts: [],
      };
      byItem.set(r.item_id, c);
    }
    c.accounts.push({ name: r.acct_name, mask: r.mask });
  }
  return [...byItem.values()];
}

async function assertItemInCompany(tenantId: string, companyId: string, plaidItemId: string): Promise<PortalConnection> {
  const conn = (await listCompanyConnections(tenantId, companyId)).find((c) => c.plaidItemId === plaidItemId);
  if (!conn) throw AppError.notFound('Bank connection not found');
  return conn;
}

export async function createRepairLinkToken(
  tenantId: string,
  contactId: string,
  companyId: string,
  plaidItemId: string,
): Promise<{ linkToken: string; institutionName: string | null; oauthReturnEnabled: boolean }> {
  const conn = await assertItemInCompany(tenantId, companyId, plaidItemId);
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, plaidItemId) });
  if (!item || item.itemStatus === 'removed') throw AppError.notFound('Bank connection not found');
  const redirectUri = oauthRedirectUri();
  // Pseudo user id: Plaid's client_user_id is informational; scope it to
  // the contact so Plaid-side logs distinguish portal repairs.
  const token = await plaidClient.createUpdateLinkToken(
    'system',
    `portal-repair:${contactId}`,
    decrypt(item.accessTokenEncrypted),
    redirectUri ? { redirectUri } : undefined,
  );
  await auditLog(tenantId, 'update', 'plaid_item', plaidItemId, null, {
    action: 'portal_repair_link_token', contactId, companyId, institutionName: conn.institutionName,
  });
  return { linkToken: token, institutionName: conn.institutionName, oauthReturnEnabled: !!redirectUri };
}

export async function completeRepair(
  tenantId: string,
  contactId: string,
  companyId: string,
  plaidItemId: string,
): Promise<{ ok: true; institutionName: string | null; healthy: boolean; itemStatus: string }> {
  const conn = await assertItemInCompany(tenantId, companyId, plaidItemId);
  const before = conn.itemStatus;

  // Truthful heal first: itemGet reports whether the login is fixed and
  // clears error columns. Then kick a sync so the feed catches up; the
  // sync may no-op on its 30s debounce, which is fine.
  let healthy = false;
  try {
    const { refreshItemStatus } = await import('./plaid-connection.service.js');
    await refreshItemStatus(plaidItemId);
  } catch (err) {
    log.warn({ component: 'portal-bank-repair', event: 'refresh_failed', plaidItemId, err: err instanceof Error ? err.message : String(err) });
  }
  try {
    const { syncItem } = await import('./plaid-sync.service.js');
    await syncItem(plaidItemId);
  } catch {
    // Sync still failing right after repair — leave the error state for
    // the scheduler; the client's part is done either way.
  }
  const after = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, plaidItemId) });
  const itemStatus = after?.itemStatus ?? before;
  healthy = itemStatus === 'active';

  await auditLog(tenantId, 'update', 'plaid_item', plaidItemId, { itemStatus: before }, {
    action: 'portal_repair_complete', contactId, companyId, institutionName: conn.institutionName, itemStatus, healthy,
  });

  // Best-effort heads-up to whoever set the connection up.
  const notify = after?.createdByEmail;
  if (notify) {
    void (async () => {
      try {
        const systemEmail = await import('./system-email.service.js');
        const [company] = await db.select({ name: companies.businessName }).from(companies).where(eq(companies.id, companyId)).limit(1);
        const bank = conn.institutionName || 'their bank';
        await systemEmail.sendActionEmail({
          to: notify,
          subject: `${company?.name ?? 'A client'} fixed the ${bank} connection`,
          bodyText: `A client user for ${company?.name ?? 'the company'} re-authenticated the ${bank} bank connection from the client portal.`
            + (healthy ? ' The connection is syncing again.' : ' The next scheduled sync will confirm the repair.'),
        });
      } catch (err) {
        log.warn({ component: 'portal-bank-repair', event: 'notify_failed', err: err instanceof Error ? err.message : String(err) });
      }
    })();
  }

  return { ok: true, institutionName: conn.institutionName, healthy, itemStatus };
}
