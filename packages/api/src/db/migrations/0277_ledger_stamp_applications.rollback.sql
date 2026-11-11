-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0277 (ledger stamp on applications). Nothing is lost: the
-- triggers and their function go; gl_version_stamps keeps its counters.
DROP TRIGGER IF EXISTS trg_rb_stamp_payment_applications_ins ON payment_applications;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_payment_applications_upd ON payment_applications;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_payment_applications_del ON payment_applications;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_bill_payment_applications_ins ON bill_payment_applications;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_bill_payment_applications_upd ON bill_payment_applications;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_bill_payment_applications_del ON bill_payment_applications;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_vendor_credit_applications_ins ON vendor_credit_applications;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_vendor_credit_applications_upd ON vendor_credit_applications;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_rb_stamp_vendor_credit_applications_del ON vendor_credit_applications;
--> statement-breakpoint
DROP FUNCTION IF EXISTS rb_bump_gl_stamp_apps();
