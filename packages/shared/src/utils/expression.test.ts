// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { evaluateExpression, isPlainNumberText, EXPRESSION_MAX_LENGTH } from './expression.js';

function money(input: string): string {
  const r = evaluateExpression(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.error}`);
  return r.format(2);
}
function err(input: string): string {
  const r = evaluateExpression(input);
  if (r.ok) throw new Error(`expected error for ${input}, got ${r.format()}`);
  return r.error;
}

describe('evaluateExpression — arithmetic', () => {
  it('evaluates the JE example', () => {
    expect(money('145.15-50')).toBe('95.15');
  });
  it('honours precedence and parentheses', () => {
    expect(money('2+3*4')).toBe('14.00');
    expect(money('(2+3)*4')).toBe('20.00');
    expect(money('10-2-3')).toBe('5.00');
    expect(money('100/4/5')).toBe('5.00');
    expect(money('((1+2)*(3+4))')).toBe('21.00');
  });
  it('accepts alternative operator glyphs', () => {
    expect(money('6×7')).toBe('42.00');
    expect(money('6x7')).toBe('42.00');
    expect(money('6X7')).toBe('42.00');
    expect(money('84÷2')).toBe('42.00');
    expect(money('50−8')).toBe('42.00');
  });
  it('handles unary minus / plus', () => {
    expect(money('-5')).toBe('-5.00');
    expect(money('-(2+3)')).toBe('-5.00');
    expect(money('3*-2')).toBe('-6.00');
    expect(money('--4')).toBe('4.00');
    expect(money('+4')).toBe('4.00');
  });
  it('treats % as a postfix /100', () => {
    expect(money('200*15%')).toBe('30.00');
    expect(money('15%')).toBe('0.15');
    expect(money('1000*7.25%')).toBe('72.50');
  });
  it('accepts $, thousands separators, whitespace and a leading =', () => {
    expect(money('$1,234.50 + 0.50')).toBe('1235.00');
    expect(money('= 1,000,000 / 4')).toBe('250000.00');
    expect(money('  $12  ')).toBe('12.00');
    expect(money('-$5')).toBe('-5.00');
    expect(money('.5+.25')).toBe('0.75');
    expect(money('5.')).toBe('5.00');
  });
});

describe('evaluateExpression — precision', () => {
  it('is exact for classic float traps', () => {
    expect(money('0.1+0.2')).toBe('0.30');
    expect(evaluateExpression('0.1+0.2').ok && (evaluateExpression('0.1+0.2') as { format: (d?: number) => string }).format()).toBe('0.3');
    expect(money('1.005*1')).toBe('1.01'); // float would give 1.00
    expect(money('19.99*3')).toBe('59.97');
  });
  it('rounds half away from zero at the end only', () => {
    expect(money('100/3')).toBe('33.33');
    expect(money('200/3')).toBe('66.67');
    expect(money('0.125+0')).toBe('0.13');
    expect(money('-0.125')).toBe('-0.13');
    expect(money('1/3*3')).toBe('1.00');
  });
  it('formats without fixed decimals as the shortest exact decimal', () => {
    const r = evaluateExpression('2.50*2');
    expect(r.ok && r.format()).toBe('5');
    const r2 = evaluateExpression('1/8');
    expect(r2.ok && r2.format()).toBe('0.125');
    const r3 = evaluateExpression('1/3');
    expect(r3.ok && r3.format()).toBe('0.3333333333');
    const r4 = evaluateExpression('7.5*4');
    expect(r4.ok && r4.isInteger).toBe(true);
  });
  it('supports other decimal counts', () => {
    const r = evaluateExpression('1/3');
    expect(r.ok && r.format(4)).toBe('0.3333');
    expect(r.ok && r.format(0)).toBe('0');
    const r2 = evaluateExpression('2.5');
    expect(r2.ok && r2.format(0)).toBe('3');
  });
});

describe('evaluateExpression — errors', () => {
  it('rejects division by zero', () => {
    expect(err('5/0')).toMatch(/divide by zero/i);
    expect(err('5/(2-2)')).toMatch(/divide by zero/i);
  });
  it('rejects garbage and incomplete input', () => {
    for (const s of ['', 'abc', '5+', '*5', '(5', '5)', '1.2.3', '1,23', ',5', '5 5', '$', '$+5', '2^3', 'alert(1)', '1e5', '=']) {
      expect(() => err(s), s).not.toThrow();
    }
  });
  it('bounds very long input', () => {
    expect(err('1+'.repeat(EXPRESSION_MAX_LENGTH) + '1')).toMatch(/too long/i);
    expect(err('('.repeat(60) + '1' + ')'.repeat(60))).toMatch(/nested/i);
    expect(err('-'.repeat(60) + '1')).toMatch(/nested/i);
  });
  it('rejects results too large to hold', () => {
    expect(err('999999999*999999999')).toMatch(/too large/i);
  });
});

describe('isPlainNumberText', () => {
  it('recognises what a number input would hold', () => {
    for (const s of ['', '-', '12', '-12.5', '.5', '5.']) expect(isPlainNumberText(s), s).toBe(true);
    for (const s of ['1+2', '$5', '1,000', '5%', '(1)']) expect(isPlainNumberText(s), s).toBe(false);
  });
});
