// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Reset process.env to a snapshot WITHOUT replacing the object.
//
// `process.env = { ...snapshot }` swaps Node's native env proxy for a plain
// object. From then on, in that worker, `process.env.TZ = ...` is just a
// property write: Node never sees it, so the zone never changes and every
// later test that sets TZ at the top of its file (line-amount.test.ts,
// ap-documents.routes.test.ts) silently runs in the runner's zone. The 4-way
// CI shard surfaced this: refresh-cookie.test.ts ran right before
// line-amount.test.ts. Mutating in place keeps the native object.
export function resetProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else if (process.env[key] !== value) process.env[key] = value;
  }
}
