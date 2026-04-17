-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
ALTER TABLE "users" ADD COLUMN "display_preferences" jsonb DEFAULT '{"fontScale":1,"theme":"system"}';