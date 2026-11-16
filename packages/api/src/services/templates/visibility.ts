// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33) for templates (memorized transactions). A
// template "touches" a hidden account when its header (bank / pay-from /
// deposit-to / transfer accounts, cash back), any of its lines, the layout
// lines of its daily-sales template or, for a legacy template, its source
// transaction's lines name one. Such a template is left out of lists and
// refused (403 SENSITIVE_ACCOUNT) on every read and write for a viewer with
// hidden accounts. With nothing hidden every helper is a no-op.

import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { hiddenAccountIds, isHiddenSql, sensitiveAccountError } from '../visibility.js';

/**
 * SQL boolean: the template row aliased `alias` touches one of `hidden`.
 * Only call with a non-empty set. Never NULL.
 */
export function templateTouchesHidden(hidden: readonly string[], alias: string): SQL {
  const col = (c: string) => sql.raw(`${alias}.${c}`);
  return sql`COALESCE((
    ${isHiddenSql(hidden, col('account_id'))}
    OR ${isHiddenSql(hidden, col('to_account_id'))}
    OR ${isHiddenSql(hidden, col('cash_back_account_id'))}
    OR EXISTS (SELECT 1 FROM template_transaction_lines ttl_h
               WHERE ttl_h.tenant_id = ${col('tenant_id')} AND ttl_h.template_id = ${col('id')}
                 AND ${isHiddenSql(hidden, sql.raw('ttl_h.account_id'))})
    OR EXISTS (SELECT 1 FROM daily_sales_template_lines dsl_h
               WHERE dsl_h.tenant_id = ${col('tenant_id')} AND dsl_h.template_id = ${col('daily_sales_template_id')}
                 AND ${isHiddenSql(hidden, sql.raw('dsl_h.account_id'))})
    OR (${col('kind')} = 'legacy' AND EXISTS (SELECT 1 FROM journal_lines jl_h
               WHERE jl_h.tenant_id = ${col('tenant_id')} AND jl_h.transaction_id = ${col('source_transaction_id')}
                 AND ${isHiddenSql(hidden, sql.raw('jl_h.account_id'))}))
  ), false)`;
}

/** WHERE condition leaving out templates that touch a hidden account; undefined (no condition) when nothing is hidden. */
export function visibleTemplate(hidden: readonly string[], alias = 'template_transactions'): SQL | undefined {
  if (hidden.length === 0) return undefined;
  return sql`NOT ${templateTouchesHidden(hidden, alias)}`;
}

/** Raw-SQL form: ` AND NOT <touches>` or an empty fragment when nothing is hidden. */
export function andVisibleTemplate(hidden: readonly string[], alias: string): SQL {
  if (hidden.length === 0) return sql``;
  return sql` AND NOT ${templateTouchesHidden(hidden, alias)}`;
}

/** 403 SENSITIVE_ACCOUNT when template `id` touches an account hidden from the current viewer. */
export async function assertTemplateVisible(exec: DbOrTx, tenantId: string, id: string): Promise<void> {
  const hidden = await hiddenAccountIds();
  if (hidden.length === 0) return;
  const r = await exec.execute(sql`
    SELECT 1 FROM template_transactions tt
    WHERE tt.tenant_id = ${tenantId} AND tt.id = ${id} AND ${templateTouchesHidden(hidden, 'tt')}
    LIMIT 1`);
  if (r.rows.length > 0) throw sensitiveAccountError();
}
