// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

// "Apply match" body: which candidate (by zero-based index into
// the persisted match_candidates JSONB array). The route handler
// loads the row, checks the index is in range, and dispatches by
// the candidate's `kind`. Index-based addressing avoids inventing
// a separate candidate ID column on the JSONB; the persisted top-3
// are stable for the row's lifetime (re-running the matcher is
// an explicit endpoint, not a side effect).
export const applyMatchSchema = z.object({
  candidateIndex: z.number().int().min(0).max(99),
});
export type ApplyMatchInput = z.infer<typeof applyMatchSchema>;

// "Not a match" body: drop a single candidate by index. Same
// rationale as applyMatchSchema for index-based addressing.
export const notAMatchSchema = z.object({
  candidateIndex: z.number().int().min(0).max(99),
});
export type NotAMatchInput = z.infer<typeof notAMatchSchema>;
