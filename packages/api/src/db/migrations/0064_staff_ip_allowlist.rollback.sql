-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: ROLLBACK file for 0064_staff_ip_allowlist.sql. DROP TABLE is
-- the whole point of a rollback. Not registered in _journal.json; never
-- auto-applied. Any configured CIDR entries are lost on apply.

DROP TABLE IF EXISTS staff_ip_allowlist;
