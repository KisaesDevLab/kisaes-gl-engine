// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Single source of truth for the account-password length policy.
 *
 * Before this existed the minimum had drifted: admin-created users and
 * admin password resets required 12 characters while self-service
 * register / reset / change-password and the client portal still accepted
 * 8, so the UI told different users different rules and the stricter
 * screens rejected passwords the weaker screens had just accepted. Every
 * schema and every screen now reads these constants.
 *
 * Raising the minimum only affects password ENTRY. Login does not
 * re-validate length, so existing shorter passwords keep working until
 * their owner next changes one.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Validation-error wording; also the on-screen requirement text. */
export const PASSWORD_MIN_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
export const PASSWORD_MAX_MESSAGE = `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer`;

/** Short form for input placeholders. */
export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters`;
