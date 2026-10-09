// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report pack download filename. Shared so the builder's live preview and
// the server's Content-Disposition render the same name.

export const PACK_FILENAME_DEFAULT = '{pack}-{date}';

export const PACK_FILENAME_PLACEHOLDERS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '{tenant}', label: 'Client (tenant) name' },
  { token: '{company}', label: 'Company name' },
  { token: '{pack}', label: 'Pack name' },
  { token: '{start}', label: 'Period start (YYYY-MM-DD)' },
  { token: '{end}', label: 'Period end / as-of date' },
  { token: '{range}', label: 'Period start_to_end (or the as-of date)' },
  { token: '{date}', label: 'Period end / as-of date (same as {end})' },
];

export interface PackFilenameVars {
  pack: string;
  tenant?: string | null;
  company?: string | null;
  rangeStart?: string | null;
  rangeEnd?: string | null;
  asOfDate?: string | null;
}

/** Characters kept in a filename part; anything else becomes "_". */
function clean(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[_.-]+|[_.-]+$/g, '');
}

/**
 * Render `{tenant}-{range}`-style templates into a safe `.pdf` filename.
 * Unknown `{tokens}` are dropped; an empty result falls back to the pack name.
 */
export function renderPackFilename(template: string | null | undefined, v: PackFilenameVars): string {
  const end = v.rangeEnd ?? v.asOfDate ?? '';
  const start = v.rangeStart ?? '';
  const range = start && end && start !== end ? `${start}_to_${end}` : end || start;
  const values: Record<string, string> = {
    pack: v.pack,
    tenant: v.tenant ?? '',
    company: v.company ?? '',
    start,
    end,
    range,
    date: end,
  };
  const rendered = (template?.trim() || PACK_FILENAME_DEFAULT)
    .replace(/\{([a-z]+)\}/gi, (_m, key: string) => clean(values[key.toLowerCase()] ?? ''));
  const name = clean(rendered) || clean(v.pack) || 'report-pack';
  return `${name.slice(0, 200)}.pdf`;
}
