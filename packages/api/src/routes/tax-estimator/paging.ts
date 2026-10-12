// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

// Rule #16 for the Tax Estimator's small, naturally bounded lists (years of one taxpayer,
// scenarios of one year, state rows of one scenario, links / contacts of one taxpayer,
// adjustment types of one firm, treatment suggestions of one company, Schedule AI period
// snapshots of one year — R3-12). Each accepts `limit` / `offset` and answers
// `{ data, total, limit, offset }`. The default limit covers the whole set, so a client
// that does not page keeps getting everything; the services still read the whole set
// because the estimate needs it, so this pages the RESPONSE.
const MAX_PAGE = 500;

export const listPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(MAX_PAGE),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListPage = z.infer<typeof listPageQuerySchema>;

export function pageOf<T>(all: readonly T[], q: ListPage): { data: T[]; total: number; limit: number; offset: number } {
  return { data: all.slice(q.offset, q.offset + q.limit), total: all.length, limit: q.limit, offset: q.offset };
}
