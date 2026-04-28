// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, sql } from 'drizzle-orm';
import type { Action, RuleScope } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, contacts, tenantFirmAssignments } from '../db/schema/index.js';
import * as firmTagTemplatesService from './firm-tag-templates.service.js';

// 3-tier rules plan, Phase 4 — symbol resolution.
//
// When a rule's scope is `tenant_user` or `tenant_firm`, action
// targets are stored as concrete UUIDs from the rule's tenant —
// no resolution needed; pass through.
//
// When the scope is `global_firm`, the action targets stored in
// the JSONB are UUIDs from the original tenant the rule was
// authored on (or the firm-admin's preferred tenant). Those
// UUIDs are meaningless to other tenants. This service
// re-resolves them to the target tenant's equivalents at
// evaluation time:
//
//   - set_account: source account id → its system_tag → target
//     tenant's account with the same system_tag. Drop the action
//     if no system_tag is set on the source OR no account in the
//     target tenant carries the same tag.
//   - set_vendor:  source contact id → its display_name →
//     findOrCreateContact in target tenant by exact name. Always
//     succeeds (creates if missing).
//   - set_tag:     deferred to Phase 7 (firm tag templates).
//                  Drop silently for now.
//   - split_by_*:  per-leg account resolution as above. If ANY
//                  leg's account fails to resolve, the entire
//                  split action is dropped (partial splits would
//                  unbalance the resulting transaction).
//   - mark_for_review / skip_ai: pass through (no targets).
//
// Resolution failures are silent + logged. The pipeline still
// records a fire (so the audit log shows what the rule did) but
// the unresolved action contributes nothing to the staged
// categorization.

export interface ResolveOptions {
  scope: RuleScope;
}

// Cache the source-account → system_tag and source-contact →
// display_name lookups across actions in the same call. A rule
// with multiple set_account / split_by_* legs against the same
// source account triggers one query instead of N.
interface ResolveCaches {
  systemTagBySourceAccountId: Map<string, string | null>;
  vendorNameBySourceContactId: Map<string, string | null>;
  targetAccountIdBySystemTag: Map<string, string | null>;
  targetContactIdByName: Map<string, string | null>;
  // 3-tier rules plan, Phase 7 — caches the
  // tenantFirmTagBindings.tag_id lookup so a rule with several
  // splits referencing the same template only hits the DB once.
  tagIdByTemplateKey: Map<string, string | null>;
  // The firm managing the current tenant — looked up once
  // per-resolveActions call rather than per-action.
  managingFirmId: string | null | undefined;
}

function newCaches(): ResolveCaches {
  return {
    systemTagBySourceAccountId: new Map(),
    vendorNameBySourceContactId: new Map(),
    targetAccountIdBySystemTag: new Map(),
    targetContactIdByName: new Map(),
    tagIdByTemplateKey: new Map(),
    managingFirmId: undefined,
  };
}

export async function resolveActionsForTenant(
  tenantId: string,
  actions: Action[],
  opts: ResolveOptions,
): Promise<Action[]> {
  // Tenant-scoped rules already store targets in the right tenant.
  if (opts.scope !== 'global_firm') return actions;

  const caches = newCaches();
  const out: Action[] = [];
  for (const action of actions) {
    const resolved = await resolveOneAction(tenantId, action, caches);
    if (resolved) out.push(resolved);
  }
  return out;
}

async function resolveOneAction(
  tenantId: string,
  action: Action,
  caches: ResolveCaches,
): Promise<Action | null> {
  switch (action.type) {
    case 'set_account': {
      const id = await resolveAccountIdAcrossTenants(tenantId, action.accountId, caches);
      if (!id) return null;
      return { ...action, accountId: id };
    }
    case 'set_vendor': {
      const id = await resolveVendorIdAcrossTenants(tenantId, action.vendorId, caches);
      if (!id) return null;
      return { ...action, vendorId: id };
    }
    case 'set_tag': {
      // 3-tier rules plan, Phase 7 — tag templates. A
      // global_firm rule's set_tag action carries a
      // tagTemplateKey instead of a uuid. Resolve through
      // tenant_firm_tag_bindings:
      //   - find the firm managing the target tenant
      //   - look up (firm, template_key, tenant) → tag_id
      //   - drop silently if no binding exists for this tenant
      // Backward compat: if the action only has a tagId (legacy
      // pre-Phase-7 globals or tenant-scope rules under the
      // resolver), the cross-tenant lookup is skipped — the
      // tagId is used as-is. (For tenant-scope, we exited at
      // the top of resolveActionsForTenant; this branch is
      // global-only.)
      if (action.tagTemplateKey) {
        const id = await resolveTagTemplateForTenant(
          tenantId,
          action.tagTemplateKey,
          caches,
        );
        if (!id) return null;
        return { type: 'set_tag', tagId: id };
      }
      // Legacy global with a raw tagId — unsafe across tenants.
      // Drop silently rather than stamp a foreign tenant's tag.
      return null;
    }
    case 'set_memo':
    case 'mark_for_review':
    case 'skip_ai':
      return action;
    case 'set_class':
    case 'set_location':
      // Already deferred at the engine level — defensive drop.
      return null;
    case 'split_by_percentage': {
      const legs: typeof action.splits = [];
      for (const leg of action.splits) {
        const id = await resolveAccountIdAcrossTenants(tenantId, leg.accountId, caches);
        if (!id) {
          // Drop the entire split if any leg fails — partial
          // splits would post an unbalanced transaction.
          return null;
        }
        legs.push({ ...leg, accountId: id });
      }
      return { ...action, splits: legs };
    }
    case 'split_by_fixed': {
      const legs: typeof action.splits = [];
      for (const leg of action.splits) {
        const id = await resolveAccountIdAcrossTenants(tenantId, leg.accountId, caches);
        if (!id) return null;
        legs.push({ ...leg, accountId: id });
      }
      return { ...action, splits: legs };
    }
    default:
      return action;
  }
}

// Looks up `sourceAccountId` (an accounts.id from any tenant) to
// find its system_tag, then looks up the same system_tag in the
// target tenant. Returns the target tenant's account id or null
// if either step fails.
async function resolveAccountIdAcrossTenants(
  targetTenantId: string,
  sourceAccountId: string,
  caches: ResolveCaches,
): Promise<string | null> {
  let systemTag = caches.systemTagBySourceAccountId.get(sourceAccountId);
  if (systemTag === undefined) {
    const row = await db.query.accounts.findFirst({
      where: eq(accounts.id, sourceAccountId),
      columns: { systemTag: true },
    });
    systemTag = row?.systemTag ?? null;
    caches.systemTagBySourceAccountId.set(sourceAccountId, systemTag);
  }
  if (!systemTag) return null;

  const cached = caches.targetAccountIdBySystemTag.get(systemTag);
  if (cached !== undefined) return cached;

  const row = await db.query.accounts.findFirst({
    where: and(
      eq(accounts.tenantId, targetTenantId),
      eq(accounts.systemTag, systemTag),
      eq(accounts.isActive, true),
    ),
    columns: { id: true },
  });
  const id = row?.id ?? null;
  caches.targetAccountIdBySystemTag.set(systemTag, id);
  return id;
}

// Looks up `sourceContactId` (a contacts.id from any tenant) to
// find its display_name, then findOrCreateContact in the target
// tenant. Always succeeds when the source contact exists — the
// target gets a vendor row auto-created if missing.
async function resolveVendorIdAcrossTenants(
  targetTenantId: string,
  sourceContactId: string,
  caches: ResolveCaches,
): Promise<string | null> {
  let name = caches.vendorNameBySourceContactId.get(sourceContactId);
  if (name === undefined) {
    const row = await db.query.contacts.findFirst({
      where: eq(contacts.id, sourceContactId),
      columns: { displayName: true },
    });
    name = row?.displayName ?? null;
    caches.vendorNameBySourceContactId.set(sourceContactId, name);
  }
  if (!name) return null;

  const cached = caches.targetContactIdByName.get(name);
  if (cached !== undefined) return cached;
  const id = await findOrCreateContact(targetTenantId, name);
  caches.targetContactIdByName.set(name, id);
  return id;
}

// 3-tier rules plan, Phase 7 — resolve a tag template_key to
// the tenant-local tags.id via the firm's tenant_firm_tag_bindings
// row. Reads the managing firm once and caches per-call.
async function resolveTagTemplateForTenant(
  targetTenantId: string,
  templateKey: string,
  caches: ResolveCaches,
): Promise<string | null> {
  if (caches.managingFirmId === undefined) {
    const assignment = await db.query.tenantFirmAssignments.findFirst({
      where: and(
        eq(tenantFirmAssignments.tenantId, targetTenantId),
        eq(tenantFirmAssignments.isActive, true),
      ),
      columns: { firmId: true },
    });
    caches.managingFirmId = assignment?.firmId ?? null;
  }
  if (!caches.managingFirmId) return null;
  const cached = caches.tagIdByTemplateKey.get(templateKey);
  if (cached !== undefined) return cached;
  const tagId = await firmTagTemplatesService.resolveTagFromTemplate(
    caches.managingFirmId,
    templateKey,
    targetTenantId,
  );
  caches.tagIdByTemplateKey.set(templateKey, tagId);
  return tagId;
}

// 3-tier rules plan, Phase 4 — extract from bank-rules.service.
// Hosted here so the legacy bank-rules evaluator AND the
// conditional-rules pipeline both call ONE implementation. The
// legacy service re-imports this from rule-symbol-resolution
// (see bank-rules.service.ts).
//
// Exact-match-then-create. Case-insensitive on display_name.
export async function findOrCreateContact(
  tenantId: string,
  displayName: string,
): Promise<string | null> {
  const trimmed = displayName.trim();
  if (!trimmed) return null;
  const existing = await db.query.contacts.findFirst({
    where: and(
      eq(contacts.tenantId, tenantId),
      sql`LOWER(${contacts.displayName}) = LOWER(${trimmed})`,
    ),
  });
  if (existing) return existing.id;
  const [created] = await db.insert(contacts).values({
    tenantId,
    displayName: trimmed,
    contactType: 'vendor',
  }).returning();
  return created?.id ?? null;
}
