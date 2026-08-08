# Tax code seed — tax year 2025, version 2

`tax-codes.xlsx` is the global tax-code crosswalk seed. Imported by the TB seed
importer (admin upload or `npm run seed:tax-codes -w @kis-books/api`). 760 data
rows + header.

## Provenance (v2 rebuild, 2026-08-08)

v1 mixed genuine codes with AI-fabricated rows (text `SC_*`/`SF_*`/… codes with
invented vendor mappings), cloned the 1120S code list into 1120 (wrong line
meanings for every code where the forms diverge), and mirrored every code into
the form's `common` activity (duplicate picker entries / split export lines).
v2 is rebuilt from authoritative sources:

- **Canonical `tax_code` + `ultratax_code` + description**: Thomson Reuters
  "Tax Code Listing for integration between tax and accounting applications",
  tax year 2024 (latest published; codes are stable year over year). The
  numeric code IS the UltraTax CS / Accounting CS tax code; `ultratax_code`
  always equals `tax_code`.
- **`gosystem_code`**: GoSystem Tax RS Tax Return Codes (TRCs, `NN-NNN`),
  validated against the official TRC master list (riahelp.com, TRC_All,
  2025-06-25) including per-entity applicability. TRCs exist only for business
  returns — **1040 rows correctly have no GoSystem code** (the CS-numeric
  route via AdvanceFlow/Accounting CS is the only 1040 bridge).
- **`lacerte_code`**: CCH "Lacerte Tax Line Conversion Chart" notation
  (`01A`, `K05.01`, …) used by TB-bridge vendors for 1065/1120/1120S. No such
  chart exists for 1040 — 1040 rows are blank by design. Note these are
  reference crosswalk values; Lacerte's own import path is SmartMap.
- **`cch_code`**: CCH interface codes carried where verified; blank where no
  authoritative source was found.

Blank vendor cells mean "no authoritative code exists/found" — exports
surface them as overridable `missingVendorCode` validation findings. Never
fill vendor columns from memory or guesswork; cite a vendor document.

## Structure rules

- Each (return_form, tax_code) lives in exactly ONE activity bucket:
  activity-specific lines (Sch C/E/F, 4835, 8825/Rent, page-1 trade or
  business) in their activity; entity-level lines (Sch K/L/M-1/M-2, Sch C
  dividends, payments) in `common`. No mirroring — `listAvailableCodes`
  unions `common` + the company's activities, so a mirrored code would show
  twice and split export lines.
- Specialty families are intentionally excluded: Sch M-3 / 8916-A, DISC
  (Sch B/E/M-4), 1120-PC/-SF/-F, Co-op. Add them in a future version if a
  client needs them.
- `sort_order` = numeric tax code (Tax Return Order Report sequence);
  utility rows sort 9000+.
- `is_m1_adjustment` = true for Sch M-1/M-2 book-difference codes (plus
  UltraTax-designated book codes like 1120S 228 Sec 179).

## Column contract (sheet "Tax Codes", 12 columns, exact order)

| Column | Type | Notes |
|--------|------|-------|
| return_form | enum | `1040` \| `1065` \| `1120` \| `1120S` \| `common` |
| activity_type | enum | `common` \| `business` \| `rental` \| `farm` \| `farm_rental` |
| tax_code | text, non-null | Unique together with return_form + activity_type |
| description | text | `<Schedule>; <Line> - <TR description>`, e.g. `1065; L01a - Gross receipts or sales` |
| sort_order | integer | Tax Return Order Report sequence |
| is_m1_adjustment | boolean-ish | `true`/`false` strings; coerced on import |
| notes | text, nullable | |
| ultratax_code | text, nullable | UltraTax CS / Accounting CS tax code (= tax_code) |
| cch_code | text, nullable | CCH interface code |
| lacerte_code | text, nullable | Lacerte tax-line (bridge/grouping) code, CCH chart notation |
| gosystem_code | text, nullable | GoSystem Tax RS TRC (business returns only) |
| generic_code | text, nullable | Utility rows only; generic export always emits the canonical code |

Validation on import (ADR-TB-05): uniqueness on (return_form, activity_type,
tax_code); no null/empty tax_code; enum domains above; `common/common` utility
codes present (DONOTMAP, MEMO, SUSPENSE, REPORTING_ONLY, …). Import is
idempotent per version with a dry-run diff; `FIRM:`-namespaced firm codes are
never touched.
