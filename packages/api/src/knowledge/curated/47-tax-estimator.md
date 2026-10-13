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
