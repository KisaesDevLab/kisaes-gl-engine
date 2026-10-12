// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// QA D6: structural checks for the installment schedule keys that the per-type
// validators cannot see. An installment percentage list must have one entry per
// due date and its entries must add up to 100%; otherwise every estimate that
// reads the rule fails (TE_STATE_RULE_INVALID / TE_INSTALLMENT_POLICY).

export interface InstallmentKeyPair {
  /** Per-installment fractions (0.25 = 25%). */
  pcts: string;
  /** The schedule the fractions belong to (due dates or due months). */
  schedule: string;
  scheduleNoun: string;
}

export const FEDERAL_INSTALLMENT_PAIRS: readonly InstallmentKeyPair[] = [
  { pcts: 'installments.pcts', schedule: 'installments.due_dates', scheduleNoun: 'due dates' },
  { pcts: 'ccorp.installment_pcts', schedule: 'ccorp.installment_months', scheduleNoun: 'due months' },
];
export const STATE_INSTALLMENT_PAIRS: readonly InstallmentKeyPair[] = [
  { pcts: 'installments.pcts', schedule: 'installments.due_dates', scheduleNoun: 'due dates' },
];

const SUM_TOLERANCE = 0.0001;

export function installmentPairOf(pairs: readonly InstallmentKeyPair[], key: string): InstallmentKeyPair | null {
  return pairs.find((p) => p.pcts === key || p.schedule === key) ?? null;
}

/** The other key of `key`'s pair, or null when `key` is not an installment key. */
export function installmentPartnerKey(pairs: readonly InstallmentKeyPair[], key: string): string | null {
  const p = installmentPairOf(pairs, key);
  if (!p) return null;
  return p.pcts === key ? p.schedule : p.pcts;
}

const pctText = (n: number) => `${Math.round(n * 1000000) / 10000}%`;

/** A percentage list on its own: every entry 0..1 and the total 100%. */
export function installmentPctsError(key: string, value: unknown): string | null {
  if (value == null || !Array.isArray(value)) return null; // type / nullability is the per-type validator's job
  const nums = value.filter((x): x is number => typeof x === 'number');
  if (nums.length !== value.length) return null;
  if (nums.some((n) => n > 1)) return `${key}: each installment is a fraction of the year's payment (0.25 = 25%); no entry may exceed 1`;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return `${key}: the installment percentages must add up to 100% (they add up to ${pctText(sum)})`;
  return null;
}

/**
 * The whole pair after an edit: the percentages are valid on their own and
 * there is exactly one per due date. A null on either side (no installment
 * regime) is accepted only when both are null.
 */
export function installmentPairError(pair: InstallmentKeyPair, pcts: unknown, schedule: unknown): string | null {
  const own = installmentPctsError(pair.pcts, pcts);
  if (own) return own;
  if (pcts == null && schedule == null) return null;
  if (pcts == null || schedule == null) {
    return `${pair.pcts} and ${pair.schedule} must both be set or both be null`;
  }
  if (!Array.isArray(pcts) || !Array.isArray(schedule)) return null;
  if (pcts.length !== schedule.length) {
    return `${pair.pcts} has ${pcts.length} ${pcts.length === 1 ? 'entry' : 'entries'} but ${pair.schedule} has ${schedule.length} ${pair.scheduleNoun}; they must match (edit both together)`;
  }
  return null;
}
