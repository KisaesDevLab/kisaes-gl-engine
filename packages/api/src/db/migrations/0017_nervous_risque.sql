-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
ALTER TABLE "users" ADD COLUMN "is_super_admin" boolean DEFAULT false;