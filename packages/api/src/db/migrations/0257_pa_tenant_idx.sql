-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- U-155 (cash-basis report performance): the cash-basis virtual ledger
-- (report.service.ts arAppsCte / executeCashBasis) reads a tenant's
-- payment_applications with hash joins. Without a tenant index that was a
-- scan of every tenant's rows. Additive; no data change.
CREATE INDEX IF NOT EXISTS "idx_pa_tenant" ON "payment_applications" USING btree ("tenant_id");
