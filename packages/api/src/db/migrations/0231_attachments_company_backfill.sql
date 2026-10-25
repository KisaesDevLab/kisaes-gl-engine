-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Attachments scoped by company (U-90, attachments-company-v1, review M4).
-- One-time backfill: an attachment with no company takes the company of the
-- record it is filed on (attachable_id) — a transaction, contact (also a
-- W-9's vendor_1099_profile), daily-sales entry, tax entry, TB lead sheet
-- (tb_groupings), Bill Capture, bank-feed item or portal receipt. Same
-- parents as attachmentService.companyScope, matched by id (UUIDs, so at
-- most one table answers).
--
-- Data only, no schema change. Idempotent: every statement touches only
-- rows whose company_id is still NULL and whose parent has a company, so a
-- re-run changes nothing. Row locks only (no table rewrite, no new index);
-- each UPDATE joins on the parent's primary key. Rows that stay NULL (drafts,
-- receipts, files of a tenant-wide or deleted record) keep the tenant-wide
-- rule: visible to every company unless filed on another company's record.
-- The rollback is a no-op: the copied company is what the scope rule
-- already derived from the parent.
UPDATE attachments a SET company_id = p.company_id
  FROM transactions p
  WHERE a.company_id IS NULL AND p.tenant_id = a.tenant_id AND p.id = a.attachable_id
    AND p.company_id IS NOT NULL;
--> statement-breakpoint
UPDATE attachments a SET company_id = p.company_id
  FROM contacts p
  WHERE a.company_id IS NULL AND p.tenant_id = a.tenant_id AND p.id = a.attachable_id
    AND p.company_id IS NOT NULL;
--> statement-breakpoint
UPDATE attachments a SET company_id = p.company_id
  FROM daily_sales_entries p
  WHERE a.company_id IS NULL AND p.tenant_id = a.tenant_id AND p.id = a.attachable_id
    AND p.company_id IS NOT NULL;
--> statement-breakpoint
UPDATE attachments a SET company_id = p.company_id
  FROM tb_tax_entries p
  WHERE a.company_id IS NULL AND p.tenant_id = a.tenant_id AND p.id = a.attachable_id
    AND p.company_id IS NOT NULL;
--> statement-breakpoint
UPDATE attachments a SET company_id = p.company_id
  FROM tb_groupings p
  WHERE a.company_id IS NULL AND p.tenant_id = a.tenant_id AND p.id = a.attachable_id
    AND p.company_id IS NOT NULL;
--> statement-breakpoint
UPDATE attachments a SET company_id = p.company_id
  FROM bill_captures p
  WHERE a.company_id IS NULL AND p.tenant_id = a.tenant_id AND p.id = a.attachable_id
    AND p.company_id IS NOT NULL;
--> statement-breakpoint
UPDATE attachments a SET company_id = p.company_id
  FROM bank_feed_items p
  WHERE a.company_id IS NULL AND p.tenant_id = a.tenant_id AND p.id = a.attachable_id
    AND p.company_id IS NOT NULL;
--> statement-breakpoint
UPDATE attachments a SET company_id = p.company_id
  FROM portal_receipts p
  WHERE a.company_id IS NULL AND p.tenant_id = a.tenant_id AND p.id = a.attachable_id
    AND p.company_id IS NOT NULL;
