-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- ADR 0XW + repo-alignment addendum §E: extend the existing budgets
-- feature to support tag-scoped budgets and the supporting metadata
-- (lifecycle status, period type, fiscal-year-start date). Strictly
-- additive per CLAUDE.md rule #13 — legacy `budget_lines.month_N`
-- columns are preserved and remain the service layer's primary write
-- surface. The new `budget_periods` table is populated from the legacy
-- rows and will become authoritative in a later cutover.

ALTER TABLE budgets
  ADD COLUMN tag_id uuid,
  ADD COLUMN description text,
  ADD COLUMN period_type varchar(20) NOT NULL DEFAULT 'monthly',
  ADD COLUMN status varchar(20) NOT NULL DEFAULT 'active',
  ADD COLUMN fiscal_year_start date,
  ADD COLUMN created_by uuid;

ALTER TABLE budgets
  ADD CONSTRAINT fk_budgets_tag_id
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE RESTRICT;

ALTER TABLE budgets
  ADD CONSTRAINT ck_budgets_period_type
  CHECK (period_type IN ('monthly', 'quarterly', 'annual'));

ALTER TABLE budgets
  ADD CONSTRAINT ck_budgets_status
  CHECK (status IN ('draft', 'active', 'archived'));

CREATE INDEX IF NOT EXISTS idx_budgets_tenant_tag
  ON budgets(tenant_id, tag_id)
  WHERE tag_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_budgets_tenant_fy_start
  ON budgets(tenant_id, fiscal_year_start);

-- Backfill: derive fiscal_year_start from the legacy integer fiscal_year.
-- Rows without a set fiscal_year_start get Jan 1 of the fiscal year as
-- a sane default. Tenants on non-calendar fiscal years can edit this
-- on the budget later; the company's fiscal_year_start_month is NOT
-- consulted here to keep this migration deterministic (editing a
-- tenant-level default would shift every historical budget).
UPDATE budgets
SET fiscal_year_start = make_date(fiscal_year, 1, 1)
WHERE fiscal_year_start IS NULL;

-- Normalized per-period budget table. Shadows the legacy budget_lines
-- month_1..month_12 columns. The service layer continues to read/write
-- the legacy columns during the dual-write window. A later migration
-- will flip authoritative reads onto this table and drop the legacy
-- columns with a non-additive-exception marker.
CREATE TABLE IF NOT EXISTS budget_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id     uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  period_index  smallint NOT NULL,
  amount        decimal(19, 4) NOT NULL DEFAULT 0,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_budget_periods_period_index CHECK (period_index BETWEEN 1 AND 12),
  CONSTRAINT uq_budget_periods_budget_account_period UNIQUE (budget_id, account_id, period_index)
);

CREATE INDEX IF NOT EXISTS idx_budget_periods_budget_account
  ON budget_periods(budget_id, account_id);

-- Backfill budget_periods from the legacy month_N columns. LATERAL
-- unpivot turns one budget_lines row into 12 budget_periods rows.
-- Zero-amount cells are preserved because a user may have deliberately
-- planned $0 for a given month and we cannot distinguish that from
-- unset — downstream readers can filter amount <> 0 as needed.
INSERT INTO budget_periods (budget_id, account_id, period_index, amount)
SELECT bl.budget_id, bl.account_id, p.idx, p.amt
FROM budget_lines bl
CROSS JOIN LATERAL (VALUES
  (1::smallint,  bl.month_1),
  (2::smallint,  bl.month_2),
  (3::smallint,  bl.month_3),
  (4::smallint,  bl.month_4),
  (5::smallint,  bl.month_5),
  (6::smallint,  bl.month_6),
  (7::smallint,  bl.month_7),
  (8::smallint,  bl.month_8),
  (9::smallint,  bl.month_9),
  (10::smallint, bl.month_10),
  (11::smallint, bl.month_11),
  (12::smallint, bl.month_12)
) AS p(idx, amt)
WHERE p.amt IS NOT NULL
ON CONFLICT (budget_id, account_id, period_index) DO NOTHING;
