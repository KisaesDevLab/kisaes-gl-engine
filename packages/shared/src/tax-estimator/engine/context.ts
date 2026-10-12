// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Per-calculation context shared by the engine steps: the parameter reader,
// the trace (rounded amount + exact value per row), the warning sink and the
// person directory. Pure; one instance per computeFederal() call.

import type { FilingStatus } from '../types.js';
import type { TaxEstimatorWarning } from '../entities-api.js';
import type { PersonRole } from '../taxpayers-api.js';
import { dRoundDollars } from '../decimal.js';
import { ParameterReader } from './parameters.js';
import type { EngineTraceRow, ParameterMap } from './types.js';

export type TraceInput = Omit<EngineTraceRow, 'amount'>;

export class TraceBuilder {
  private readonly items: EngineTraceRow[] = [];

  add(row: TraceInput): EngineTraceRow {
    const full: EngineTraceRow = { ...row, amount: dRoundDollars(row.exact) };
    this.items.push(full);
    return full;
  }

  rows(): EngineTraceRow[] {
    return [...this.items];
  }
}

interface PersonRef { personId: string; role: PersonRole }

export class EngineContext {
  readonly params: ParameterReader;
  readonly trace = new TraceBuilder();
  private readonly warningsList: TaxEstimatorWarning[] = [];
  private readonly seen = new Set<string>();
  private persons: PersonRef[] = [];

  constructor(parameters: ParameterMap, readonly taxYear: number, readonly filingStatus: FilingStatus) {
    this.params = new ParameterReader(parameters);
  }

  setPersons(persons: ReadonlyArray<PersonRef>): void {
    this.persons = [...persons];
  }

  /** The id when known, else the primary person (with a TE_UNKNOWN_PERSON warning for a non-null unknown id). */
  resolvePerson(personId: string | null | undefined): string {
    if (personId && this.persons.some((p) => p.personId === personId)) return personId;
    const primary = this.persons.find((p) => p.role === 'primary') ?? this.persons[0];
    if (!primary) throw new Error('TE_NO_PERSONS: the taxpayer has no persons');
    if (personId) this.warn('TE_UNKNOWN_PERSON', `Person '${personId}' is not on this taxpayer; the amount was attributed to the primary person.`, { personId });
    return primary.personId;
  }

  warn(code: string, message: string, details?: Record<string, unknown>, severity: 'warning' | 'info' = 'warning'): void {
    const key = `${code}|${JSON.stringify(details ?? null)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.warningsList.push(details ? { code, severity, message, details } : { code, severity, message });
  }

  info(code: string, message: string, details?: Record<string, unknown>): void {
    this.warn(code, message, details, 'info');
  }

  /** Step warnings in order, then the D12a parameter warnings. */
  allWarnings(): TaxEstimatorWarning[] {
    return [...this.warningsList, ...this.params.warnings()];
  }
}

const DOB_RE = /^(\d+)-(\d+)-(\d+)$/;

/**
 * Age attained by Dec 31 of `taxYear`. With `janFirstRule` (IRC §63(f) / Pub. 501:
 * a person is 65 on the day before the 65th birthday) a Jan 1 birthday counts in
 * the prior year. Returns null when the date is missing or malformed.
 */
export function ageAtYearEnd(dateOfBirth: string | null | undefined, taxYear: number, janFirstRule: boolean): number | null {
  if (!dateOfBirth) return null;
  const m = DOB_RE.exec(dateOfBirth.trim());
  if (!m) return null;
  let birthYear = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(birthYear) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (janFirstRule && month === 1 && day === 1) birthYear -= 1;
  return taxYear - birthYear;
}
