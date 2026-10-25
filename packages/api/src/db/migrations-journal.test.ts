// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The drizzle migration journal stays in order. The migrator applies a
// journal entry only when its `when` is newer than the last applied one, so
// an entry merged with an older `when` than its predecessor (two branches
// that each took the next number, merged in the other order) would be
// skipped silently on every install that already ran the later one. This
// test makes such a merge-order mistake fail loudly instead.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface JournalEntry { idx: number; when: number; tag: string }

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };

describe('migration journal', () => {
  it('idx and when both increase strictly, entry after entry', () => {
    const out: string[] = [];
    for (let i = 1; i < journal.entries.length; i++) {
      const a = journal.entries[i - 1]!;
      const b = journal.entries[i]!;
      if (b.idx <= a.idx) out.push(`${b.tag}: idx ${b.idx} is not after ${a.tag} (idx ${a.idx})`);
      if (b.when <= a.when) out.push(`${b.tag}: when ${b.when} is not after ${a.tag} (when ${a.when})`);
    }
    expect(out).toEqual([]);
  });

  it('every tag is numbered by its idx and has its .sql file', () => {
    const out: string[] = [];
    for (const e of journal.entries) {
      if (Number.parseInt(e.tag.slice(0, 4), 10) !== e.idx) out.push(`${e.tag}: prefix does not match idx ${e.idx}`);
      if (!fs.existsSync(path.join(migrationsDir, `${e.tag}.sql`))) out.push(`${e.tag}: no ${e.tag}.sql`);
    }
    expect(out).toEqual([]);
  });
});
