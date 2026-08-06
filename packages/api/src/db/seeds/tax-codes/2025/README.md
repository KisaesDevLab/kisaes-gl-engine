# Tax code seed — tax year 2025, version 1

`tax-codes.xlsx` is the global tax-code crosswalk seed (D15: seeds as tax year
2025, version 1). Imported by the TB seed importer (admin upload or
`npm run seed:tax-codes -w @kis-books/api`). 2,846 data rows + header.

## Column contract (sheet "Tax Codes", 12 columns, exact order)

| Column | Type | Notes |
|--------|------|-------|
| return_form | enum | `1040` \| `1065` \| `1120` \| `1120S` |
| activity_type | enum | `common` \| `business` \| `rental` \| `farm` \| `farm_rental` |
| tax_code | text, non-null | Unique together with return_form + activity_type |
| description | text | Return-line description, e.g. `1065; L01a - Gross receipts or sales` |
| sort_order | integer | Tax Return Order Report sequence |
| is_m1_adjustment | boolean-ish | `true`/`false` strings; coerced on import |
| notes | text, nullable | |
| ultratax_code | text, nullable | UltraTax CS import code |
| cch_code | text, nullable | CCH Axcess code |
| lacerte_code | text, nullable | Lacerte code |
| gosystem_code | text, nullable | GoSystem RS code |
| generic_code | text, nullable | Generic CSV crosswalk value |

Validation on import (ADR-TB-05): uniqueness on (return_form, activity_type,
tax_code); no null/empty tax_code; enum domains above; `common/common` utility
codes present (DONOTMAP, MEMO, SUSPENSE, …). Import is idempotent per version
with a dry-run diff; `FIRM:`-namespaced firm codes are never touched.
