// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Import verification inside the import transaction, before COMMIT (U-05,
 * B9): counts, content digests (every table re-serialized with the
 * archive's declared types, ids mapped back through cl_idmap), the trial
 * balance by company, written files and identity. Any difference rolls the
 * import back with 422 ARCHIVE_VERIFY_FAILED and a report of table names,
 * counts and check names only.
 */

import crypto from 'node:crypto';
import { ArchiveError } from './errors.js';
import { computeTrialBalance, countUnbalancedTransactions } from './fingerprint.js';
import type { ArchiveManifest, TrialBalanceRow } from './format.js';
import type { ArchivedAccess, ArchivedUser, IdentityResult } from './identity.js';
import { userRowJson } from './identity.js';
import { scopeSql, type PortabilityPlan } from './plan.js';
import { digestFor, type IdMap } from './remap.js';
import type { ArchiveClient } from './session.js';
import type { CompatResult } from './compat.js';
import { USERS_PROJECTION } from './format.js';

export interface WrittenFile {
  table: string;
  column: string;
  rowId: string;
  sha256: string;
  /** Reads the bytes back from where they were written (plaintext for signatures). */
  readBack: () => Promise<Buffer>;
}

export interface VerifyInput {
  client: ArchiveClient;
  plan: PortabilityPlan;
  manifest: ArchiveManifest;
  compat: CompatResult;
  idMap: IdMap;
  newTenantId: string;
  files: WrittenFile[];
  identity: IdentityResult;
  archivedUsers: ArchivedUser[];
  archivedAccess: ArchivedAccess[];
  /** The archived tenants row (after substitution), parsed. */
  archivedTenant: Record<string, unknown>;
}

export interface VerificationSummary {
  tables: number;
  rows: number;
  contentEqual: true;
  trialBalanceEqual: true;
  files: number;
  identity: { matched: number; created: number };
  warnings: string[];
}

interface Failure {
  check: string;
  table?: string;
  expected?: number | string;
  actual?: number | string;
}

const FETCH = 1000;

function sortTb(rows: TrialBalanceRow[]): TrialBalanceRow[] {
  return [...rows].sort((a, b) =>
    (a.companyId ?? '').localeCompare(b.companyId ?? '') || a.accountId.localeCompare(b.accountId)
    || a.status.localeCompare(b.status) || a.basis.localeCompare(b.basis));
}

export async function verifyImport(input: VerifyInput): Promise<VerificationSummary> {
  const { client, plan, manifest, compat, idMap, newTenantId } = input;
  const failures: Failure[] = [];
  const warnings: string[] = [];
  let totalRows = 0;
  const skippedTables = new Set(compat.skippedTables);

  // a + b. Counts and content per table.
  for (const mt of manifest.tables) {
    if (skippedTables.has(mt.name)) continue;
    const t = plan.byName.get(mt.name)!;
    const scope = scopeSql(plan, mt.name, 'a');
    const n = (await client.query(`SELECT count(*)::int AS n FROM "${mt.name}" a WHERE ${scope}`, [newTenantId])).rows[0] as { n: number };
    if (n.n !== mt.rows) failures.push({ check: 'count', table: mt.name, expected: mt.rows, actual: n.n });
    totalRows += n.n;
    const tc = compat.tables.find((c) => c.table === mt.name);
    if (tc && tc.skippedColumns.length > 0) {
      warnings.push(`CONTENT_NOT_VERIFIED:${mt.name}`);
      continue;
    }
    const canonical = manifest.canonical?.[mt.name] ?? t.canonical;
    const types = new Map(mt.columns);
    const selects = canonical.map((c) => {
      const ty = types.get(c);
      if (!ty) throw new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (canonical column ${mt.name}.${c}).`);
      return `a."${c}"::${ty} AS "${c}"`;
    });
    const digest = digestFor(mt.pk);
    const cursor = `v_${mt.name}`;
    const sql = mt.pk === 'uuid'
      ? `SELECT row_to_json(c)::text AS j FROM (SELECT ${selects.join(', ')} FROM "${mt.name}" a WHERE ${scope}) c
         JOIN cl_idmap m ON m.new = c."${t.pkColumn}" ORDER BY m.old`
      : `SELECT row_to_json(c)::text AS j FROM (SELECT ${selects.join(', ')} FROM "${mt.name}" a WHERE ${scope}) c`;
    await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${sql}`, [newTenantId]);
    try {
      for (;;) {
        const r = await client.query(`FETCH ${FETCH} FROM ${cursor}`);
        if (r.rows.length === 0) break;
        for (const row of r.rows as Array<{ j: string }>) digest.add(idMap.inverse(row.j));
      }
    } finally {
      await client.query(`CLOSE ${cursor}`).catch(() => undefined);
    }
    const actual = digest.hex();
    if (actual !== mt.contentDigest) failures.push({ check: 'content', table: mt.name });
  }

  // c. Trial balance by company, ids mapped back, string-equal.
  const tb = await computeTrialBalance(client, newTenantId);
  const mapped = sortTb(tb.rows.map((r) => ({
    ...r,
    companyId: r.companyId ? (idMap.getOld(r.companyId) ?? r.companyId) : null,
    accountId: idMap.getOld(r.accountId) ?? r.accountId,
  })));
  const expected = sortTb(manifest.trialBalance.rows);
  if (JSON.stringify(mapped) !== JSON.stringify(expected)) failures.push({ check: 'trialBalance', expected: expected.length, actual: mapped.length });
  if (tb.totals.debit !== manifest.trialBalance.totals.debit || tb.totals.credit !== manifest.trialBalance.totals.credit) failures.push({ check: 'trialBalanceTotals' });
  const unbalanced = await countUnbalancedTransactions(client, newTenantId);
  if (unbalanced !== manifest.unbalancedTransactions) failures.push({ check: 'unbalancedTransactions', expected: manifest.unbalancedTransactions, actual: unbalanced });

  // d. Files.
  for (const f of input.files) {
    let ok = false;
    try {
      const bytes = await f.readBack();
      ok = crypto.createHash('sha256').update(bytes).digest('hex') === f.sha256;
    } catch {
      ok = false;
    }
    if (!ok) failures.push({ check: 'file', table: f.table });
  }

  // e. Identity.
  for (const [id, before] of Object.entries(input.identity.matchedRowsBefore)) {
    if ((await userRowJson(client, id)) !== before) failures.push({ check: 'identity.matchedUnchanged', table: 'users' });
  }
  const createdSet = new Set(input.identity.created);
  for (const u of input.archivedUsers) {
    const newId = idMap.get(u.id) ?? u.id.toLowerCase();
    if (!createdSet.has(newId)) continue;
    const r = (await client.query(
      `SELECT row_to_json(x)::text AS j FROM (SELECT ${USERS_PROJECTION.map((c) => `u."${c}"`).join(', ')} FROM users u WHERE u.id = $1) x`,
      [newId],
    )).rows[0] as { j: string } | undefined;
    if (!r) {
      failures.push({ check: 'identity.created', table: 'users' });
      continue;
    }
    const live = JSON.parse(idMap.inverse(r.j)) as Record<string, unknown>;
    const archived = u as unknown as Record<string, unknown>;
    for (const c of USERS_PROJECTION) {
      const a = c === 'email' ? String(archived[c]).trim().toLowerCase() : archived[c];
      const l = live[c];
      const same = c === 'id' ? String(l).toLowerCase() === String(a).toLowerCase() : JSON.stringify(l) === JSON.stringify(a ?? null);
      if (!same && !(c === 'is_active' && a === null && l === true)) failures.push({ check: `identity.created.${c}`, table: 'users' });
    }
    const home = (await client.query('SELECT is_super_admin, tfa_enabled FROM users WHERE id = $1', [newId])).rows[0] as { is_super_admin: boolean; tfa_enabled: boolean };
    if (home.is_super_admin || home.tfa_enabled) failures.push({ check: 'identity.created.flags', table: 'users' });
  }
  for (const a of input.archivedAccess) {
    const userId = idMap.get(a.user_id) ?? a.user_id.toLowerCase();
    const r = await client.query('SELECT role, is_active FROM user_tenant_access WHERE user_id = $1 AND tenant_id = $2', [userId, newTenantId]);
    const row = r.rows[0] as { role: string; is_active: boolean } | undefined;
    if (!row) {
      // Access rows whose user was never exported are skipped by the identity step.
      const exists = (await client.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows.length > 0;
      if (exists) failures.push({ check: 'identity.access', table: 'user_tenant_access' });
      continue;
    }
    if (row.role !== a.role || row.is_active !== (a.is_active ?? true)) failures.push({ check: 'identity.accessRole', table: 'user_tenant_access' });
  }
  const tenantRow = (await client.query('SELECT report_settings, practice_settings, share_settings, is_workspace FROM tenants WHERE id = $1', [newTenantId])).rows[0] as Record<string, unknown>;
  for (const c of ['report_settings', 'practice_settings', 'share_settings']) {
    // Both sides carry new ids (the archived row was substituted before the insert): compare them mapped back.
    const live = idMap.inverse(JSON.stringify(tenantRow[c] ?? null));
    const archived = idMap.inverse(JSON.stringify(input.archivedTenant[c] ?? null));
    if (live !== archived) failures.push({ check: `tenant.${c}`, table: 'tenants' });
  }
  if (tenantRow['is_workspace'] !== false) failures.push({ check: 'tenant.is_workspace', table: 'tenants' });

  if (failures.length > 0) {
    const summary = [...new Set(failures.map((f) => (f.table ? `${f.check}(${f.table})` : f.check)))].slice(0, 12).join(', ');
    throw new ArchiveError('ARCHIVE_VERIFY_FAILED', `The restored data did not match the archive (${summary}); nothing was changed.`, {
      failures, tables: [...new Set(failures.map((f) => f.table).filter(Boolean))],
    });
  }
  return {
    tables: manifest.tables.length - skippedTables.size,
    rows: totalRows,
    contentEqual: true,
    trialBalanceEqual: true,
    files: input.files.length,
    identity: { matched: input.identity.matched.length, created: input.identity.created.length },
    warnings,
  };
}
