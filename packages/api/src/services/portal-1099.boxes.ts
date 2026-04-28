// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN — closed catalog of (1099 form,
// box) combinations the account-mapping UI offers. Lifted out of
// the service module so the validator is unit-testable and so the
// catalog has exactly one home.
//
// Scope = the boxes a small/mid-sized CPA firm actually files:
// 1099-NEC Box 1 (the contractor case) plus the five 1099-MISC
// boxes operators routinely encounter. 1099-K Box 1a and the
// rare MISC boxes (4, 5, 7, 8, 9, 11–15) are intentionally
// excluded; adding more is a constant change to this file.

export const FORM_1099_BOXES = [
  { value: 'NEC-1',   form: '1099-NEC',  box: '1',  label: 'Nonemployee compensation' },
  { value: 'MISC-1',  form: '1099-MISC', box: '1',  label: 'Rents' },
  { value: 'MISC-2',  form: '1099-MISC', box: '2',  label: 'Royalties' },
  { value: 'MISC-3',  form: '1099-MISC', box: '3',  label: 'Other income' },
  { value: 'MISC-6',  form: '1099-MISC', box: '6',  label: 'Medical & health care payments' },
  { value: 'MISC-10', form: '1099-MISC', box: '10', label: 'Gross proceeds paid to attorney' },
] as const;

export type FormBox = (typeof FORM_1099_BOXES)[number]['value'];

export function isValidFormBox(value: unknown): value is FormBox {
  return (
    typeof value === 'string' &&
    FORM_1099_BOXES.some((b) => b.value === value)
  );
}

/** Lookup table for human labels — handy for audit-log payloads
 *  and the "currently in OTHER_BOX" warning in the UI. */
export const FORM_BOX_LABELS: Record<FormBox, string> = FORM_1099_BOXES.reduce(
  (acc, b) => {
    acc[b.value] = `${b.form} Box ${b.box} — ${b.label}`;
    return acc;
  },
  {} as Record<FormBox, string>,
);

/** Per-box reporting thresholds (USD).
 *  Royalties (MISC-2) trigger at $10; everything else at $600. */
export const BOX_THRESHOLDS: Record<FormBox, number> = {
  'NEC-1': 600,
  'MISC-1': 600,
  'MISC-2': 10,
  'MISC-3': 600,
  'MISC-6': 600,
  'MISC-10': 600,
};

/** Which form does a given form_box live under? Powers the
 *  exporter's "give me only the NEC rows" filter. */
export function formOf(formBox: FormBox): '1099-NEC' | '1099-MISC' {
  return formBox.startsWith('NEC') ? '1099-NEC' : '1099-MISC';
}
