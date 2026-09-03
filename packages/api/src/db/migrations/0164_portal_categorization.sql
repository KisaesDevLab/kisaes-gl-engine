-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- PORTAL_CATEGORIZE_V1 — portal contacts may SUGGEST a category for
-- uncategorized activity. A suggestion never posts. Staff approve, override
-- or reject it from Practice -> Uncategorized, and approval runs through the
-- existing posting primitives (bankFeedService.categorize for an unposted
-- bank line, suspense clearing for one already in the suspense account).
--
-- Why a dedicated table rather than columns on transaction_classification_
-- state: that table is 1:1 on a NOT NULL bank_feed_item_id, so it cannot
-- address a posted transaction sitting in suspense -- which is half of what
-- clients need to categorize. It is also rewritten by the categorization
-- pipeline, which would clobber a human answer.
--
-- The unread contract is the document-request one, verbatim:
--   status='pending' AND reviewed_at IS NULL == an unread client submission.
--
-- snapshot_* are NOT a cache. They are the staleness detector: Plaid rewrites
-- amounts as a transaction moves pending -> posted, so a suggestion the
-- client made against $42.50 must not be bulk-approved once the row says
-- $58.10. Staff see the drift and confirm explicitly.

ALTER TABLE portal_contact_companies
  ADD COLUMN IF NOT EXISTS categorize_access boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS client_category_suggestions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Exactly one of the two targets is set; see the CHECK below.
  target_kind         varchar(20) NOT NULL,
  bank_feed_item_id   uuid REFERENCES bank_feed_items(id) ON DELETE CASCADE,
  -- Soft reference, matching transaction_classification_state.transaction_id:
  -- a deleted transaction should retire the suggestion, not block the delete.
  transaction_id      uuid,

  -- NULL means "not sure" — the client asked for help rather than picking.
  -- Such a row is never approvable; it exists to route the note to a human.
  suggested_account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  -- The label as SHOWN to the client, kept so the audit trail survives a
  -- later rename of the account.
  suggested_label     varchar(120),
  client_note         text,
  -- "This was personal, not a business expense." Resolved to the tenant's
  -- owner-draw account by staff; the client never sees an equity account.
  is_personal         boolean NOT NULL DEFAULT false,

  status              varchar(20) NOT NULL DEFAULT 'pending',
  submitted_by_contact_id uuid NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  submitted_at        timestamptz NOT NULL DEFAULT now(),

  reviewed_at         timestamptz,
  reviewed_by         uuid,
  resolution          varchar(30),
  resolved_account_id uuid,
  rejection_reason    text,
  posted_transaction_id uuid,

  snapshot_amount     numeric(19,4) NOT NULL,
  snapshot_date       date NOT NULL,
  snapshot_description varchar(500),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ccs_target_exclusive CHECK (
    (target_kind = 'bank_feed_item' AND bank_feed_item_id IS NOT NULL AND transaction_id IS NULL)
 OR (target_kind = 'transaction'    AND transaction_id  IS NOT NULL AND bank_feed_item_id IS NULL)
  ),
  CONSTRAINT ccs_status_known CHECK (
    status IN ('pending','approving','approved','rejected','superseded','stale')
  ),
  -- A row has to say something: a category, "personal", or a note.
  CONSTRAINT ccs_has_answer CHECK (
    suggested_account_id IS NOT NULL OR is_personal = true OR client_note IS NOT NULL
  )
);
--> statement-breakpoint

-- At most ONE live suggestion per target. Makes a double submit idempotent
-- and lets a re-answer supersede cleanly instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ccs_live_feed_item
  ON client_category_suggestions (bank_feed_item_id)
  WHERE status IN ('pending','approving') AND bank_feed_item_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_ccs_live_transaction
  ON client_category_suggestions (transaction_id)
  WHERE status IN ('pending','approving') AND transaction_id IS NOT NULL;
--> statement-breakpoint

-- The unread badge, mirroring idx_doc_req_tenant_unread.
CREATE INDEX IF NOT EXISTS idx_ccs_tenant_unread
  ON client_category_suggestions (tenant_id)
  WHERE status = 'pending' AND reviewed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ccs_tenant_company_status
  ON client_category_suggestions (tenant_id, company_id, status, submitted_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ccs_contact
  ON client_category_suggestions (submitted_by_contact_id, submitted_at DESC);
--> statement-breakpoint

-- Feature flags: OFF for every existing tenant; firms opt in per tenant, then
-- per contact for the portal half.
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'PORTAL_CATEGORIZE_V1', FALSE FROM tenants t
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'UNCATEGORIZED_REVIEW_V1', FALSE FROM tenants t
ON CONFLICT DO NOTHING;
