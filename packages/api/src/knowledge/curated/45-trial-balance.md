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
- **Tax codes**: each account gets a tax-return line code (from the
  admin-managed seed library, or the firm's own FIRM: codes). The
  workpaper's picker only offers codes valid for the client's return
  form (1040/1065/1120/1120S) and activity. "Auto-assign" asks the AI
  for suggestions; nothing commits until the preparer accepts.
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
