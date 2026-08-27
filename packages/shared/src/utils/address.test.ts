// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { addressRows, addressText } from './address.js';

describe('addressRows', () => {
  it('puts City, ST ZIP on its own row', () => {
    expect(addressRows({
      line1: '500 Warehouse Rd', city: 'Springfield', state: 'IL', zip: '62704',
    })).toEqual(['500 Warehouse Rd', 'Springfield, IL 62704']);
  });

  it('keeps a second street line between the street and the city row', () => {
    expect(addressRows({
      line1: '500 Warehouse Rd', line2: 'Suite 200',
      city: 'Springfield', state: 'IL', zip: '62704',
    })).toEqual(['500 Warehouse Rd', 'Suite 200', 'Springfield, IL 62704']);
  });

  it('drops empty and whitespace-only parts instead of leaving blank rows', () => {
    expect(addressRows({
      line1: '  500 Warehouse Rd  ', line2: '   ', city: null, state: null, zip: null,
    })).toEqual(['500 Warehouse Rd']);
  });

  it('handles a city with no state or zip', () => {
    expect(addressRows({ line1: 'PO Box 12', city: 'Springfield' }))
      .toEqual(['PO Box 12', 'Springfield']);
  });

  it('handles a zip with no city or state', () => {
    expect(addressRows({ line1: 'PO Box 12', zip: '62704' }))
      .toEqual(['PO Box 12', '62704']);
  });

  it('returns nothing for a contact with no address on file', () => {
    expect(addressRows({})).toEqual([]);
    expect(addressRows(null)).toEqual([]);
    expect(addressRows(undefined)).toEqual([]);
  });
});

describe('addressText', () => {
  it('joins the rows with newlines — the format payee_address stores', () => {
    expect(addressText({
      line1: '500 Warehouse Rd', city: 'Springfield', state: 'IL', zip: '62704',
    })).toBe('500 Warehouse Rd\nSpringfield, IL 62704');
  });

  it('is empty when there is nothing to print', () => {
    expect(addressText(null)).toBe('');
  });
});
