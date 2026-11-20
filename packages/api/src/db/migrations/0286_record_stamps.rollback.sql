-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0286 (U-291). Nothing is lost: the backfilled stamps stay;
-- the engine goes back to setting updated_at in code.
DROP TRIGGER IF EXISTS mybooks_stamp_child ON attachments;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON deposit_lines;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON vendor_credit_applications;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON bill_payment_applications;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON payment_applications;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON transaction_tags;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON journal_lines;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON tag_groups;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON tags;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON items;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON contacts;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON accounts;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON transactions;
DROP TRIGGER IF EXISTS mybooks_stamp ON tag_groups;
DROP TRIGGER IF EXISTS mybooks_stamp ON tags;
DROP TRIGGER IF EXISTS mybooks_stamp ON items;
DROP TRIGGER IF EXISTS mybooks_stamp ON contacts;
DROP TRIGGER IF EXISTS mybooks_stamp ON accounts;
DROP TRIGGER IF EXISTS mybooks_stamp ON transactions;
DROP FUNCTION IF EXISTS mybooks_stamp_attachment();
DROP FUNCTION IF EXISTS mybooks_stamp_child();
DROP FUNCTION IF EXISTS mybooks_stamp_bump(text, uuid);
DROP FUNCTION IF EXISTS mybooks_stamp_insert();
DROP FUNCTION IF EXISTS mybooks_stamp_header();
DROP FUNCTION IF EXISTS mybooks_stamp_next(timestamptz);
DROP FUNCTION IF EXISTS mybooks_stamp_key(text, uuid);