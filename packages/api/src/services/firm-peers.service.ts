// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm-side management of the Vibe Practice Management peer: the trust
// root (issuer + public key / JWKS URL) and the pm_client_links table.
// Verification itself lives in peer-token.service.ts; this module is
// what Firm Settings talks to.

import crypto from 'node:crypto';
import { and, eq, ne, inArray } from 'drizzle-orm';
import type {
  VibePmSettingsInput, VibePmSettingsView, PeerTestTokenResult, PmClientLinkView, PmLinkOptions,
  CreatePmClientLinkInput, PeerErrorCode,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  firmPeers, pmClientLinks, tenants, companies, tenantFirmAssignments,
  portalContacts, portalContactCompanies,
} from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import {
  PEER_PROVIDER, validatePublicKeyPem, validateJwksUrl, verifyPeerToken, PeerTokenError,
  fingerprintKey, clearJwksCacheForTests,
} from './peer-token.service.js';
import { listLinksForFirm } from './peer-portal.service.js';

async function getRow(firmId: string) {
  const [row] = await db.select().from(firmPeers)
    .where(and(eq(firmPeers.firmId, firmId), eq(firmPeers.provider, PEER_PROVIDER)))
    .limit(1);
  return row ?? null;
}

function describeStoredPem(pem: string | null): { kind: 'rsa' | 'ec' | null; detail: string | null; fingerprint: string | null } {
  if (!pem) return { kind: null, detail: null, fingerprint: null };
  try {
    const v = validatePublicKeyPem(pem);
    return { kind: v.kind, detail: v.detail, fingerprint: v.fingerprint };
  } catch {
    try {
      return { kind: null, detail: null, fingerprint: fingerprintKey(crypto.createPublicKey(pem)) };
    } catch {
      return { kind: null, detail: null, fingerprint: null };
    }
  }
}

export async function getVibePmSettings(firmId: string): Promise<VibePmSettingsView> {
  const row = await getRow(firmId);
  const key = describeStoredPem(row?.publicKeyPem ?? null);
  return {
    provider: 'vibe_pm',
    isEnabled: row?.isEnabled ?? false,
    issuer: row?.issuer ?? null,
    keyMode: row?.publicKeyPem ? 'pem' : row?.jwksUrl ? 'jwks' : null,
    keyKind: key.kind,
    keyDetail: key.detail,
    keyFingerprint: key.fingerprint,
    publicKeyPem: row?.publicKeyPem ?? null,
    jwksUrl: row?.jwksUrl ?? null,
    lastSeenAt: row?.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    lastError: (row?.lastError as PeerErrorCode | null) ?? null,
    lastErrorAt: row?.lastErrorAt ? row.lastErrorAt.toISOString() : null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export async function saveVibePmSettings(
  firmId: string,
  input: VibePmSettingsInput,
  actingUserId?: string,
): Promise<VibePmSettingsView> {
  const existing = await getRow(firmId);

  const issuer = input.issuer !== undefined ? input.issuer.trim() : existing?.issuer ?? null;
  const isEnabled = input.isEnabled ?? existing?.isEnabled ?? false;

  // Key material: exactly one mode. Setting one clears the other.
  let publicKeyPem = existing?.publicKeyPem ?? null;
  let jwksUrl = existing?.jwksUrl ?? null;
  let keyFingerprint: string | null = null;
  if (input.publicKeyPem !== undefined) {
    if (input.publicKeyPem === null || input.publicKeyPem.trim() === '') {
      publicKeyPem = null;
    } else {
      const v = validatePublicKeyPem(input.publicKeyPem);
      publicKeyPem = v.pem;
      keyFingerprint = v.fingerprint;
      jwksUrl = null;
    }
  }
  if (input.jwksUrl !== undefined) {
    if (input.jwksUrl === null || input.jwksUrl.trim() === '') {
      jwksUrl = null;
    } else {
      jwksUrl = validateJwksUrl(input.jwksUrl);
      publicKeyPem = null;
    }
  }
  if (publicKeyPem && jwksUrl) {
    throw AppError.badRequest('Provide either a public key or a JWKS URL, not both', 'PEER_KEY_MODE_CONFLICT');
  }
  if (isEnabled) {
    if (!issuer) throw AppError.badRequest('An issuer is required to enable the integration', 'PEER_ISSUER_REQUIRED');
    if (!publicKeyPem && !jwksUrl) throw AppError.badRequest('A public key or JWKS URL is required to enable the integration', 'PEER_KEY_REQUIRED');
  }
  if (!issuer && !existing) {
    throw AppError.badRequest('An issuer is required', 'PEER_ISSUER_REQUIRED');
  }

  if (issuer) {
    const [taken] = await db.select({ id: firmPeers.id }).from(firmPeers)
      .where(and(eq(firmPeers.issuer, issuer), ne(firmPeers.firmId, firmId)))
      .limit(1);
    if (taken) throw AppError.conflict('That issuer is already registered by another firm', 'PEER_ISSUER_TAKEN');
  }

  const values = {
    firmId,
    provider: PEER_PROVIDER,
    issuer: issuer ?? '',
    publicKeyPem,
    jwksUrl,
    isEnabled,
    updatedByUserId: actingUserId ?? null,
    updatedAt: new Date(),
    // A changed key or URL invalidates any stale error indicator.
    ...(input.publicKeyPem !== undefined || input.jwksUrl !== undefined ? { lastError: null, lastErrorAt: null } : {}),
  };
  try {
    await db.insert(firmPeers).values(values)
      .onConflictDoUpdate({ target: [firmPeers.firmId, firmPeers.provider], set: { ...values } });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
    if (code === '23505') throw AppError.conflict('That issuer is already registered by another firm', 'PEER_ISSUER_TAKEN');
    throw err;
  }
  // The JWKS cache is keyed by issuer; a changed URL must not serve old keys.
  clearJwksCacheForTests();

  await auditLog(firmId, 'update', 'firm_peer', firmId, null, {
    provider: PEER_PROVIDER,
    isEnabled,
    issuer,
    keyMode: publicKeyPem ? 'pem' : jwksUrl ? 'jwks' : null,
    keyFingerprint: keyFingerprint ?? (publicKeyPem ? describeStoredPem(publicKeyPem).fingerprint : null),
    jwksUrl,
  }, actingUserId);
  return getVibePmSettings(firmId);
}

/** "Test a token": verify without consuming the jti; report the reason. */
export async function testPeerToken(firmId: string, token: string): Promise<PeerTestTokenResult> {
  try {
    const r = await verifyPeerToken(token, { consumeJti: false, expectFirmId: firmId });
    const { sub, jti, iat, exp, pm_client_id, actor } = r.claims;
    return {
      ok: true,
      issuer: r.peer.issuer,
      claims: { ...(sub ? { sub } : {}), jti, iat, exp, ...(pm_client_id ? { pm_client_id } : {}), ...(actor ? { actor } : {}) },
    };
  } catch (err) {
    if (err instanceof PeerTokenError) return { ok: false, code: err.reason };
    throw err;
  }
}

// ─── Links ──────────────────────────────────────────────────────

export async function listLinks(firmId: string): Promise<PmClientLinkView[]> {
  return listLinksForFirm(firmId);
}

async function assertTenantManagedByFirm(firmId: string, tenantId: string): Promise<{ id: string; name: string }> {
  const [row] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenantFirmAssignments)
    .innerJoin(tenants, eq(tenants.id, tenantFirmAssignments.tenantId))
    .where(and(
      eq(tenantFirmAssignments.firmId, firmId),
      eq(tenantFirmAssignments.tenantId, tenantId),
      eq(tenantFirmAssignments.isActive, true),
    ))
    .limit(1);
  if (!row) throw AppError.notFound('Tenant is not managed by this firm');
  return row;
}

export async function listLinkOptions(firmId: string, tenantId: string): Promise<PmLinkOptions> {
  const tenant = await assertTenantManagedByFirm(firmId, tenantId);
  const companyRows = await db
    .select({ id: companies.id, name: companies.businessName })
    .from(companies)
    .where(eq(companies.tenantId, tenantId))
    .orderBy(companies.businessName);
  const contactRows = await db
    .select({
      id: portalContacts.id, email: portalContacts.email, firstName: portalContacts.firstName,
      lastName: portalContacts.lastName, status: portalContacts.status,
    })
    .from(portalContacts)
    .where(and(eq(portalContacts.tenantId, tenantId), ne(portalContacts.status, 'deleted')))
    .orderBy(portalContacts.email);
  const contactIds = contactRows.map((c) => c.id);
  const links = contactIds.length === 0 ? [] : await db
    .select({ contactId: portalContactCompanies.contactId, companyId: portalContactCompanies.companyId })
    .from(portalContactCompanies)
    .where(inArray(portalContactCompanies.contactId, contactIds));
  const byContact = new Map<string, string[]>();
  for (const l of links) byContact.set(l.contactId, [...(byContact.get(l.contactId) ?? []), l.companyId]);
  return {
    tenant,
    companies: companyRows,
    contacts: contactRows.map((c) => ({ ...c, companyIds: byContact.get(c.id) ?? [] })),
  };
}

export async function createLink(
  firmId: string,
  input: CreatePmClientLinkInput,
  actingUserId?: string,
): Promise<PmClientLinkView> {
  await assertTenantManagedByFirm(firmId, input.tenantId);
  const [company] = await db.select({ id: companies.id, tenantId: companies.tenantId })
    .from(companies).where(eq(companies.id, input.companyId)).limit(1);
  if (!company || company.tenantId !== input.tenantId) {
    throw AppError.badRequest('Company does not belong to that tenant', 'PEER_LINK_COMPANY_MISMATCH');
  }
  const [contact] = await db.select({ id: portalContacts.id, tenantId: portalContacts.tenantId, status: portalContacts.status })
    .from(portalContacts).where(eq(portalContacts.id, input.contactId)).limit(1);
  if (!contact || contact.tenantId !== input.tenantId || contact.status === 'deleted') {
    throw AppError.badRequest('Portal contact does not belong to that tenant', 'PEER_LINK_CONTACT_MISMATCH');
  }
  const [pcc] = await db.select({ contactId: portalContactCompanies.contactId }).from(portalContactCompanies)
    .where(and(eq(portalContactCompanies.contactId, input.contactId), eq(portalContactCompanies.companyId, input.companyId)))
    .limit(1);
  if (!pcc) {
    throw AppError.badRequest('That contact is not linked to that company in the client portal', 'PEER_LINK_CONTACT_NOT_IN_COMPANY');
  }
  const [dupe] = await db.select({ id: pmClientLinks.id }).from(pmClientLinks)
    .where(and(eq(pmClientLinks.firmId, firmId), eq(pmClientLinks.pmClientId, input.pmClientId))).limit(1);
  if (dupe) throw AppError.conflict('That PM client is already linked', 'PEER_LINK_EXISTS');

  let inserted: { id: string } | undefined;
  try {
    [inserted] = await db.insert(pmClientLinks).values({
      firmId,
      pmClientId: input.pmClientId,
      tenantId: input.tenantId,
      companyId: input.companyId,
      contactId: input.contactId,
      createdByUserId: actingUserId ?? null,
    }).returning({ id: pmClientLinks.id });
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
    if (code === '23505') throw AppError.conflict('That PM client is already linked', 'PEER_LINK_EXISTS');
    throw err;
  }
  await auditLog(input.tenantId, 'create', 'pm_client_link', inserted!.id, null, {
    firmId, pmClientId: input.pmClientId, companyId: input.companyId, contactId: input.contactId,
  }, actingUserId);
  const view = (await listLinksForFirm(firmId)).find((l) => l.id === inserted!.id);
  if (!view) throw AppError.internal('Link vanished after insert');
  return view;
}

export async function getLink(firmId: string, linkId: string) {
  const [row] = await db.select().from(pmClientLinks)
    .where(and(eq(pmClientLinks.firmId, firmId), eq(pmClientLinks.id, linkId))).limit(1);
  return row ?? null;
}

export async function deleteLink(firmId: string, linkId: string, actingUserId?: string): Promise<void> {
  const row = await getLink(firmId, linkId);
  if (!row) throw AppError.notFound('Link not found');
  await db.delete(pmClientLinks).where(eq(pmClientLinks.id, row.id));
  await auditLog(row.tenantId, 'delete', 'pm_client_link', row.id, {
    firmId, pmClientId: row.pmClientId, companyId: row.companyId, contactId: row.contactId,
  }, null, actingUserId);
}
