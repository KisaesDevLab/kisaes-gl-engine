// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Memo beneath the portal Profit & Loss: bank feed items dated inside the
 * report range that the bookkeeper has not posted yet. It is bank activity,
 * not profit or loss — transfers, card payments and owner draws are in it
 * too — so it is never folded into the statement's totals.
 *
 * Sent to every contact who can open the P&L (owner decision, 2026-11-26):
 * it is totals only, with no descriptions, payees or account names.
 */
export interface PortalUnpostedBankFeed {
  /** Open (pending or assigned) feed items dated inside the report range. */
  count: number;
  /** Deposits and other money in. */
  moneyIn: number;
  /** Payments and other money out. */
  moneyOut: number;
  /** moneyIn + moneyOut — gross activity, never netted. */
  amount: number;
}
