-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
-- Fix: payroll_check_register_rows.amount must use decimal(19,4) per project convention
ALTER TABLE "payroll_check_register_rows" ALTER COLUMN "amount" TYPE numeric(19,4);
