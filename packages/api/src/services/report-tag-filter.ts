import { sql } from 'drizzle-orm';

export interface TagFilterOptions {
  tagIds?: string[];
  tagMode?: 'any' | 'all';
  excludeTagIds?: string[];
  untaggedOnly?: boolean;
}

/**
 * Builds a SQL fragment for tag-based filtering of transactions.
 * Returns a condition string to append to WHERE clause, or empty string if no filter.
 * Expects `t.id` to be the transaction ID column alias.
 */
export function buildTagFilterSql(tenantId: string, opts?: TagFilterOptions): string {
  if (!opts) return '';
  const parts: string[] = [];

  if (opts.tagIds && opts.tagIds.length > 0) {
    const idList = opts.tagIds.map((id) => `'${id}'`).join(',');
    if (opts.tagMode === 'all') {
      parts.push(`t.id IN (
        SELECT transaction_id FROM transaction_tags
        WHERE tenant_id = '${tenantId}' AND tag_id IN (${idList})
        GROUP BY transaction_id
        HAVING COUNT(DISTINCT tag_id) = ${opts.tagIds.length}
      )`);
    } else {
      parts.push(`t.id IN (
        SELECT transaction_id FROM transaction_tags
        WHERE tenant_id = '${tenantId}' AND tag_id IN (${idList})
      )`);
    }
  }

  if (opts.excludeTagIds && opts.excludeTagIds.length > 0) {
    const idList = opts.excludeTagIds.map((id) => `'${id}'`).join(',');
    parts.push(`t.id NOT IN (
      SELECT transaction_id FROM transaction_tags
      WHERE tenant_id = '${tenantId}' AND tag_id IN (${idList})
    )`);
  }

  if (opts.untaggedOnly) {
    parts.push(`t.id NOT IN (
      SELECT transaction_id FROM transaction_tags WHERE tenant_id = '${tenantId}'
    )`);
  }

  return parts.length > 0 ? ' AND ' + parts.join(' AND ') : '';
}
