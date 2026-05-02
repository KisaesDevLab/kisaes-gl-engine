// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Compile a comma-separated CORS allowlist string into an origin matcher.
 *
 * Each entry is either:
 * - a literal origin (e.g. `http://localhost:5173`) — matched by exact
 *   string equality after trailing-slash and case normalization
 * - a regex literal in `/pattern/flags` form (e.g.
 *   `/^https:\/\/.*\.firm\.com$/i`) — compiled once and tested with
 *   `regex.test(normalizedOrigin)`. Regexes MUST be anchored — start
 *   with `^` and end with `$` (or `\z`) — to prevent unanchored
 *   patterns from accidentally admitting attacker origins like
 *   `https://acme.firm.com.attacker.example`.
 *
 * Entries are trimmed; empty entries are ignored. Bad regex (compile
 * failure, unanchored, comma-bearing quantifier that got split, or
 * trivially permissive like `.*`) throws at boot so misconfiguration
 * surfaces immediately rather than failing obscurely on the first
 * cross-origin request.
 *
 * Both literal and regex matching operate on the same normalized form
 * (trailing slash stripped, lowercased) so behavior is symmetric — a
 * regex `/^https:\/\/MB\.kisaes\.local$/i` and a literal
 * `https://MB.kisaes.local` both match `Origin: https://mb.kisaes.local`.
 *
 * Known limitation: this function splits the input on `,`, so a regex
 * with a `{m,n}` quantifier (e.g. `/^.{0,99}$/`) gets split mid-pattern
 * and BOTH halves fail the `/pattern/flags` shape check. We detect
 * that case and throw with an actionable message rather than silently
 * falling through to literal mode and rejecting all CORS traffic.
 */

/**
 * Probes used by the trivially-permissive guard. A regex that matches
 * two or more of these unrelated origins is too broad to be a useful
 * allowlist entry. Covers both http and https schemes and varied host
 * shapes so single-scheme wildcards (`^https:\/\/.+$`) can't slip past
 * by failing on a different-scheme probe.
 */
const TRIVIAL_PROBES = [
  'https://probe-1.example.com',
  'https://probe-2.different.test',
  'http://probe-3.example.org:8080',
  'http://probe-4.different.test',
  'https://attacker.example',
] as const;

export function buildOriginAllowlist(corsOriginRaw: string): {
  matches: (origin: string) => boolean;
  literals: ReadonlySet<string>;
  regexes: readonly RegExp[];
} {
  const literals = new Set<string>();
  const regexes: RegExp[] = [];

  for (const raw of corsOriginRaw.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;

    if (entry.startsWith('/') && entry.length >= 2) {
      // Try to parse as `/pattern/flags`. Find the LAST `/` to support
      // patterns containing escaped slashes (`/^https:\/\/x$/`).
      const lastSlash = entry.lastIndexOf('/');
      const looksLikeRegex = lastSlash > 0;
      const pattern = looksLikeRegex ? entry.slice(1, lastSlash) : '';
      const flags = looksLikeRegex ? entry.slice(lastSlash + 1) : '';
      const validShape = looksLikeRegex && /^[gimsuyd]*$/.test(flags) && pattern.length > 0;

      if (!validShape) {
        // Entry starts with `/` but isn't a valid `/pattern/flags`
        // literal. The most common cause is a `{m,n}` quantifier that
        // got split on its inner comma — split on outer commas can't
        // tell `{0,99}` apart from a list separator without a real
        // regex parser. Throw with an actionable message.
        throw new Error(
          `CORS_ORIGIN entry ${JSON.stringify(entry)} starts with "/" ` +
            `but is not a valid regex literal. If your regex contained ` +
            `a {m,n} quantifier (e.g. /^.{0,99}$/), the comma split ` +
            `the pattern in half — rewrite without the comma quantifier ` +
            `(e.g. /^.{0}.{0,99}$/ → /^.{0,99}$/, or use a character ` +
            `class repetition). If you meant a literal path origin, ` +
            `use a scheme like http://localhost:5173 instead.`,
        );
      }

      // Anchor enforcement: refuse unanchored regexes. Without
      // ^...$, `^https:\/\/.*\.firm\.com` matches
      // `https://acme.firm.com.attacker.example` — full bypass.
      // Operators who want unanchored matching can write
      // `^.*<pattern>.*$` explicitly so the intent is visible.
      if (!pattern.startsWith('^') || !(pattern.endsWith('$') || pattern.endsWith('\\z'))) {
        throw new Error(
          `CORS_ORIGIN regex entry ${JSON.stringify(entry)} must be anchored: ` +
            `pattern must start with "^" and end with "$" (got pattern: ${JSON.stringify(pattern)}). ` +
            `Unanchored regexes are rejected because they trivially match attacker-controlled origins.`,
        );
      }

      let compiled: RegExp;
      try {
        compiled = new RegExp(pattern, flags);
      } catch (err) {
        throw new Error(
          `CORS_ORIGIN regex entry ${JSON.stringify(entry)} failed to compile: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Reject trivially-permissive patterns. With credentials:true
      // CORS, a wildcard regex is exactly the wide-open the env.ts
      // refine() refuses for the literal "*". Sample 5 unrelated
      // origins covering both schemes; a regex that matches 2+ of
      // them admits "too much" — even single-scheme wildcards
      // (`^https:\/\/.+$`) trip on probe-1 + probe-2 + attacker.
      const matchCount = TRIVIAL_PROBES.filter((o) => compiled.test(normalizeOrigin(o))).length;
      if (matchCount >= 2) {
        throw new Error(
          `CORS_ORIGIN regex entry ${JSON.stringify(entry)} is trivially permissive ` +
            `(matched ${matchCount}/${TRIVIAL_PROBES.length} unrelated probe origins). ` +
            `Tighten the pattern — e.g. /^https:\\/\\/[a-z0-9-]+\\.firm\\.com$/ — ` +
            `or use a literal origin instead.`,
        );
      }

      regexes.push(compiled);
      continue;
    }

    literals.add(normalizeOrigin(entry));
  }

  return {
    literals,
    regexes,
    matches: (origin: string) => {
      const normalized = normalizeOrigin(origin);
      if (literals.has(normalized)) return true;
      // Regex authors retain control over case-sensitivity via the `i`
      // flag, but they get the trailing-slash-stripped + lowercased
      // origin so they don't need to handle that themselves.
      return regexes.some((r) => r.test(normalized));
    },
  };
}

/**
 * Normalize an Origin header value for comparison: strip a trailing
 * slash and lowercase the scheme + host. Origins are case-insensitive
 * for scheme/host per RFC 6454; mixed-case Origins from broken
 * middleboxes are common enough that case-insensitive comparison is
 * the safer default.
 */
function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '').toLowerCase();
}
