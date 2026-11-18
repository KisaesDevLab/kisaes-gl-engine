// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// QuickBooks Online Journal parser: paycheck rows keep no employee name
// (Q-P31m, extended to QBO by the P31 review M7), as QuickBooks Desktop.

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseGl } from './quickbooks-online.js';

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Journal');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('QBO Journal paychecks (Q-P31m, P31 review M7)', () => {
  it('a Paycheck keeps no Name or Memo/Description; other types keep theirs', async () => {
    const buf = await xlsx([
      ['Test Co'], ['Journal'], ['January 2025'], [],
      [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
      [null, '01/15/2025', 'Paycheck', '1001', 'Synthetic Employee', 'Pay period 1/1-1/15 Synthetic Employee', 'Wages', 1500, null],
      [null, null, null, null, 'Synthetic Employee', 'Synthetic Employee net pay', 'Checking', null, 1500],
      [null, null, null, null, null, null, null, 1500, 1500],
      [],
      [null, '01/16/2025', 'payroll check', '1002', 'Other Synthetic', 'Other Synthetic', 'Wages', 10, null],
      [null, null, null, null, 'Other Synthetic', 'Other Synthetic', 'Checking', null, 10],
      [null, null, null, null, null, null, null, 10, 10],
      [],
      [null, '01/20/2025', 'Deposit', null, 'Synthetic Customer', 'Sale 1', 'Checking', 25, null],
      [null, null, null, null, null, 'Sale 1', 'Sales', null, 25],
      [null, null, null, null, null, null, null, 25, 25],
    ]);
    const { entries, errors } = await parseGl(buf);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(3);
    const [pay, check, deposit] = entries;
    for (const e of [pay!, check!]) {
      expect(e.name).toBeUndefined();
      expect(e.memo).toBeUndefined();
      expect(e.lines.every((l) => l.memo === undefined)).toBe(true);
      expect(JSON.stringify(e)).not.toContain('Synthetic');
    }
    expect(pay!.lines.map((l) => [l.debit, l.credit])).toEqual([['1500.00', '0'], ['0', '1500.00']]);
    expect(deposit!.name).toBe('Synthetic Customer');
    expect(deposit!.memo).toBe('Sale 1');
  });
});
