// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { UserType } from '../constants/user-types.js';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string | null;
  role: string;
  // Added in VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 1. Optional in the
  // wire type so stale clients hitting a new server tolerate the
  // missing field — the sidebar guard treats undefined as 'staff'.
  userType?: UserType;
  isActive: boolean;
  isSuperAdmin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface LoginInput {
  email: string;
  password: string;
  /** Cloudflare Turnstile response token from the login widget. Empty when Turnstile is server-disabled. */
  turnstileToken?: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  companyName: string;
  businessType?: string;
  /** Cloudflare Turnstile response token from the signup widget. Empty when Turnstile is server-disabled. */
  turnstileToken?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: string;
  isSuperAdmin?: boolean;
  impersonating?: string; // original admin userId when impersonating
}

export interface ForgotPasswordInput {
  email: string;
}

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}
