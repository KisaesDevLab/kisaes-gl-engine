// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// ADR 0XY §2 — single pure resolver for the default-tag precedence chain.
// Keep it synchronous and free of DB access: callers pre-load the four
// context fields (item default, contact default, bank rule tag, AI
// suggestion) and the resolver walks a fixed ordering. The resolved
// decision chain is:
//
//   1. explicit user entry    (wins even when explicitly null)
//   2. bank-rule tag          (strongest non-user source)
//   3. AI-suggested tag       (§3.4 precedence 2.5)
//   4. item default tag
//   5. contact default tag    (only populated for vendor contacts)
//   6. null                   (no default)
//
// "Explicit user entry" is three-state: undefined means "user has not
// touched this field yet, resolver may fill in." null means "user
// cleared it on purpose, leave it cleared." A string value is a user's
// affirmative choice. Callers are responsible for setting undefined
// vs null correctly — that decision cannot be reconstructed here.

export interface DefaultTagContext {
  /**
   * Three-state user entry.
   *   undefined → user has not touched this field yet
   *   null      → user explicitly cleared the tag
   *   string    → user affirmatively chose this tag
   */
  explicitUserTagId?: string | null | undefined;

  /** Tag stamped by a matched bank rule, or undefined if no rule matched. */
  bankRuleTagId?: string | null | undefined;

  /** AI-suggested tag for this line, or undefined if no suggestion. */
  aiSuggestedTagId?: string | null | undefined;

  /** `items.default_tag_id` for the line's item, if any. */
  itemDefaultTagId?: string | null | undefined;

  /**
   * `contacts.default_tag_id` for the header contact, if and only if the
   * contact is a vendor (or 'both'). Customer-only contacts do not feed
   * this resolver per ADR 0XY §2.1.
   */
  contactDefaultTagId?: string | null | undefined;
}

function defined<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

export function resolveDefaultTag(ctx: DefaultTagContext): string | null {
  // Explicit user entry wins — including an explicit null.
  if (ctx.explicitUserTagId !== undefined) {
    return ctx.explicitUserTagId;
  }
  if (defined(ctx.bankRuleTagId))     return ctx.bankRuleTagId;
  if (defined(ctx.aiSuggestedTagId))  return ctx.aiSuggestedTagId;
  if (defined(ctx.itemDefaultTagId))  return ctx.itemDefaultTagId;
  if (defined(ctx.contactDefaultTagId)) return ctx.contactDefaultTagId;
  return null;
}
