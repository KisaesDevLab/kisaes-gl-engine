// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_MESSAGE,
  PASSWORD_MAX_MESSAGE,
} from '../constants/password-policy.js';

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE)
    .max(PASSWORD_MAX_LENGTH, PASSWORD_MAX_MESSAGE),
  displayName: z.string().min(1, 'Display name is required').max(255),
  companyName: z.string().min(1, 'Company name is required').max(255),
  businessType: z.string().optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE)
    .max(PASSWORD_MAX_LENGTH, PASSWORD_MAX_MESSAGE),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE)
    .max(PASSWORD_MAX_LENGTH, PASSWORD_MAX_MESSAGE),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});
