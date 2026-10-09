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
import { bootstrapBuiltins, update, resetBuiltin } from './coa-templates.service.js';

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

describe('editing a built-in template (migration 0199)', () => {
  const def = () => (BUSINESS_TEMPLATES as Record<string, Array<{ accountNumber: string | null; name: string; isSystem: boolean; systemTag: string | null }>>)[SLUG]!;

  afterEach(async () => {
    await resetBuiltin(SLUG);
  });

  it('saves edits, marks the template customized, survives the startup re-sync, and resets to default', async () => {
    await bootstrapBuiltins();
    const edited = def().map((a) => ({ ...a }));
    const firstNonSystem = edited.findIndex((a) => !a.isSystem);
    edited[firstNonSystem]!.name = 'Renamed By Super Admin';
    edited.push({ accountNumber: '69999', name: 'Brand New Account', accountType: 'expense', detailType: 'other_expense', isSystem: false, systemTag: null } as never);

    const saved = await update(SLUG, { accounts: edited as never });
    expect(saved.accountsCustomized).toBe(true);
    expect(saved.accounts.some((a) => a.name === 'Brand New Account')).toBe(true);

    await bootstrapBuiltins(); // must not overwrite the customized built-in
    const kept = await db.query.coaTemplatesTable.findFirst({ where: eq(coaTemplatesTable.slug, SLUG) });
    expect((kept!.accounts as Array<{ name: string }>).some((a) => a.name === 'Brand New Account')).toBe(true);
    expect(kept!.accountsCustomized).toBe(true);

    const reset = await resetBuiltin(SLUG);
    expect(reset.accountsCustomized).toBe(false);
    expect(reset.accounts).toEqual(def());
  });

  it('saving the shipped default again clears the customized flag', async () => {
    await bootstrapBuiltins();
    const saved = await update(SLUG, { accounts: def().map((a) => ({ ...a })) as never });
    expect(saved.accountsCustomized).toBe(false);
  });

  it('refuses an edit that drops a required system account', async () => {
    await bootstrapBuiltins();
    const withoutSystem = def().filter((a) => !a.isSystem || a.systemTag !== 'accounts_payable');
    await expect(update(SLUG, { accounts: withoutSystem as never })).rejects.toThrow(/system accounts are required/);
  });
});
