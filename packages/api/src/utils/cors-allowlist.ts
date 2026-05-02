// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Compile a comma-separated CORS allowlist string into an origin matcher.
 *
 * Each entry is either:
 * - a literal origin (e.g. `http://localhost:5173`) — matched by exact
 *   string equality after trailing-slash normalization
 * - a regex literal in `/pattern/flags` form (e.g.
 *   `/^https:\/\/.*\.firm\.com$/i`) — compiled once and tested with
 *   `regex.test(origin)`
 *
 * Entries are trimmed; empty entries are ignored. A bad regex throws at
 * boot so misconfiguration surfaces immediately rather than failing
 * obscurely on the first cross-origin request.
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
      // a valid JS RegExp flag set; if not, fall through to literal so
      // a stray '/path' doesn't get silently mis-parsed as a regex.
      const lastSlash = entry.lastIndexOf('/');
      if (lastSlash > 0) {
        const pattern = entry.slice(1, lastSlash);
        const flags = entry.slice(lastSlash + 1);
        if (/^[gimsuy]*$/.test(flags) && pattern.length > 0) {
          try {
            regexes.push(new RegExp(pattern, flags));
            continue;
          } catch (err) {
            throw new Error(
              `CORS_ORIGIN regex entry ${JSON.stringify(entry)} failed to compile: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    }

    literals.add(entry.replace(/\/$/, ''));
  }

  return {
    literals,
    regexes,
    matches: (origin: string) => {
      const normalized = origin.replace(/\/$/, '');
      if (literals.has(normalized)) return true;
      return regexes.some((r) => r.test(origin));
    },
  };
}
