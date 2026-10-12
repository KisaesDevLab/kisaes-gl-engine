// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Stored on every snapshot (MODULE.md "Scenarios, snapshots"). Bump when a
 * computed line can change — a snapshot made under one version must never be
 * mistaken for one made under another.
 *
 * History (one line per bump):
 *   0.6.0      Phase 6 federal core.
 *   1.0.0-rc.1 Phases 7–10 (loss limits, §199A, other taxes, states, C corp /
 *              farmer, estimates) + the R2 review fixes: exclusive dividend
 *              buckets (R2-01), Schedule 1-A disallowed for MFS (R2-02),
 *              Form 8582 allowance allocation (R2-03), Schedule AI SEHI /
 *              Part II exactness (R2-05/07), Sch 1-A $1,000-step phase-outs
 *              (R2-14), SIMPLE compensation base (R2-13), Form 2210 day
 *              convention (R2-09), derived state sourcing after loss limits
 *              (R2-15).
 *   1.0.0-rc.2 R7 fixes: a recorded employee deferral caps the solo 401(k) /
 *              SIMPLE deferral leg and the SIMPLE match (R7-01); a non-recurring
 *              GL-linked adjustment is never run-rated (R7-05);
 *              TE_SS_WAGES_DEFAULTED is a warning with its dollar effect (R7-12).
 */
export const TAX_ENGINE_VERSION = '1.0.0-rc.2';
