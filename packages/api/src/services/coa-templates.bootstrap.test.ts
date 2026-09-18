// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// bootstrapBuiltins() re-syncs built-in template accounts from the static
// BUSINESS_TEMPLATES constant at startup, but leaves admin-owned fields
// (label, is_hidden) alone and is a no-op when nothing changed.

import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { BUSINESS_TEMPLATES } from '@kis-books/shared';
import { db } from '../db/index.js';
import { coaTemplatesTable } from '../db/schema/index.js';
import { bootstrapBuiltins } from './coa-templates.service.js';

const SLUG = 'farm_crops_and_animals';
let restore: { label: string; isHidden: boolean } | null = null;

afterEach(async () => {
  if (restore) {
    await db.update(coaTemplatesTable).set(restore).where(eq(coaTemplatesTable.slug, SLUG));
    restore = null;
  }
});

describe('bootstrapBuiltins', () => {
  it('re-syncs stale built-in accounts and keeps label + hidden flag', async () => {
    await bootstrapBuiltins();
    const before = await db.query.coaTemplatesTable.findFirst({ where: eq(coaTemplatesTable.slug, SLUG) });
    expect(before).toBeDefined();
    restore = { label: before!.label, isHidden: before!.isHidden };

    await db.update(coaTemplatesTable)
      .set({ accounts: [], label: 'Admin Relabel', isHidden: true })
      .where(eq(coaTemplatesTable.slug, SLUG));

    const result = await bootstrapBuiltins();
    expect(result.synced).toBeGreaterThanOrEqual(1);

    const after = await db.query.coaTemplatesTable.findFirst({ where: eq(coaTemplatesTable.slug, SLUG) });
    expect(after!.accounts).toEqual(BUSINESS_TEMPLATES[SLUG]);
    expect(after!.label).toBe('Admin Relabel');
    expect(after!.isHidden).toBe(true);
  });

  it('is a no-op when built-ins already match the constant', async () => {
    await bootstrapBuiltins();
    const again = await bootstrapBuiltins();
    expect(again).toEqual({ inserted: 0, synced: 0 });
  });
});
