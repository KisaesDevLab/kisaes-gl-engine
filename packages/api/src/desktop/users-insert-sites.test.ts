// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Desktop invariant guard (R19): every user row must be homed in the
// workspace tenant. This scan pins every place that inserts into `users`,
// so a new user-creation path fails here until it is reviewed for desktop
// mode (homed in the workspace, or unreachable/refused on desktop) and
// added below.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** File (relative to src, forward slashes) -> number of users inserts, with the desktop treatment. */
const KNOWN_SITES: Record<string, { count: number; desktop: string }> = {
  'desktop/workspace.ts': { count: 1, desktop: 'initialize: the owner, homed in the workspace' },
  'routes/admin.routes.ts': { count: 1, desktop: 'admin users/create: homed in the workspace' },
  'services/auth.service.ts': { count: 2, desktop: 'register: 404 on desktop; inviteUser: homed in the workspace' },
  'services/setup.service.ts': { count: 2, desktop: 'createAdminUser / adoptRestoredTenants: throw on desktop' },
};

const INSERT_USERS = /\binsert\s*\(\s*users\s*\)|\binsert\s+into\s+"?(?:public"?\."?)?users"?[\s(]/gi;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'migrations') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('users insert sites (R19)', () => {
  it('finds exactly the known sites', () => {
    const found: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const n = (readFileSync(file, 'utf8').match(INSERT_USERS) ?? []).length;
      if (n > 0) found[path.relative(SRC, file).split(path.sep).join('/')] = n;
    }
    const expected = Object.fromEntries(Object.entries(KNOWN_SITES).map(([f, v]) => [f, v.count]));
    expect(found).toEqual(expected);
  });

  it('the pattern catches both the query builder and raw SQL', () => {
    const sample = 'await tx.insert(users).values({}); sql`INSERT INTO users (id) VALUES (1)`; insert into "public"."users"(x)';
    expect(sample.match(INSERT_USERS)).toHaveLength(3);
    expect('insert(usersFoo)'.match(INSERT_USERS)).toBeNull();
  });
});
