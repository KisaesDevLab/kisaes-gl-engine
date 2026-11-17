// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// U-250: payroll money cells parse exactly or are refused, never 0.

import { describe, it, expect } from 'vitest';
import { parsePayrollMoney, readPayrollMoney, parseXlsxBuffer, applyColumnMapping, PAYROLL_AMOUNT_ERRORS_KEY } from './payroll-parse.service.js';

describe('parsePayrollMoney', () => {
  it.each([
    ['1234.56', '1234.56'],
    ['$1,234.56', '1234.56'],
    ['  $ 5,000.00  ', '5000.00'],
    ['(12.30)', '-12.30'],
    ['($1,000.00)', '-1000.00'],
    ['5.00-', '-5.00'],
    ['-7.5', '-7.50'],
    ['$-7.50', '-7.50'],
    ['1.50000', '1.50'],
    ['.25', '0.25'],
    ['12', '12.00'],
    ['', '0.00'],
    ['-', '0.00'],
    ['$-', '0.00'],
    ['0.00', '0.00'],
    ['-0.00', '0.00'],
  ])('%j -> %s', (input, expected) => {
    expect(parsePayrollMoney(input)).toEqual({ ok: true, value: expected });
  });

  it.each(['1.005', '0.001', '(3.333)'])('%j has more than 2 places', (input) => {
    expect(parsePayrollMoney(input)).toEqual({ ok: false, code: 'AMOUNT_PRECISION' });
  });

  it.each(['abc', '12abc', '1.2.3', 'Infinity', 'NaN', '1e400', '(-5)', '--5', '99999999999999'])('%j is not a number', (input) => {
    expect(parsePayrollMoney(input)).toEqual({ ok: false, code: 'AMOUNT_INVALID' });
  });

  it('numbers: float noise from a spreadsheet formula is removed, real extra places are not', () => {
    expect(parsePayrollMoney(0.1 + 0.2)).toEqual({ ok: true, value: '0.30' });
    expect(parsePayrollMoney(1234.5)).toEqual({ ok: true, value: '1234.50' });
    expect(parsePayrollMoney(1.005)).toEqual({ ok: false, code: 'AMOUNT_PRECISION' });
    expect(parsePayrollMoney(Number.NaN)).toEqual({ ok: false, code: 'AMOUNT_INVALID' });
    expect(parsePayrollMoney(null)).toEqual({ ok: true, value: '0.00' });
  });

  it('reads stored values exactly, including float-era JSON numbers', () => {
    expect(readPayrollMoney('1234.50').toFixed(2)).toBe('1234.50');
    expect(readPayrollMoney(1234.5).toFixed(2)).toBe('1234.50');
    expect(readPayrollMoney(undefined).isZero()).toBe(true);
    expect(readPayrollMoney(null).isZero()).toBe(true);
  });

  it('xlsx numeric and formula cells arrive as their exact cents', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Payroll');
    ws.addRow(['Name', 'Gross', 'Net']);
    ws.addRow(['A', 0.1 + 0.2, { formula: 'B2*1', result: 0.1 + 0.7 } as any]);
    ws.addRow(['B', 1.005, 100]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const rows = await parseXlsxBuffer(buffer);
    expect(rows[1]).toEqual(['A', '0.3', '0.8']);
    const { mappedRows } = applyColumnMapping(rows, rows[0]!, {
      header_row: 0, data_start_row: 1,
      mappings: { employee_name: { source: 'Name' }, gross_pay: { source: 'Gross' }, net_pay: { source: 'Net' } },
    });
    expect(mappedRows[0]).toMatchObject({ gross_pay: '0.30', net_pay: '0.80' });
    expect(mappedRows[1]![PAYROLL_AMOUNT_ERRORS_KEY]).toEqual([{ field: 'gross_pay', code: 'AMOUNT_PRECISION' }]);
    expect(mappedRows[1]!['gross_pay']).toBeNull();
    expect(mappedRows[1]!['net_pay']).toBe('100.00');
  });
});
