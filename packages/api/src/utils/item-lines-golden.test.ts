// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The item-line golden cases shared with the ClientLedger client (process
// review S2). Source: ClientLedger repo `fixtures/item-lines/golden.json`
// (cl-model forms::item_lines), copied verbatim to
// packages/shared/fixtures/item-lines-golden.json — when the client's file
// changes, copy it again so both sides run the same set. Each case goes
// through the bill line validator (buildApLines) the routes use, and the
// quantity x unitPrice helper.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import DecimalLib from 'decimal.js';
import { lineAmountFromQuantity } from './line-amount.js';
import { AppError } from './errors.js';
import { buildApLines } from '../services/bill.service.js';

const Decimal = DecimalLib.default || DecimalLib;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/item-lines-golden.json'), 'utf8')) as {
  reasons: Record<string, string>;
  cases: Array<{ name: string; quantity?: string; unitPrice?: string; amount?: string; error?: string }>;
};

// The client's reason codes and the engine's 400 codes for them.
const ENGINE_CODE: Record<string, string> = {
  quantity_not_positive: 'VALIDATION_ERROR',
  quantity_out_of_range: 'VALIDATION_ERROR',
  quantity_too_precise: 'VALIDATION_ERROR',
  rate_negative: 'VALIDATION_ERROR',
  rate_too_precise: 'VALIDATION_ERROR',
  amount_out_of_range: 'VALIDATION_ERROR',
  quantity_required: 'LINE_QTY_RATE_INCOMPLETE',
};

const line = (c: (typeof golden.cases)[number], amount: string) => ({
  accountId: '00000000-0000-0000-0000-000000000001',
  amount,
  ...(c.quantity !== undefined ? { quantity: c.quantity } : {}),
  ...(c.unitPrice !== undefined ? { unitPrice: c.unitPrice } : {}),
});

describe('item-line golden cases (ClientLedger fixtures/item-lines/golden.json)', () => {
  it('maps every reason code', () => {
    for (const reason of Object.keys(golden.reasons)) expect(ENGINE_CODE[reason], reason).toBeDefined();
  });

  it.each(golden.cases)('$name', (c) => {
    if (c.error) {
      let err: unknown;
      try { buildApLines([line(c, c.amount ?? '1.00')], { allowBillable: true }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(ENGINE_CODE[c.error]);
      return;
    }
    if (c.quantity !== undefined && c.unitPrice !== undefined) {
      expect(lineAmountFromQuantity(c.quantity, c.unitPrice)).toBe(c.amount);
    }
    const built = buildApLines([line(c, c.amount!)], { allowBillable: true });
    expect(built.total.toFixed(2)).toBe(c.amount);
    // One cent off the expected amount is a mismatch when both are given.
    if (c.quantity !== undefined && c.unitPrice !== undefined) {
      const off = new Decimal(c.amount!).plus('0.01').toFixed(2);
      let err: unknown;
      try { buildApLines([line(c, off)], { allowBillable: true }); } catch (e) { err = e; }
      expect((err as AppError | undefined)?.code).toBe('LINE_AMOUNT_MISMATCH');
    }
  });

  it('a vendor credit line is never billable', () => {
    expect(() => buildApLines([{ accountId: 'a', amount: '1.00', contactId: 'c', isBillable: true }], { allowBillable: false }))
      .toThrow(/cannot be billable/);
  });
});
