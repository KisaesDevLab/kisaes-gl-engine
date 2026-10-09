// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { renderPackFilename } from './pack-filename.js';

const v = { pack: 'Month End', tenant: 'TimberStone LLC', company: 'TimberStone', rangeStart: '2026-09-01', rangeEnd: '2026-09-30' };

describe('renderPackFilename', () => {
  it('renders tenant and date range', () => {
    expect(renderPackFilename('{tenant} - {pack} - {range}', v)).toBe('TimberStone_LLC_-_Month_End_-_2026-09-01_to_2026-09-30.pdf');
    expect(renderPackFilename('{tenant}_{start}_{end}', v)).toBe('TimberStone_LLC_2026-09-01_2026-09-30.pdf');
  });
  it('keeps the old default ({pack}-{date})', () => {
    expect(renderPackFilename(null, v)).toBe('Month_End-2026-09-30.pdf');
  });
  it('uses the as-of date for point-in-time packs and drops unknown tokens', () => {
    expect(renderPackFilename('{tenant}-{range}{nope}', { pack: 'BS', tenant: 'Acme & Sons', asOfDate: '2026-12-31' }))
      .toBe('Acme_Sons-2026-12-31.pdf');
  });
  it('never returns an empty or unsafe name', () => {
    expect(renderPackFilename('{tenant}', { pack: 'P/Q', tenant: '' })).toBe('P_Q.pdf');
    expect(renderPackFilename('../../etc/{pack}', { pack: 'x' })).toBe('etc_x.pdf');
  });
});
