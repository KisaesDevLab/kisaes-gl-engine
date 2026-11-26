// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Memo beneath the portal Profit & Loss: bank feed items dated inside the
 * report range that the bookkeeper has not posted yet. It is bank activity,
 * not profit or loss — transfers, card payments and owner draws are in it
 * too — so it is never folded into the statement's totals.
 *
 * Present on the portal P&L response only when the contact has banking
 * access for the company; a contact given the P&L alone does not get it.
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
