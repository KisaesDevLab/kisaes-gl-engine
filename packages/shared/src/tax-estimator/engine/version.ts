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
 *              Schedule 1-A tips / overtime phase-out steps round DOWN (whole
 *              $1,000s, 2025 Schedule 1-A lines 11 / 19); car-loan interest keeps
 *              rounding UP (line 28) — Q37 oracle batch 2 (R7-06).
 *   1.0.0-rc.3 Q41 (CPA decision): the >2% S corporation shareholder health
 *              add-on (W-2 box 1) is excluded from the §199A W-2 wages by default
 *              and included per entity year when `includeSehiInW2Wages` is on;
 *              the default reproduces rc.2 to the cent.
 *   1.0.0-rc.4 Q44 dependents: §21 child and dependent care credit, §24 child
 *              tax credit / credit for other dependents with the phase-out and
 *              the additional child tax credit (Schedule AI columns use the
 *              full-year amounts), EITC / head-of-household warnings, and state
 *              personal / dependent exemptions and exemption credits
 *              (`exemptions` state rule). A taxpayer with no dependents, no care
 *              expenses and states without an `exemptions` rule reproduces rc.3.
 */
export const TAX_ENGINE_VERSION = '1.0.0-rc.4';
