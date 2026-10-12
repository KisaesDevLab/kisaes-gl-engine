// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The engine's only door to tax constants. Every read goes through a
// ParameterReader, which (a) converts JSON values to decimal strings, (b)
// records the keys the calculation actually touched and (c) emits one
// TE_PARAM_UNVERIFIED warning per non-verified parameter read (D12a: the
// engine uses the best seeded value and warns on the trace / assumptions page).

import type { FilingStatus, ParameterStatus } from '../types.js';
import type { TaxEstimatorWarning } from '../entities-api.js';
import type { TaxParameterRowDTO } from '../parameter-api.js';
import { filingStatusKey } from '../parameterKeys.js';
import { dec, type Dec } from '../decimal.js';
import type { ParameterMap, ParameterUse, ResolvedParameter } from './types.js';

/** One dated leg of a rate schedule, inclusive calendar dates. */
export interface RatePeriod {
  from: string;
  to: string;
  rate: Dec;
}

export interface BracketRow {
  /** Upper bound of the bracket (decimal string); null = no upper bound. */
  upper: Dec | null;
  rate: Dec;
}

export function parameterMapFromRows(rows: ReadonlyArray<Pick<TaxParameterRowDTO, 'key' | 'value' | 'status'> & Partial<Pick<TaxParameterRowDTO, 'source' | 'citation'>>>): ParameterMap {
  const out: Record<string, ResolvedParameter> = {};
  for (const r of rows) out[r.key] = { key: r.key, value: r.value, status: r.status, source: r.source, citation: r.citation };
  return out;
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const MONTH_DAY_RE = /^\d\d-\d\d$/;
const ISO_DATE_RE = /^\d\d\d\d-\d\d-\d\d$/;

export class ParameterReader {
  private readonly usedKeys = new Map<string, ParameterUse>();

  constructor(private readonly map: ParameterMap) {}

  private raw(key: string): ResolvedParameter {
    const p = this.map[key];
    if (!p) throw new Error(`TE_PARAM_MISSING: tax parameter '${key}' is not in the resolved parameter set`);
    if (!this.usedKeys.has(key)) this.usedKeys.set(key, { key, status: p.status, value: p.value });
    return p;
  }

  private invalid(key: string, expected: string): never {
    throw new Error(`TE_PARAM_INVALID: tax parameter '${key}' is not ${expected}`);
  }

  /** Money or rate — any finite JSON number, returned as a decimal string. */
  private number(key: string): Dec {
    const v = this.raw(key).value;
    if (!isFiniteNumber(v)) this.invalid(key, 'a number');
    return dec(v);
  }

  money(key: string): Dec { return this.number(key); }
  rate(key: string): Dec { return this.number(key); }

  int(key: string): number {
    const v = this.raw(key).value;
    if (!Number.isInteger(v)) this.invalid(key, 'an integer');
    return v as number;
  }

  private numberList(key: string): Dec[] {
    const v = this.raw(key).value;
    if (!Array.isArray(v) || !v.every(isFiniteNumber)) this.invalid(key, 'a list of numbers');
    return (v as number[]).map((n) => dec(n));
  }

  moneyList(key: string): Dec[] { return this.numberList(key); }
  rateList(key: string): Dec[] { return this.numberList(key); }

  intList(key: string): number[] {
    const v = this.raw(key).value;
    if (!Array.isArray(v) || !v.every((n) => Number.isInteger(n))) this.invalid(key, 'a list of integers');
    return v as number[];
  }

  /** 'YYYY-MM-DD' parameter (due dates, file-by dates). */
  date(key: string): string {
    const v = this.raw(key).value;
    if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) this.invalid(key, 'a YYYY-MM-DD date');
    return v as string;
  }

  /** 'YYYY-MM-DD'[] parameter (installment due dates, holidays). */
  dateList(key: string): string[] {
    const v = this.raw(key).value;
    if (!Array.isArray(v) || !v.every((d) => typeof d === 'string' && ISO_DATE_RE.test(d))) this.invalid(key, 'a list of YYYY-MM-DD dates');
    return v as string[];
  }

  /** 'MM-DD'[] parameter (sch_ai.period_ends). */
  monthDayList(key: string): string[] {
    const v = this.raw(key).value;
    if (!Array.isArray(v) || !v.every((d) => typeof d === 'string' && MONTH_DAY_RE.test(d))) this.invalid(key, 'a list of MM-DD values');
    return [...(v as string[])];
  }

  /** { from, to, rate }[] parameter (penalty.underpayment_rate), rates as decimal strings. */
  ratePeriods(key: string): RatePeriod[] {
    const v = this.raw(key).value;
    if (!Array.isArray(v) || v.length === 0) this.invalid(key, 'a list of { from, to, rate } periods');
    return (v as unknown[]).map((row) => {
      const r = row as { from?: unknown; to?: unknown; rate?: unknown } | null;
      if (!r || typeof r.from !== 'string' || !ISO_DATE_RE.test(r.from) || typeof r.to !== 'string' || !ISO_DATE_RE.test(r.to) || !isFiniteNumber(r.rate)) this.invalid(key, 'a list of { from, to, rate } periods');
      return { from: r.from as string, to: r.to as string, rate: dec(r.rate as number) };
    });
  }

  brackets(key: string): BracketRow[] {
    const v = this.raw(key).value;
    if (!Array.isArray(v) || v.length === 0) this.invalid(key, 'a bracket table');
    return (v as unknown[]).map((row) => {
      if (!Array.isArray(row) || !isFiniteNumber(row[1]) || !(row[0] === null || isFiniteNumber(row[0]))) this.invalid(key, 'a bracket table');
      return { upper: row[0] === null ? null : dec(row[0] as number), rate: dec(row[1] as number) };
    });
  }

  /** `${base}.${fs}` */
  moneyFs(base: string, fs: FilingStatus): Dec { return this.money(filingStatusKey(base, fs)); }
  rateFs(base: string, fs: FilingStatus): Dec { return this.rate(filingStatusKey(base, fs)); }
  moneyListFs(base: string, fs: FilingStatus): Dec[] { return this.moneyList(filingStatusKey(base, fs)); }
  bracketsFs(base: string, fs: FilingStatus): BracketRow[] { return this.brackets(filingStatusKey(base, fs)); }

  /**
   * Record parameter uses made by a NESTED calculation (a Schedule AI column priced
   * by the federal engine on its own context) so `used()` / `warnings()` cover
   * them too — each key once, the first status seen wins (R2-06).
   */
  noteUsed(uses: ReadonlyArray<ParameterUse>): void {
    for (const u of uses) if (!this.usedKeys.has(u.key)) this.usedKeys.set(u.key, { key: u.key, status: u.status, value: u.value });
  }

  /** Every parameter read so far, in first-read order. */
  used(): ParameterUse[] {
    return [...this.usedKeys.values()];
  }

  /** One warning per non-verified parameter read (D12a). */
  warnings(): TaxEstimatorWarning[] {
    const out: TaxEstimatorWarning[] = [];
    for (const u of this.usedKeys.values()) {
      if (u.status === 'verified') continue;
      out.push(unverifiedWarning(u.key, u.status, u.value));
    }
    return out;
  }
}

export function unverifiedWarning(key: string, status: ParameterStatus, value: unknown): TaxEstimatorWarning {
  return {
    code: 'TE_PARAM_UNVERIFIED',
    severity: 'warning',
    message: `Tax parameter '${key}' is ${status} (not CPA-verified); the estimate uses its current value ${JSON.stringify(value)}.`,
    details: { key, status, value },
  };
}
