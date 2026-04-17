-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
ALTER TABLE "companies" ADD COLUMN "category_filter_mode" varchar(10) DEFAULT 'by_type';