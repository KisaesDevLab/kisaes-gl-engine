// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { csvEnumSet, csvUuidSet, sortBySchema, sortDirSchema } from './list-view.js';

describe('list-view schemas', () => {
  it('parses a comma-joined enum set and refuses an unknown value', () => {
    const s = z.object({ status: csvEnumSet(['paid', 'unpaid']) });
    expect(s.parse({ status: 'paid, unpaid' }).status).toEqual(['paid', 'unpaid']);
    expect(s.parse({ status: ['paid'] }).status).toEqual(['paid']);
    expect(s.parse({}).status).toBeUndefined();
    expect(() => s.parse({ status: 'paid,bogus' })).toThrow();
    expect(() => s.parse({ status: '' })).toThrow();
  });

  it('parses a comma-joined uuid set', () => {
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    expect(csvUuidSet.parse(`${a},${b}`)).toEqual([a, b]);
    expect(() => csvUuidSet.parse('not-a-uuid')).toThrow();
  });

  it('whitelists sort keys and directions', () => {
    const s = z.object({ sortBy: sortBySchema(['name', 'date']), sortDir: sortDirSchema.optional() });
    expect(s.parse({ sortBy: 'name', sortDir: 'asc' })).toEqual({ sortBy: 'name', sortDir: 'asc' });
    expect(() => s.parse({ sortBy: 'bogus' })).toThrow();
    expect(() => s.parse({ sortDir: 'up' })).toThrow();
  });
});
