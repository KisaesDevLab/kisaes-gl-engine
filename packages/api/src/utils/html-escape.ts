// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Escape a value for interpolation into HTML text or attribute content
 * (emails, server-rendered snippets). Non-strings are stringified;
 * null/undefined become ''. Use this everywhere user- or tenant-supplied
 * text (names, free-text messages, institution names) meets an HTML
 * template — outbound mail is firm-branded, so unescaped input lets one
 * party inject markup/links into mail the firm's clients trust.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip CR/LF so a user-supplied fragment can't inject mail headers via Subject. */
export function safeSubjectSegment(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]/g, ' ');
}
