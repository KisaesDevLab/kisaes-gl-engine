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
- **Persons**: the people on the return; one primary; months eligible for
  self-employed health insurance.
- **Links**: person x company x tax year with profit/loss/capital %,
  partner SE status, activity type (active, passive, rental, investment),
  active participation (for the $25,000 rental allowance), QBI eligibility
  and an allowed-loss override.
- **Entity tax setup** (per company): entity type (from the Trial Balance
  tax profile), tax method, state sourcing, SSTB/large-corp/farmer flags,
  W-2 wages override and UBIA, and the GL tax treatment table that says
  what each profit and loss account means for tax. Suggestions are never
  applied automatically. Unmapped accounts with activity are treated as
  ordinary with a warning.
- **Annual settings** (per taxpayer and year): deduction method, federal
  method (bracket or effective-rate override), credits, withholding,
  Schedule 1-A, HSA, prior-year tax and AGI (stored encrypted), state rows
  (one resident state), firm settings (safe-harbor default, disclaimer,
  portal view).
- **Scenarios and adjustments**: Base plus clones; adjustments cover
  anything outside the books and are spread evenly over remaining quarters.

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
Pack that has the Tax Estimate section each freeze an immutable snapshot
(never edited or deleted; finalize a new one). A snapshot can be compared
with live to see changed figures, new or resolved warnings and parameter
changes. The PDF equals the screen. The Report Pack section is "Tax
Estimate" in group Tax; pick the taxpayer (and optionally scenario) in the
section options.

## Client portal

Portal contacts see a read-only Tax estimate tile and page (projected
total, next payments with due dates, paid and withheld, payments on
record, vouchers PDF, disclaimer) only when: the portal and the Tax
Estimator flags are on for the client's tenant, the contact is linked to
the taxpayer (taxpayer page -> Portal contacts), the taxpayer links the
year to a company of that tenant whose portal access has "Tax estimates"
ticked (Practice -> Client Portal), and the year has settings. The
portal shows the live estimate by default; the firm or the taxpayer can
switch it to the latest finalized snapshot. Clients never see persons,
other owners, adjustments, traces, parameters or prior-year figures.

## Super admin

Admin -> Tax parameters edits federal parameters per tax year and the
state rules for 50 states plus DC; changes are overrides with a required
reason, audited, and can be reverted to the shipped value. Firms cannot
override parameters; they only set safe-harbor default, disclaimer and
portal view.

## Version 1 limits (say so when asked)

Quarterly adjustments spread evenly; withholding treated as even; no QBI
loss carryforward across years; retirement plan assumed SEP; charitable
60 percent AGI and mortgage-interest limits not applied; MAGI = AGI for
phase-outs; nonresident state tax is an effective-rate estimate (sourced
income times a user-entered rate, not the ratio-of-return method many
states use); state penalty add-ons that compound or run per month are
noted, not computed; C corporation short years and Form 2220 annualized
installments are not modeled; some parameters and state rules are still
unverified. The estimator does not give legal or tax advice; the preparer
is responsible for the figures.
