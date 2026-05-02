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
 * failure, unanchored, or trivially permissive like `.*`) throws at
 * boot so misconfiguration surfaces immediately rather than failing
 * obscurely on the first cross-origin request.
 *
 * Both literal and regex matching operate on the same normalized form
 * (trailing slash stripped, lowercased) so behavior is symmetric — a
 * regex `/^https:\/\/MB\.kisaes\.local$/i` and a literal
 * `https://MB.kisaes.local` both match `Origin: https://mb.kisaes.local`.
 */
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
      // Match `/pattern/flags` — flags optional. Trailing flags must be
      // a syntactically plausible JS RegExp flag set (no validation
      // beyond shape — RegExp constructor catches semantic errors); if
      // the closing-slash structure doesn't parse, fall through to
      // literal so a stray '/path' doesn't get silently mis-parsed as
      // a regex.
      const lastSlash = entry.lastIndexOf('/');
      if (lastSlash > 0) {
        const pattern = entry.slice(1, lastSlash);
        const flags = entry.slice(lastSlash + 1);
        if (/^[gimsuyd]*$/.test(flags) && pattern.length > 0) {
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
          // refine() refuses for the literal "*". Sample two unrelated
          // hostile origins; if both pass, the pattern matches anything.
          if (compiled.test('https://attacker.example.com') && compiled.test('http://malicious.test:9999')) {
            throw new Error(
              `CORS_ORIGIN regex entry ${JSON.stringify(entry)} is trivially permissive ` +
                `(matches arbitrary origins). Tighten the pattern — e.g. ` +
                `/^https:\\/\\/[a-z0-9-]+\\.firm\\.com$/ — or use a literal origin instead.`,
            );
          }

          regexes.push(compiled);
          continue;
        }
      }
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
