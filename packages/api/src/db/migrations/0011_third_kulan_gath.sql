-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
ALTER TABLE "users" ADD COLUMN "display_preferences" jsonb DEFAULT '{"fontScale":1,"theme":"system"}';