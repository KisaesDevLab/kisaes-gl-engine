// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// ADR 0XX §4.1 — derive the set of header-level tags from a transaction's
// journal lines. The repo's transaction_tags junction supports multi-tag
// per transaction, so the "derived header" is a set of distinct non-null
// line tags rather than a single uniform-or-null value.

export interface LineWithTag {
  tagId?: string | null | undefined;
}

/**
 * Return the distinct, non-null tag IDs present across a transaction's
 * journal lines. Order is stable (first occurrence wins) so callers that
 * iterate the result reconstruct the same `transaction_tags` rows on
 * re-sync.
 */
export function deriveHeaderTags(lines: LineWithTag[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const line of lines) {
    const tag = line.tagId;
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      ordered.push(tag);
    }
  }
  return ordered;
}

/**
 * Return the single tag ID when every tagged line shares one tag, or null
 * when lines disagree, when every line is untagged, or when the input is
 * empty. Matches ADR 0XX §4.1's deriveHeaderTag semantics for systems
 * that store a single header tag column.
 */
export function uniformHeaderTag(lines: LineWithTag[]): string | null {
  const tags = deriveHeaderTags(lines);
  return tags.length === 1 ? tags[0]! : null;
}
