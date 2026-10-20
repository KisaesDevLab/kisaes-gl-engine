// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// ─── Equity roles (U-55, equity-roles-v1) ───────────────────────
//
// The owner-money accounts a small business uses, resolved by ROLE through
// `accounts.system_tag` like every other system role. Which roles a company
// needs depends on its entity type: a sole proprietor draws and contributes,
// partners take draws, an S corporation pays distributions, and so on.
//
// Unlike the control accounts (A/R, A/P, Payments Clearing), these are
// ordinary categories: an owner's draw is a normal target for a bank-feed
// categorization or a client's suggestion. EQUITY_ROLE_TAGS lists the tags
// that stay usable as a category even though they carry a system_tag.
//
// Accounts the engine creates for a role are system accounts (is_system,
// like the daily-sales role accounts): protected from deletion and type
// changes, still renameable. An adopted account keeps its own flag. A
// missing role resolves to null.

import type { entityTypes } from '../schemas/company.js';

type EntityType = (typeof entityTypes)[number];

export const EQUITY_ROLE_TAGS = [
  'owner_draw',
  'owner_contribution',
  'partner_draws',
  'partner_contributions',
  'shareholder_distributions',
  'paid_in_capital',
] as const;
export type EquityRoleTag = (typeof EQUITY_ROLE_TAGS)[number];

/** Every role GET /company/equity-roles reports (retained earnings included). */
export const EQUITY_ROLE_REPORT_TAGS = [...EQUITY_ROLE_TAGS, 'retained_earnings'] as const;

export interface EquityRoleSpec {
  systemTag: EquityRoleTag;
  name: string;
  accountNumber: string;
  detailType: string;
  /** Untagged equity accounts this role adopts instead of adding a twin (lower-case names). */
  adoptNames: string[];
  /** Account numbers it adopts (the built-in templates seed 30160 / 30170). */
  adoptAccountNumbers: string[];
}

export const EQUITY_ROLE_SPECS: Record<EquityRoleTag, EquityRoleSpec> = {
  owner_draw: {
    systemTag: 'owner_draw', name: "Owner's Draw", accountNumber: '30170', detailType: 'owners_equity',
    adoptAccountNumbers: ['30170'],
    adoptNames: ['owner withdraw', 'owner withdrawal', 'owner withdrawals', "owner's draw", 'owner draw', 'owners draw', 'owner draws', "owner's draws"],
  },
  owner_contribution: {
    systemTag: 'owner_contribution', name: "Owner's Contribution", accountNumber: '30160', detailType: 'owners_equity',
    adoptAccountNumbers: ['30160'],
    adoptNames: ['owner contribution', "owner's contribution", 'owners contribution', 'owner contributions', "owner's contributions"],
  },
  partner_draws: {
    systemTag: 'partner_draws', name: 'Partner Draws', accountNumber: '30180', detailType: 'owners_equity',
    adoptAccountNumbers: [],
    adoptNames: ['partner draws', 'partner draw', "partners' draws", 'partners draws', 'partner distributions'],
  },
  partner_contributions: {
    systemTag: 'partner_contributions', name: 'Partner Contributions', accountNumber: '30190', detailType: 'owners_equity',
    adoptAccountNumbers: [],
    adoptNames: ['partner contributions', 'partner contribution', "partners' contributions", 'partners contributions'],
  },
  shareholder_distributions: {
    systemTag: 'shareholder_distributions', name: 'Shareholder Distributions', accountNumber: '30200', detailType: 'owners_equity',
    adoptAccountNumbers: [],
    adoptNames: ['shareholder distributions', 'shareholder distribution', 'distributions', 'dividends paid', 'dividends'],
  },
  paid_in_capital: {
    systemTag: 'paid_in_capital', name: 'Paid-in Capital', accountNumber: '30140', detailType: 'owners_equity',
    adoptAccountNumbers: [],
    adoptNames: ['paid-in capital', 'paid in capital', 'additional paid-in capital', 'additional paid in capital', 'common stock', 'capital stock'],
  },
};

/**
 * Roles seeded for each entity type, with the account name used when the
 * role is created for that type. A C corporation's distributions are
 * dividends, so its shareholder_distributions account is "Dividends Paid".
 */
export const EQUITY_ROLES_BY_ENTITY_TYPE: Record<EntityType, Array<{ tag: EquityRoleTag; name: string }>> = {
  sole_prop: [
    { tag: 'owner_draw', name: "Owner's Draw" },
    { tag: 'owner_contribution', name: "Owner's Contribution" },
  ],
  single_member_llc: [
    { tag: 'owner_draw', name: "Owner's Draw" },
    { tag: 'owner_contribution', name: "Owner's Contribution" },
  ],
  partnership: [
    { tag: 'partner_draws', name: 'Partner Draws' },
    { tag: 'partner_contributions', name: 'Partner Contributions' },
  ],
  s_corp: [
    { tag: 'shareholder_distributions', name: 'Shareholder Distributions' },
    { tag: 'paid_in_capital', name: 'Paid-in Capital' },
  ],
  c_corp: [
    { tag: 'paid_in_capital', name: 'Paid-in Capital' },
    { tag: 'shareholder_distributions', name: 'Dividends Paid' },
  ],
};

export function isEquityRoleTag(tag: string | null | undefined): tag is EquityRoleTag {
  return !!tag && (EQUITY_ROLE_TAGS as readonly string[]).includes(tag);
}
