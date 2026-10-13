# Tax Estimator module (firm-side)

The Tax Estimator gives the accounting firm a running estimate of a
household's federal and state income tax and quarterly payment vouchers,
built from the general ledgers of the client companies the household owns.
It appears as the "Tax Estimator" sidebar group for firm staff when the
TAX_ESTIMATOR_V1 feature flag is on for the firm's practice tenant (Admin
-> Tenants -> the tenant's Feature Flags card). The flag is OFF by default
for every tenant. Client users never see the staff module.

It is an ESTIMATE, not tax advice and not a tax return. Every PDF and
portal view carries the firm's editable disclaimer. It never posts to the
books.

## Core objects

- **Taxpayer** (Tax Estimator -> Taxpayers): a household or filer owned by
  the FIRM, not a tenant. It can link companies in different client books,
  limited to clients the firm actively manages AND the signed-in user can
  access. Has a filing status, resident state, persons, and a safe-harbor
  and portal-view override.
- **Who sees which taxpayer**: firm administrators and super admins see
  every taxpayer of the firm. With the firm setting "Staff see only
  taxpayers linked to clients they can access" ON (the default, in the
  firm estimator settings), other staff see a taxpayer only when they can
  access at least one client company it is linked to; an unlinked taxpayer
  only by the person who created it. Turning the setting OFF shows every
  firm taxpayer to all staff with Tax Estimator access. A taxpayer page's
  "Who can see this taxpayer" card lets a firm administrator limit it to
  named staff (a lock icon shows in the list). A list REPLACES the firm
  setting for that taxpayer: exactly the listed people (and firm
  administrators) see it, whether or not they can open any of its linked
  clients, and they see its COMPLETE estimate, including companies in
  clients they cannot otherwise open (the estimate page says "Includes
  companies outside your client access because you're on this taxpayer's
  access list"; those links show "Via access list"). The list does not open
  those clients' books, entity tax setup or treatments, and listed staff
  cannot add, change or remove links into them. Anyone not on the list gets
  "Taxpayer not found", even with access to a linked client. With an empty
  list the firm setting decides, and figures from linked clients a person
  cannot access stay hidden. Only firm
  administrators can change the setting or the list; every change is in
  the audit log. The client portal is not affected (portal contacts see the
  taxpayers they are mapped to).
- **Persons**: the people on the return; one primary; months eligible for
  self-employed health insurance.
- **Dependents** (taxpayer page, Dependents card): name, date of birth,
  relationship, qualifying child or qualifying relative, months lived with
  the taxpayer, student, disabled, first / last tax year counted. No SSN.
  Same visibility as the taxpayer. Ages are figured at Dec 31 of the tax
  year: qualifying child under 17 -> child tax credit ($2,200 for 2025 and
  2026) with the refundable additional child tax credit (up to $1,700 per
  child, 15% of earned income over $2,500); everyone else -> credit for
  other dependents ($500); both phase out by $50 per $1,000 of AGI over
  $400,000 joint / $200,000 others. Care credit: child under 13 (turning
  13 during the year counts) or disabled dependent, with the year's care
  expenses from Annual settings ($3,000 / $6,000 limit, lower-earning
  spouse's earned income, 2025 35%->20%, 2026+ 50%->35%->20%). Order
  against the regular tax: care, child tax credit / other dependents,
  then the manual "other" credits. EITC is not computed (warning when it
  may apply); head of household is not inferred (reminder when single
  with a qualifying child). State: the resident state's personal /
  dependent exemptions come off a federal-AGI or federal-taxable base,
  exemption credits off the tax (e.g. AR $29 credits, GA dependent
  exemption, MO head-of-household $1,400); phase-outs not modelled; the
  GA estimate-requirement test uses the computed exemptions when none was
  entered on the state row.
- **Links**: person x company x tax year with profit/loss/capital %,
  partner SE status, activity type (active, passive, rental, investment),
  active participation (for the $25,000 rental allowance), QBI eligibility
  and an allowed-loss override.
- **Outside businesses** (taxpayer page, "Outside businesses" card, next
  to the company links): businesses whose books are NOT in MyBooks (a K-1,
  a spouse's practice). The business carries forward (name, type: Sch C /
  Sch F / S corp / partnership / C corp, owner, profit / loss %, activity,
  partner SE status, officer, QBI / SSTB, state sourcing); the amounts are
  entered per tax year with "Enter amounts": ordinary, rental, interest,
  ordinary / qualified dividends, short / long capital gain, section 1231,
  guaranteed payments (partnership), officer wages and the >2% health
  add-on (S corp), owner health insurance / retirement, W-2 wages and UBIA
  for QBI, allowed-loss override. Each year chooses an ENTRY MODE: "Full-
  year projection" (used as entered; spread evenly by month for the
  annualized-income method) or "Year to date" through a month (projected
  to December like the books, everything recurring; annualized columns
  after that month use the regular installment). And an AMOUNT BASIS:
  "Entity total" (100%, allocated by the owner's %) or "Owner's share"
  (already the owner's share, e.g. a K-1 — the % is informational and not
  applied). New years default to full year + owner's share. They get the
  full treatment (SE tax, QBI, passive / excess business loss, NIIT,
  state sourcing). The Calculation view marks them "Outside MyBooks ·
  entered"; an owner's-share entry prints only the share row "(K-1 share,
  N% owned)". A C corporation is estimated at the entity level (calendar
  year, not in the individual totals). An outside farm does not trigger
  the farmer test by itself (enter the gross-income figures on Annual
  settings). Readiness shows an "entered manually" note, never "not
  closed". Same visibility as the taxpayer; read-only staff cannot edit.
  A business owned by both spouses is entered once per spouse.
- **Entity tax setup** (per company): entity type (from the Trial Balance
  tax profile), tax method, state sourcing, SSTB/large-corp/farmer flags,
  W-2 wages override and UBIA, and the GL tax treatment table that says
  what each profit and loss account means for tax. Suggestions are never
  applied automatically. Unmapped accounts with activity are treated as
  ordinary with a warning. A single transaction can be marked
  **non-recurring** from its transaction detail page (the "Tax Estimator"
  card, shown to firm staff when the flag is on in that client and the
  company is linked to a taxpayer); the account register shows an "NR"
  badge on it. It is counted once and left out of the run-rate.
- **Entity type for <year>** (Entity tax setup, year inputs, per company
  and tax year): "Use TB profile" (default) or Schedule C, Schedule F,
  S corporation, Partnership or C corporation. It wins over the Trial
  Balance tax profile and the estimator setting for THAT tax year only;
  the TB profile and other years are not changed. Example: an LLC that
  files 1065 but elected S corporation status for 2026. The estimate
  follows it (S corp: no SE tax on the K-1, officer wages, officer links
  allowed for that year; partnership: guaranteed payments and partner SE
  tax; C corp: entity-level estimate, out of the owners' totals). Inputs
  that only fit the other type are ignored with a warning, not an error.
  The Calculation view shows "Entity type overridden: S corp (TB profile
  says 1065)" on the company line and the preparer assumptions page says
  so; client copies show only the type used. The old "estimator setting is
  ignored" note now points to this option.
- **Owner pickers and owner splits** (GL tax treatment table): the person
  or taxpayer for W-2 wages (officer wages), owner / officer health
  insurance, owner / officer retirement, guaranteed payments and
  estimated tax payments lists ONLY the owners linked to this business
  (Taxpayers > the taxpayer > Linked businesses). No linked owner = a note
  to link the owner first; saving an unlinked person is refused, and an
  older row naming one keeps computing with a "not linked" warning.
  "Split between owners" shares one account: by % (must total exactly
  100%; "Default from ownership" fills each owner's profit %) or by fixed
  annual $ for the year (each owner gets the fixed amount, the last owner
  in the list takes the difference from the books, with a warning; until
  the year is complete the year-to-date books amount is shared in
  proportion to the fixed amounts). Example: "6800 Salaries - Officers"
  101,640.24 split 60% / 40% gives 60,984.14 officer wages to one
  shareholder and 40,656.10 to the other; officer health split the same
  way lands on each shareholder's W-2 box 1 and their health deduction.
  Estimated tax payments can be split between taxpayers; each taxpayer's
  payment ledger gets its share of every payment. The calculation trace
  shows each share. "Use one owner" goes back to a single person. When the
  owners are different taxpayers (households), each taxpayer's estimate
  counts only its own share.
- **Projection method** (Entity tax setup, year inputs, per company and
  tax year): how the rest of the year's ORDINARY income is projected.
  "Run rate" (default) = year-to-date recurring per month x months left.
  "Prior-year seasonal (scaled)" = year-to-date + last year's remaining
  months x (this year's recurring year-to-date / last year's same months),
  the scale kept between 0.25 and 4. "Prior-year seasonal (dollar)" =
  year-to-date + last year's remaining months as-is. Example: 120,000
  through September, last year Jan-Sep 100,000 and Oct-Dec 80,000 -> run
  rate 160,000, scaled 216,000, dollar 200,000. Last year is read from the
  same company's books through the same treatment map, non-recurring
  items excluded. Other income kinds keep the run rate. Falls back to the
  run rate with a warning (also on readiness) when last year's books are
  incomplete (every month needs activity) or the figures do not support
  a trend. Not for C corporations or outside businesses. The Calculation
  view shows the method and "Run rate would be $X" on the company line.
- **Annual settings** (per taxpayer and year): deduction method, federal
  method (bracket or effective-rate override), OTHER credits (not the
  dependent credits, which are computed), child and dependent care
  expenses paid, withholding,
  Schedule 1-A (chips per type opening a per-person dialog for tips,
  overtime and car-loan interest; the senior deduction follows each
  person's date of birth; not allowed when married filing separately),
  HSA, prior-year tax and AGI (stored encrypted), state rows
  (one resident state), firm settings (safe-harbor default, disclaimer,
  portal view), and the **People** card: per person, W-2 wages (box 1) and
  Social Security wages (box 3) from jobs OUTSIDE the linked businesses,
  retirement plan type (SEP, solo 401(k), SIMPLE, none) and employee
  deferral; plus Form 8960 allocable deductions, the MFS "lived apart all
  year" flag and farmer/fisherman gross-income figures (current and prior
  year). Outside wages go in the People card, never in an adjustment: an
  adjustment is business income and loses the SE wage-base offset.
- **Scenarios and adjustments**: Base plus clones; adjustments cover
  anything else outside the books (interest, dividends, a sale, a planned
  purchase). Each is allocated by its cadence: monthly in every active
  month, quarterly split one third per month of the quarter, annual spread
  over the start-to-end months, one-time in its month. A GL-linked
  adjustment uses actuals through the last closed month, then its plan
  amount or (with no plan amount) the year-to-date run-rate; flagged
  non-recurring, it is never run-rated.

## Reading an estimate

Summary screen: "Actuals through" (default last closed month), scenario
selector, readiness banner (unreconciled accounts, suspense, unmapped
accounts, out-of-reach links, unverified parameters and state rules),
key figures, calculation table with traces, warnings, safe-harbor card
(both the 90 percent current-year rule and the 100/110 percent prior-year
rule, recommended one outlined), voucher tables per jurisdiction with
Schedule AI amounts, W-2 credit, paid, remaining, estimated underpayment
penalty and catch-up amounts, and the payments ledger (GL payments
read-only; manual payments added by staff with write access).

Parameters or state rules marked unverified or provisional are still used,
with warnings in the trace, the warnings list and the assumptions.

## Snapshots, PDF, Report Pack

Finalize & issue vouchers, downloading the PDF, and generating a Report
Pack that has the Tax Estimate section freeze an immutable snapshot
(never edited or deleted; finalize a new one). Identical same-day PDF or
Report Pack issues of the same figures reuse one snapshot rather than
making a new one each time. A snapshot can be compared
with live to see changed figures, new or resolved warnings and parameter
changes. The PDF equals the screen. The Report Pack section is "Tax
Estimate" in group Tax; pick the taxpayer (and optionally scenario) in the
section options.

The PDF's "Businesses included" list shows each owner's share of every
linked business ("Owners: Maria Rivera 50%"; the loss share only when it
differs). After the payment vouchers a new page, "Detailed calculation",
repeats the Calculation tab line by line with the YTD tax basis and
projected columns. Both the preparer PDF and the client copy (Report Pack)
include it; the client copy leaves out review markers and neither prints
the trace.

## Client portal

Portal contacts see a read-only Tax estimate tile and page (projected
total, next payments with due dates, paid and withheld, payments on
record, vouchers PDF, disclaimer) only when: the portal and the Tax
Estimator flags are on for the client's tenant, the contact is linked to
the taxpayer (taxpayer page -> Portal contacts), the taxpayer links the
year to a company of that tenant whose portal access has "Tax estimates"
ticked (Practice -> Client Portal), and the year has settings. The
portal shows the live estimate by default; only firm staff can switch it
to the latest finalized snapshot (per taxpayer, or the firm default in
Firm settings). The client has no control over it. Clients never see persons,
other owners, adjustments, traces, parameters or prior-year figures.

What each contact sees is set PER CONTACT (a spouse or a bookkeeper can see
less): on the taxpayer page open Portal contacts -> "What they see", or in
Practice -> Client Portal edit the contact -> "Tax estimates in the
portal". The switches are Calculation summary (off by default: income by
business showing only the household's share, adjustments total, AGI, the
deduction, QBI deduction, taxable income, regular tax, credits,
self-employment and other taxes, federal total, tax per state and the
total; no rates, formulas or adjustment detail), Quarterly estimates and
vouchers (on), Payments on record (on) and Download the estimate PDF (off;
a PDF of exactly what that contact sees in the portal: the projected total
plus the sections switched on, never business totals, other owners, rates
or adjustment detail; it is not the Report Pack client copy). The projected total always shows.
One setting covers every taxpayer the contact can open. Turning a switch on
needs firm staff with Tax Estimator access; the client's own staff can only
turn switches off. A switched-off section is not sent to the portal at all.

Scenarios: the Base scenario is always shown. To share a what-if, select it
on Annual settings and tick "Show this scenario in the client portal"; with
more than one shared scenario the client gets a scenario picker. Clients see
the scenario name exactly as written, so name it for them ("If you buy the
truck"). When the portal shows finalized snapshots, each shared scenario
shows its own latest finalized snapshot and a scenario without one is not
offered. "View as Client" shows exactly what the previewed contact sees.

## Dashboard cards

Company dashboard (TAX_ESTIMATOR_V1 on for the client's own tenant): for
each taxpayer linked to the active company, "Next estimated payment" (next
federal and state voucher: date, amount, paid or unpaid), "Projected tax
for the year" (federal + state total, change since the last finalized
estimate, books-through month) and "Paid vs required to date" (shortfall;
staff also see the estimated penalty). Firm staff with Tax Estimator access
see every linked taxpayer they may see, with Refresh and "Not computed yet".
The company owner sees only the taxpayer mapped to the portal contact with
the owner's e-mail and Tax estimates access on the company, with the same
figures as the client portal (no penalty), for the Base scenario (snapshot
mode: Base's latest finalized snapshot). The owner's cards follow that
contact's portal options: with "Quarterly estimates and vouchers" off only
the projected tax shows (no next payment, no paid vs required). Several
active contacts with the owner's e-mail: the most restrictive options apply.
Other users see nothing.
Tax Estimator home (above the taxpayer list): "Vouchers due in the next 30
days" and "Behind on payments" across every visible taxpayer, each row
opening the taxpayer, with a per-row refresh. Loading a dashboard never
computes an estimate: the cards use today's cached live estimate, else the
last finalized snapshot (firm cards: the newest stored live estimate or
snapshot), each labelled live or finalized and "as of" a date. Refresh,
opening the estimate or finalizing fills them.

## Super admin

Admin -> Tax parameters edits federal parameters per tax year and the
state rules for 50 states plus DC; changes are overrides with a required
reason, audited, and can be reverted to the shipped value. Firms cannot
override parameters; they only set safe-harbor default, disclaimer and
portal view. "Mark verified" on a row (and "Verify all unverified" per
year, or per state and year, after a confirmation) records the CPA
sign-off: status verified plus who, when and an optional note, audited.
Nothing else changes; a verified row can still be overridden with a
reason (the new value starts unverified). A verification survives
releases while the shipped value is unchanged.

## AI parameter check (super admin)

On Admin -> Tax parameters the "AI check" column asks Claude to confirm a
federal parameter or state rule from government sources only (irs.gov,
U.S. Code, eCFR, Federal Register, govinfo, congress.gov, ssa.gov and the
state's revenue department / statutes). "Check" does one row; "AI check
unverified" does every unverified row of a federal year or one state-year
as a background run with progress and Cancel. Needs AI on and an Anthropic
API key in Admin -> AI (otherwise the buttons are disabled with the
reason); each row uses Anthropic usage on that key. Results: matches,
differs, unconfirmed (no confirming government text found) or error, with
date and a "stale" flag if the value changed since. The drawer shows the
quote, source link, tax year and reasoning. The app re-checks the answer
(trusted and actually retrieved source, quote present in that page, right
tax year, app-side value compare); failures show as unconfirmed. Advisory
only: it never changes values or marks anything verified. "Apply AI
value" on a differs result saves an audited override (optionally with the
AI source as citation) that stays unverified until a super admin checks
the source and uses Mark verified. No client data is sent to the AI.

## Version 1 limits (say so when asked)

Withholding treated as even; no QBI loss carryforward across years; when
a person's retirement plan type is not recorded the limit is figured as a
SEP (with a warning), and a solo 401(k)/SIMPLE without a recorded
employee deferral assumes the maximum deferral; Social Security wages
left blank default to box 1 (warning with the possible SE overstatement);
unrecaptured section 1250 gain, collectibles gain and an AMT flag have no
input in v1 (AMT is not modeled); charitable
60 percent AGI and mortgage-interest limits not applied; MAGI = AGI for
phase-outs; nonresident state tax is an effective-rate estimate (sourced
income times a user-entered rate, not the ratio-of-return method many
states use); state penalty add-ons that compound or run per month are
noted, not computed; C corporation short years and Form 2220 annualized
installments are not modeled; some parameters and state rules are still
unverified; the earned income credit, the 3+ children additional child
tax credit alternative, employer dependent-care benefits and state
exemption phase-outs are not computed, and head of household is not
chosen automatically. Outside businesses (entered by hand): every
year-to-date amount is treated as recurring, the annualized-income
periods use an even monthly spread (full year) or a straight proration of
the year to date, and their period figures are not frozen by the
Schedule AI period snapshots. The estimator does not give legal or tax advice; the preparer
is responsible for the figures.
