// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Allowlist-style cleanup for firm-authored accountant's-report HTML. Firm
// letters are less trusted than super-admin letters, and the same HTML is
// shown in the browser preview. Renders are ALSO sandboxed (PDF: JS off +
// network blocked; preview iframe: no scripts), so this is defence in depth.

const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template|svg|math|textarea|select|button|form)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_TAGS = /<\/?(script|style|iframe|object|embed|noscript|template|svg|math|link|meta|base|form|input|textarea|select|option|button|frame|frameset|applet)\b[^>]*>/gi;
const EVENT_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const SRCDOC_ATTR = /\s+(srcdoc|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const URL_ATTR = /\s+(href|src|action|background|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export function sanitizeFsLetterHtml(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(DROP_WITH_CONTENT, '');
  out = out.replace(DROP_TAGS, '');
  out = out.replace(EVENT_ATTR, '');
  out = out.replace(SRCDOC_ATTR, '');
  out = out.replace(URL_ATTR, (_m, attr: string, _q, dq?: string, sq?: string, bare?: string) => {
    const value = (dq ?? sq ?? bare ?? '').trim();
    const lower = value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
    const isImg = attr.toLowerCase() === 'src';
    const ok = isImg
      ? /^data:image\/(png|jpe?g|gif|webp);base64,/.test(lower)
      : /^(https?:|mailto:|#)/.test(lower);
    return ok ? ` ${attr}="${value.replace(/"/g, '&quot;')}"` : '';
  });
  // CSS expressions / url() in inline styles.
  out = out.replace(/\s+style\s*=\s*("([^"]*)"|'([^']*)')/gi, (_m, _q, dq?: string, sq?: string) => {
    const v = (dq ?? sq ?? '');
    if (/expression\s*\(|url\s*\(|javascript:|@import/i.test(v)) return '';
    return ` style="${v.replace(/"/g, '&quot;')}"`;
  });
  return out;
}
