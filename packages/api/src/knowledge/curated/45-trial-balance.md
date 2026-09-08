# Trial Balance module (firm-side)

The Trial Balance module gives the accounting firm a tax-preparation
workpaper over the live general ledger. It appears as the "Trial
Balance" sidebar group for firm staff when the TRIAL_BALANCE_V1 feature
flag is on. Client users and portal contacts never see it.

Key ideas:

- **Balances are always computed from the books.** There is no balance
  import or entry — if the ledger changes, the trial balance changes.
  The workpaper has five columns: Unadjusted → AJE → Adjusted → Tax
  RJE → Tax, on either accrual or cash basis.
- **AJEs (adjusting journal entries)** are real journal entries the firm
  posts (Trial Balance → Adjusting Entries, or the New AJE button).
  They're numbered AJE-001 per client per fiscal year, show a purple
  badge in every transaction list, can be reversed onto the first day of
  the next month, and can be posted even into a closed period.
- **Tax adjustments (RJEs)** (Trial Balance → Tax Adjustments) exist
  only on the tax basis — they never touch the books or any financial
  report. They feed the Tax column, Schedule M-1, and exports.
- **Tax codes** (Trial Balance → Tax Mapping): each account gets a
  tax-return line code (from the admin-managed seed library, or the
  firm's own FIRM: codes). The picker only offers codes valid for the
  client's return form (1040/1065/1120/1120S) and activity. "Auto-assign"
  asks the AI for suggestions; nothing commits until the preparer accepts.
- **Tax codes per activity unit** (TB Settings → tax profile → "Map tax
  codes per activity unit", firm admin): for a client running several
  activities out of one set of books (a Schedule C business and a
  Schedule F farm sharing accounts), Tax Mapping shows one sub-row per
  activity unit for every income/expense account, so the same account
  carries a Sch C code for one unit and a Sch F code for another. The
  account's own row is the DEFAULT unit's code (also untagged lines and
  all balance-sheet accounts, which never split); every other unit with a
  balance needs its own code or the vendor export is blocked ("Per-unit
  tax codes" on Tax Exports). Use the "Activity unit" filter to work one
  unit at a time. **Copy mappings…** copies one unit's codes onto other
  compatible units (e.g. a second Schedule F farm) with a preview —
  codes that don't fit the target's activity are skipped, never silently
  written; the copy icon on a unit row applies that one code to every
  other unit of the same activity. Auto-assign runs per unit. Changing
  the default unit shows the impact first (accounts losing coverage,
  mismatched codes) with an option to keep the old default's codes.
- **Activity units** (TB Settings) split one set of books across
  multiple return activities (e.g. two rentals + a farm on a 1065) by
  mapping line-level tags to units. The workpaper's Activity view can
  show one unit, or "By tag / unit #" — every income/expense account
  once per tag with the unit number on the account number (6050-2, or
  2-6050 when TB Settings → "Unit # on exports" prepends it; untagged
  activity is unit 0). Balance sheet accounts are never segmented (a
  balance sheet can't balance per tag) — they show as unit 0 and export
  as one plain row.
- **Download** (workpaper header) exports exactly what's on screen —
  CSV, PDF, or the Excel Working TB — with the current period, basis,
  tag filter, activity view, and category/search filters applied.
- **Leadsheets** (Trial Balance → Leadsheets) group accounts into
  workpapers (Cash, AR, Fixed Assets…) with tickmarks, notes, and a
  preparer→reviewer sign-off flow. A sign-off goes "stale" if the
  books change after signing.
- **Closing date** (TB Settings): locks client-side changes on or
  before the date. Firm staff can override with a confirmation
  (audit-logged); AJEs are always allowed.
- **Reports** (Trial Balance → TB Reports): workpaper, grouped TB, Tax
  Return Order, Tax-Basis P&L, Flux Analysis, AJE listing, Bookkeeper
  Letter, RJE listing, code summary, Schedule M-1/M-2, Workpaper Index,
  Diagnostics — all also available in Report Packs for bulk PDF.
- **Tax Exports** (Trial Balance → Tax Exports): UltraTax CS, Lacerte,
  CCH Axcess, GoSystem RS, generic CSV, and an Excel working trial
  balance. Validation must pass first (all accounts coded, activity
  splits resolved, software codes present); export history tracks
  whether the books changed since a file was generated.
- **Popout**: the workpaper's popout button opens a read-only live
  trial balance in its own window that refreshes as book work posts —
  changed rows flash.
