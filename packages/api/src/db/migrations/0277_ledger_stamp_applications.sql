-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Ledger stamp on applications (U-119, ClientLedger A07 PR-B; the
-- Report Builder's `stamp`). Applying, changing or removing a payment, credit
-- memo, bill payment or vendor credit application moves cash-basis lines and
-- open items without touching journal_lines, so gl_version_stamps (0144)
-- missed it. Statement-level triggers on payment_applications,
-- bill_payment_applications and vendor_credit_applications bump the stamp of
-- the payment's company, in 0144's style. deposit_lines is left alone: no
-- report reads it (a deposit's ledger effect is its journal lines).
-- Additive: one function, nine triggers; no data changes. MyBooks Online's
-- Trial Balance cache (rule TB6) now also invalidates on applications.
CREATE OR REPLACE FUNCTION rb_bump_gl_stamp_apps() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gl_version_stamps (tenant_id, company_id, counter, updated_at)
  SELECT DISTINCT
    t.tenant_id,
    COALESCE(t.company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    1, now()
  FROM rb_changed_apps r
  JOIN transactions t ON t.id = r.payment_id
  ON CONFLICT (tenant_id, company_id)
  DO UPDATE SET counter = gl_version_stamps.counter + 1, updated_at = now();
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_payment_applications_ins ON payment_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_payment_applications_ins
  AFTER INSERT ON payment_applications
  REFERENCING NEW TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_payment_applications_upd ON payment_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_payment_applications_upd
  AFTER UPDATE ON payment_applications
  REFERENCING NEW TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_payment_applications_del ON payment_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_payment_applications_del
  AFTER DELETE ON payment_applications
  REFERENCING OLD TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_bill_payment_applications_ins ON bill_payment_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_bill_payment_applications_ins
  AFTER INSERT ON bill_payment_applications
  REFERENCING NEW TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_bill_payment_applications_upd ON bill_payment_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_bill_payment_applications_upd
  AFTER UPDATE ON bill_payment_applications
  REFERENCING NEW TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_bill_payment_applications_del ON bill_payment_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_bill_payment_applications_del
  AFTER DELETE ON bill_payment_applications
  REFERENCING OLD TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_vendor_credit_applications_ins ON vendor_credit_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_vendor_credit_applications_ins
  AFTER INSERT ON vendor_credit_applications
  REFERENCING NEW TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_vendor_credit_applications_upd ON vendor_credit_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_vendor_credit_applications_upd
  AFTER UPDATE ON vendor_credit_applications
  REFERENCING NEW TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_vendor_credit_applications_del ON vendor_credit_applications;
--> statement-breakpoint
CREATE TRIGGER trg_rb_stamp_vendor_credit_applications_del
  AFTER DELETE ON vendor_credit_applications
  REFERENCING OLD TABLE AS rb_changed_apps
  FOR EACH STATEMENT EXECUTE FUNCTION rb_bump_gl_stamp_apps();
