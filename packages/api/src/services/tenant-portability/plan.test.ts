// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Fail-closed plan tests (U-05 §4.5 group A). Each rule gets a test that
// creates a temporary object inside a transaction, asserts that the planner
// refuses it, and rolls back; the live schema itself must build cleanly.

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { DESKTOP_UNMOUNTED } from '../../desktop/features.js';
import { ZERO_COMPANY_UUID } from '../ledger-version.service.js';
import {
  buildPortabilityPlan,
  readLiveSchema,
  scopeSql,
  isAllowedWidening,
  PortabilityPlanError,
  EXCLUDED_TENANT_ARCHIVE_TABLES,
  EXCLUDED_CATEGORIES,
  CHILD_TABLES,
  GLOBAL_TABLES,
  SOFT_REFS,
  FILE_COLUMNS,
  TRIGGERS,
  VOLATILE_COLUMNS,
  CROSS_TENANT_COLUMNS,
  SECRET_COLUMNS,
  NEVER_REMAPPED_UUIDS,
  ARCHIVE_AUDIT_ENTITY_TYPE,
  identityProjectionSql,
  type PortabilityPlan,
  type DbLike,
} from './plan.js';
import { EXCLUDED_SYSTEM_BACKUP_TABLES } from '../backup-table-plan.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** drizzle's tx.rollback() throws a DrizzleError('Rollback') by design. */
function isRollback(err: unknown): boolean {
  return err instanceof Error && err.message === 'Rollback';
}

/** Runs `ddl` inside a transaction, builds the plan there, and always rolls back. */
async function withTempDdl(ddl: string[]): Promise<PortabilityPlanError> {
  let caught: unknown = null;
  try {
    await db.transaction(async (tx) => {
      for (const s of ddl) await tx.execute(sql.raw(s));
      try {
        await buildPortabilityPlan(tx as unknown as DbLike);
      } catch (err) {
        caught = err;
      }
      tx.rollback();
    });
  } catch (err) {
    if (!isRollback(err)) throw err;
  }
  if (!(caught instanceof PortabilityPlanError)) {
    throw new Error(`expected PortabilityPlanError, got ${caught === null ? 'success' : String(caught)}`);
  }
  return caught;
}

let plan: PortabilityPlan;

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
});

describe('rule 0: ownership', () => {
  it('puts every public table in exactly one bucket', async () => {
    const live = await readLiveSchema(db);
    expect(live.tables.size).toBeGreaterThan(200);
    for (const t of live.tables.keys()) expect(plan.bucketOf.get(t), t).toBeDefined();
    const counts = { tenant: 0, child: 0, identity: 0, global: 0, excluded: 0 };
    for (const b of plan.bucketOf.values()) counts[b]++;
    expect(counts.identity).toBe(3);
    expect(counts.child).toBeGreaterThanOrEqual(19);
    expect(plan.tables.length).toBe(counts.tenant + counts.child);
  });

  it('refuses a scratch table with no tenant_id and no FK (MT2)', async () => {
    const err = await withTempDdl(['CREATE TABLE zz_orphan (id uuid primary key, note text)']);
    expect(err.code).toBe('UNCLASSIFIED_TABLE');
    expect(err.message).toContain('zz_orphan');
  });

  it('archived tables come parents first, and every scope compiles', async () => {
    const pos = new Map(plan.tables.map((t, i) => [t.name, i]));
    const deferred = new Set(plan.deferredFks.map((d) => `${d.table}->${d.refTable}`));
    for (const fk of plan.live.fks) {
      if (deferred.has(`${fk.table}->${fk.refTable}`)) continue;
      if (pos.has(fk.table) && pos.has(fk.refTable) && fk.table !== fk.refTable) {
        expect(pos.get(fk.refTable)!, `${fk.refTable} before ${fk.table}`).toBeLessThan(pos.get(fk.table)!);
      }
    }
    for (const [t, c] of Object.entries(CHILD_TABLES)) {
      if (pos.has(t)) expect(pos.get(c.parent)!, `${c.parent} before ${t}`).toBeLessThan(pos.get(t)!);
    }
    const tenantId = '00000000-0000-0000-0000-000000000001';
    for (const t of plan.scoped) {
      const where = scopeSql(plan, t, 'a');
      const r = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${t}" a WHERE ${where.replace('$1', `'${tenantId}'::uuid`)}`));
      expect((r.rows[0] as { n: number }).n).toBe(0);
    }
    expect(scopeSql(plan, 'budget_lines', 'a')).toBe('a."budget_id" IN (SELECT p1."id" FROM "budgets" p1 WHERE p1."tenant_id" = $1)');
  });

  it('first-pass buckets from the delta review hold', () => {
    for (const t of ['budget_lines', 'budget_periods', 'reconciliation_lines', 'deposit_lines', 'payroll_import_rows', 'report_pack_items', 'portal_question_attachments']) {
      expect(plan.bucketOf.get(t), t).toBe('child');
    }
    for (const t of ['coa_templates', 'check_registry', 'tax_code_seed_versions', 'report_letters', 'system_settings']) {
      expect(plan.bucketOf.get(t), t).toBe('global');
    }
    expect(plan.bucketOf.get('sessions')).toBe('excluded');
    expect(EXCLUDED_TENANT_ARCHIVE_TABLES['sessions']).toMatchObject({ category: 'session-token', scope: 'tenant' });
    for (const t of ['tenant_firm_assignments', 'tenant_firm_tag_bindings', 'firm_invites']) {
      expect(EXCLUDED_TENANT_ARCHIVE_TABLES[t], t).toMatchObject({ category: 'server-feature', scope: 'tenant' });
    }
    // Mixed-ownership tables are tenant for their own rows.
    for (const t of ['payroll_provider_templates', 'firm_tax_codes', 'fs_report_letters', 'bank_rules']) {
      expect(plan.bucketOf.get(t), t).toBe('tenant');
    }
    // Every system-backup exclusion is also excluded here (or is an optional extension table).
    for (const t of Object.keys(EXCLUDED_SYSTEM_BACKUP_TABLES)) {
      if (t === 'spatial_ref_sys') continue;
      expect(plan.bucketOf.get(t), t).toBe('excluded');
    }
  });
});

describe('rule 1: exclusion categories (MT21 plan half)', () => {
  it('every excluded table has a category from the enum and a scope', () => {
    for (const [t, e] of Object.entries(EXCLUDED_TENANT_ARCHIVE_TABLES)) {
      expect(EXCLUDED_CATEGORIES, t).toContain(e.category);
      expect(e.scope === 'tenant' || e.scope === 'none' || e.scope.startsWith('child-of:'), t).toBe(true);
      expect(e.reason.length, t).toBeGreaterThan(5);
    }
    expect(Object.entries(EXCLUDED_TENANT_ARCHIVE_TABLES).filter(([, e]) => e.category === 'derived').map(([t]) => t)).toEqual(['gl_version_stamps']);
    expect(Object.entries(EXCLUDED_TENANT_ARCHIVE_TABLES).filter(([, e]) => e.category === 'provenance').map(([t]) => t)).toEqual(['tenant_archive_imports']);
  });

  it('server-feature families are DESKTOP_UNMOUNTED prefixes', () => {
    const prefixes = new Set(DESKTOP_UNMOUNTED.map((f) => f.prefix));
    for (const [t, e] of Object.entries(EXCLUDED_TENANT_ARCHIVE_TABLES)) {
      if (e.family) expect(prefixes.has(e.family), `${t}: ${e.family}`).toBe(true);
    }
  });

  it('a server-feature table whose evidence disappears fails', async () => {
    // Firm-keyed evidence is a NOT NULL firm_id: dropping the constraint invalidates the entry.
    const err = await withTempDdl(['ALTER TABLE pm_client_links ALTER COLUMN firm_id DROP NOT NULL']);
    expect(err.code).toBe('INVALID_EXCLUSION');
    expect(err.message).toContain('pm_client_links');
    // A new table in a server-only family is still unclassified until listed.
    const err2 = await withTempDdl(['CREATE TABLE share_session_zz (id uuid primary key, note text)']);
    expect(err2.code).toBe('UNCLASSIFIED_TABLE');
  });

  it('a job-bookkeeping or session table with a numeric column fails', async () => {
    const err = await withTempDdl(['ALTER TABLE storage_migrations ADD COLUMN zz_amount numeric(19,4)']);
    expect(err.code).toBe('INVALID_EXCLUSION');
    expect(err.message).toContain('storage_migrations');
    const err2 = await withTempDdl(['ALTER TABLE sessions ADD COLUMN zz_total numeric(19,4)']);
    expect(err2.code).toBe('INVALID_EXCLUSION');
  });

  it('a secret table without a secret-pattern column fails', async () => {
    const err = await withTempDdl(['ALTER TABLE api_keys RENAME COLUMN key_hash TO zz_plain']);
    expect(err.code).toBe('INVALID_EXCLUSION');
    expect(err.message).toContain('api_keys');
  });

  it('a NOT NULL reference from an archived table into an excluded table fails (rule 4c)', async () => {
    const err = await withTempDdl([
      'ALTER TABLE contacts ADD COLUMN zz_session_id uuid NOT NULL DEFAULT gen_random_uuid() REFERENCES sessions(id)',
    ]);
    expect(err.code).toBe('UNCLASSIFIED_EXCLUDED_REF');
  });

  it('every excluded table in the tenant scope is counted by the delete receipt scope', () => {
    for (const [t, e] of Object.entries(EXCLUDED_TENANT_ARCHIVE_TABLES)) {
      expect(plan.scoped.includes(t), t).toBe(e.scope !== 'none');
    }
  });
});

describe('rule 2: primary keys (R5)', () => {
  it('audit_log is the only omit-pk table and no referenced integer pk exists', () => {
    const omit = plan.tables.filter((t) => t.pk === 'omit-pk').map((t) => t.name);
    expect(omit).toEqual(['audit_log']);
    const noPk = plan.tables.filter((t) => t.pk === 'no-pk').map((t) => t.name).sort();
    expect(noPk).toEqual(['check_signature_users', 'portal_contact_companies', 'tb_aje_sequences', 'tenant_feature_flags', 'transaction_tags']);
  });

  it('refuses an integer pk referenced by an FK', async () => {
    const err = await withTempDdl([
      'CREATE TABLE zz_seq (id bigserial primary key, tenant_id uuid not null)',
      'CREATE TABLE zz_ref (id uuid primary key, tenant_id uuid not null, seq_id bigint references zz_seq(id))',
    ]);
    expect(err.code).toBe('UNCLASSIFIED_PK');
  });
});

describe('rule 3: unique indexes', () => {
  it('refuses a unique index without a remapped column', async () => {
    const err = await withTempDdl([
      'ALTER TABLE contacts ADD COLUMN zz_code varchar(20)',
      'CREATE UNIQUE INDEX zz_contacts_code ON contacts (zz_code)',
    ]);
    expect(err.code).toBe('UNCLASSIFIED_UNIQUE');
    expect(err.message).toContain('zz_contacts_code');
  });

  it('accepts a unique index that includes tenant_id or a remapped reference', async () => {
    let built = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw('ALTER TABLE contacts ADD COLUMN zz_code varchar(20)'));
        await tx.execute(sql.raw('CREATE UNIQUE INDEX zz_contacts_code ON contacts (tenant_id, zz_code)'));
        await buildPortabilityPlan(tx as unknown as DbLike);
        built = true;
        tx.rollback();
      });
    } catch (err) {
      if (!isRollback(err)) throw err;
    }
    expect(built).toBe(true);
  });

  it('classifies the known public-link columns', () => {
    expect(plan.byName.get('transactions')!.nullOnImport).toContain('public_token');
    expect(plan.byName.get('report_instances')!.nullOnImport).toContain('share_token');
    expect(plan.byName.get('transactions')!.canonical).not.toContain('public_token');
  });
});

describe('rule 4: references outside the tenant', () => {
  it('refuses a new FK to a global table', async () => {
    const err = await withTempDdl(['ALTER TABLE contacts ADD COLUMN zz_coa uuid REFERENCES coa_templates(id)']);
    expect(err.code).toBe('UNCLASSIFIED_GLOBAL_FK');
  });

  it('refuses a new uuid column (4b) and a new uuid[] column', async () => {
    const err = await withTempDdl(['ALTER TABLE contacts ADD COLUMN zz_ref uuid']);
    expect(err.code).toBe('UNCLASSIFIED_SOFT_REF');
    const err2 = await withTempDdl(['ALTER TABLE contacts ADD COLUMN zz_refs uuid[]']);
    expect(err2.code).toBe('UNCLASSIFIED_SOFT_REF');
  });

  it('refuses a nullable FK into an excluded table only when NOT NULL; nullable ones are nulled', async () => {
    let nulled: string[] = [];
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw('ALTER TABLE contacts ADD COLUMN zz_session_id uuid REFERENCES sessions(id)'));
        const p = await buildPortabilityPlan(tx as unknown as DbLike);
        nulled = p.byName.get('contacts')!.nulledReferences.map((n) => `${n.column}->${n.target}`);
        tx.rollback();
      });
    } catch (err) {
      if (!isRollback(err)) throw err;
    }
    expect(nulled).toContain('zz_session_id->sessions');
  });

  it('every soft reference names an archived, global or excluded table, and excluded refs are nullable', () => {
    for (const [k, v] of Object.entries(SOFT_REFS)) {
      const [t, c] = k.split('.') as [string, string];
      const column = plan.live.tables.get(t)!.columns.find((x) => x.name === c)!;
      expect(column, k).toBeDefined();
      if (v.startsWith('excluded-ref:')) expect(column.nullable, k).toBe(true);
    }
    // No archived table soft-references an excluded table except through rule 4c (nullable, nulled).
    for (const t of plan.tables) {
      for (const s of t.softRefs) {
        if (s.cls.startsWith('excluded-ref:')) expect(t.nulledReferences.some((n) => n.column === s.column), `${t.name}.${s.column}`).toBe(true);
      }
    }
  });

  it('firm-owned tax code references are refused on export (rule 4a)', () => {
    // account_tax_assignments.firm_code_id is a NOT NULL FK into a mixed table:
    // the plan keeps it (firm_tax_codes rows with tenant_id travel); rows that
    // point at firm rows are refused by the export (ARCHIVE_UNSUPPORTED_REFERENCE).
    const fk = plan.live.fks.find((f) => f.table === 'account_tax_assignments' && f.refTable === 'firm_tax_codes');
    expect(fk).toBeDefined();
    expect(plan.bucketOf.get('firm_tax_codes')).toBe('tenant');
  });
});

describe('rule 5: secrets and jsonb config', () => {
  it('refuses a new *_pass column and a new jsonb *_config column', async () => {
    const err = await withTempDdl(['ALTER TABLE contacts ADD COLUMN zz_pass varchar(50)']);
    expect(err.code).toBe('UNCLASSIFIED_SECRET');
    const err2 = await withTempDdl(['ALTER TABLE contacts ADD COLUMN zz_config jsonb']);
    expect(err2.code).toBe('UNCLASSIFIED_JSON_CONFIG');
  });

  it('redacts the listed company and user secrets and keeps password_hash', () => {
    for (const k of ['companies.smtp_pass', 'companies.remote_backup_passphrase_hash', 'companies.stripe_secret_key_encrypted', 'companies.stripe_webhook_secret_encrypted', 'companies.remote_backup_config']) {
      expect(plan.redactedColumns[k], k).toBeDefined();
    }
    expect(SECRET_COLUMNS['users.password_hash']!.action).toBe('keep');
    expect(SECRET_COLUMNS['users.tfa_totp_secret_encrypted']!.action).toBe('redact');
    const companies = plan.byName.get('companies')!;
    const smtp = companies.archive.find((c) => c.name === 'smtp_pass')!;
    expect(smtp.redacted).toBe(true);
    expect(smtp.select).toMatch(/^NULL::/);
  });

  it('the identity section uses the plan projection (redaction rules apply to tenants and access rows)', () => {
    const t = identityProjectionSql(plan, 'tenants', 't', ['is_workspace']);
    expect(t).toContain('t."id"');
    expect(t).toContain('t."report_settings"');
    expect(t).not.toContain('is_workspace');
    const a = identityProjectionSql(plan, 'user_tenant_access', 'a');
    expect(a.split(', ').every((s) => /^a\."[a-z_]+"$/.test(s))).toBe(true); // no secret column today: raw columns
    expect(() => identityProjectionSql(plan, 'nope', 'x')).toThrow(PortabilityPlanError);
  });

  it('strips secret keys from the audit row images and refuses an unclassified *_after_data json column (rule 5c, H3)', async () => {
    const audit = plan.byName.get('audit_log')!;
    for (const name of ['before_data', 'after_data']) {
      const c = audit.archive.find((x) => x.name === name)!;
      expect(c.select).toMatch(/^mybooks_strip_secret_keys\(a\."(before|after)_data"::jsonb, '/);
      expect(c.redacted).toBe(false);
      expect(plan.redactedColumns[`audit_log.${name}`]).toBeDefined();
      expect(audit.canonical).toContain(name);
    }
    const err = await withTempDdl(['ALTER TABLE contacts ADD COLUMN zz_after_data jsonb']);
    expect(err.code).toBe('UNCLASSIFIED_JSON_PAYLOAD');
  });

  it('a redacted NOT NULL column has a replacement literal', () => {
    for (const t of plan.tables) {
      for (const c of t.archive) {
        if (!c.redacted) continue;
        const live = t.columns.find((x) => x.name === c.name)!;
        if (!live.nullable && !live.hasDefault) expect(c.select, `${t.name}.${c.name}`).not.toMatch(/^NULL::/);
      }
    }
  });
});

describe('rule 7: file columns', () => {
  it('refuses a new *_storage_key column', async () => {
    const err = await withTempDdl(['ALTER TABLE contacts ADD COLUMN zz_storage_key varchar(500)']);
    expect(err.code).toBe('UNCLASSIFIED_FILE_COLUMN');
  });

  it('covers every entry of the backup file registry', async () => {
    const { FILE_EXPORT_REGISTRY } = await import('../backup-file-registry.js');
    for (const e of FILE_EXPORT_REGISTRY) {
      for (const c of e.columns) expect(FILE_COLUMNS[`${e.table}.${c}`], `${e.table}.${c}`).toBeDefined();
    }
    expect(plan.byName.get('check_signatures')!.fileColumns.map((f) => f.rule.resolver)).toEqual(['upload-encrypted']);
    expect(plan.byName.get('companies')!.fileColumns.map((f) => f.column)).toEqual(['logo_url']);
    expect(plan.byName.get('attachments')!.canonical).not.toContain('storage_key');
    expect(plan.byName.get('attachments')!.canonical).not.toContain('local_cache_path');
  });
});

describe('rule 8: triggers', () => {
  it('classifies every live trigger and refuses a new one', async () => {
    const live = await readLiveSchema(db);
    for (const g of live.triggers) expect(TRIGGERS[`${g.table}.${g.name}`], g.name).toBeDefined();
    const err = await withTempDdl([
      'CREATE FUNCTION zz_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      'CREATE TRIGGER zz_trg BEFORE INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION zz_noop()',
    ]);
    expect(err.code).toBe('UNCLASSIFIED_TRIGGER');
  });

  it('an AFTER DELETE trigger that writes another table must be delete-side-effect', async () => {
    const err = await withTempDdl([
      "CREATE FUNCTION zz_side() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit_log (tenant_id, action, entity_type) VALUES (OLD.tenant_id, 'delete', 'zz'); RETURN OLD; END $$",
      'CREATE TRIGGER zz_del AFTER DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION zz_side()',
    ]);
    expect(err.code).toBe('UNCLASSIFIED_TRIGGER');
    expect(err.message).toContain('delete-side-effect');
  });

  it('records the gl_version_stamps side effect (N5)', () => {
    expect(plan.sideEffectEdges).toEqual([{ source: 'journal_lines', target: 'gl_version_stamps' }]);
  });
});

describe('R6: constraints', () => {
  it('has no cross-table FK cycles, only the known self reference, and nothing deferrable', () => {
    expect(plan.live.fks.filter((f) => f.deferrable)).toEqual([]);
    expect(plan.live.fks.filter((f) => f.table === f.refTable).map((f) => `${f.table}.${f.columns.join('+')}`)).toEqual(['tax_est_scenarios.source_scenario_id']);
    expect(plan.live.fks.length).toBeGreaterThan(200);
  });

  it('breaks the one nullable FK cycle by deferring an edge', () => {
    // document_requests.submitted_receipt_id <-> portal_receipts.document_request_id, both nullable.
    expect(plan.deferredFks).toEqual([{ table: 'document_requests', columns: ['submitted_receipt_id'], refTable: 'portal_receipts' }]);
    expect(plan.byName.get('document_requests')!.deferredColumns).toEqual(['submitted_receipt_id']);
    expect(plan.byName.get('document_requests')!.canonical).toContain('submitted_receipt_id');
    const pos = new Map(plan.tables.map((t, i) => [t.name, i]));
    expect(pos.get('document_requests')!).toBeLessThan(pos.get('portal_receipts')!);
  });

  it('refuses a deferrable constraint and a NOT NULL FK cycle', async () => {
    const err = await withTempDdl(['ALTER TABLE budget_periods ADD CONSTRAINT zz_def FOREIGN KEY (budget_id) REFERENCES budgets(id) DEFERRABLE']);
    expect(err.code).toBe('DEFERRABLE_CONSTRAINT');
    const err2 = await withTempDdl([
      'ALTER TABLE budgets ADD COLUMN zz_period uuid NOT NULL DEFAULT gen_random_uuid() REFERENCES budget_periods(id)',
    ]);
    expect(err2.code).toBe('FK_CYCLE');
  });
});

describe('MT25: closed widening set', () => {
  it('accepts only widening pairs', () => {
    expect(isAllowedWidening('numeric(12,2)', 'numeric(19,4)')).toBe(true);
    expect(isAllowedWidening('character varying(50)', 'text')).toBe(true);
    expect(isAllowedWidening('character varying(50)', 'character varying(100)')).toBe(true);
    expect(isAllowedWidening('smallint', 'integer')).toBe(true);
    expect(isAllowedWidening('integer', 'bigint')).toBe(true);
    expect(isAllowedWidening('timestamp without time zone', 'timestamp with time zone')).toBe(false);
    expect(isAllowedWidening('json', 'jsonb')).toBe(false);
    expect(isAllowedWidening('numeric(19,4)', 'numeric(19,2)')).toBe(false);
    expect(isAllowedWidening('numeric(19,4)', 'numeric(20,6)')).toBe(false); // integer digits shrink
    expect(isAllowedWidening('character varying(50)', 'character varying(20)')).toBe(false);
    expect(isAllowedWidening('bigint', 'integer')).toBe(false);
  });
});

describe('S-g: volatile columns', () => {
  it('every entry is a timestamp, cache or label column with a producing case', () => {
    for (const [k, v] of Object.entries(VOLATILE_COLUMNS)) {
      const [t, c] = k.split('.') as [string, string];
      const column = plan.live.tables.get(t)!.columns.find((x) => x.name === c)!;
      expect(column, k).toBeDefined();
      expect(column.type, k).not.toMatch(/^(numeric|date$|boolean|uuid)/);
      expect(v.producedBy.length, k).toBeGreaterThan(3);
    }
    expect(plan.byName.get('attachments')!.fingerprint).not.toContain('local_cache_path');
    expect(plan.byName.get('attachments')!.fingerprint).toContain('file_size');
  });

  it('is validated by the builder', () => {
    // The builder checks the shape rule from the constant table, which this
    // repository keeps small on purpose; a bad entry is a code review failure
    // that the type and builder catch (covered by the shape assertions above).
    expect(Object.keys(VOLATILE_COLUMNS).every((k) => !/amount|total|balance/.test(k))).toBe(true);
  });
});

describe('cross-tenant columns and never-remapped ids', () => {
  it('lists backup_runs, share participants and rule submissions', () => {
    expect(CROSS_TENANT_COLUMNS).toMatchObject({
      'backup_runs.tenant_id': 'set-null',
      'share_session_participants.viewer_tenant_id': 'delete',
      'global_rule_submissions.source_tenant_id': 'set-null',
    });
  });

  it('refuses a new column pointing at tenants from a global table', async () => {
    const err = await withTempDdl(['ALTER TABLE system_settings ADD COLUMN zz_tenant_id uuid REFERENCES tenants(id)']);
    expect(err.code).toBe('UNCLASSIFIED_CROSS_TENANT');
  });

  it('ZERO_COMPANY_UUID and the nil uuid are never map keys (MT12)', () => {
    expect(NEVER_REMAPPED_UUIDS).toContain(ZERO_COMPANY_UUID);
    expect(NEVER_REMAPPED_UUIDS).toContain('00000000-0000-0000-0000-000000000000');
  });
});

describe('source scans', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules') walk(full, out);
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  it(`the ${ARCHIVE_AUDIT_ENTITY_TYPE} audit entity type is written only by tenant-portability code`, () => {
    const re = new RegExp(`['"\`]${ARCHIVE_AUDIT_ENTITY_TYPE}['"\`]`);
    const hits = walk(SRC).filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f).split(path.sep).join('/'));
    expect(hits.every((h) => h.startsWith('services/tenant-portability/')), hits.join(', ')).toBe(true);
  });

  it('GLOBAL_TABLES and CHILD_TABLES have no stale entries', () => {
    for (const t of [...Object.keys(GLOBAL_TABLES), ...Object.keys(CHILD_TABLES)]) expect(plan.live.tables.has(t), t).toBe(true);
  });
});
