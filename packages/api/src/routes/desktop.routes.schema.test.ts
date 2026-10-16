// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
import { describe, it, expect } from 'vitest';
import { PASSWORD_MIN_LENGTH } from '@kis-books/shared';
import { desktopInitializeSchema } from './desktop.routes.js';

const body = (password: string) => ({ admin: { email: 'o@example.com', displayName: 'O', password } });
const ok = (password: string) => desktopInitializeSchema.safeParse(body(password)).success;

describe('desktop /initialize password rule', () => {
  it('uses the shared minimum length', () => {
    expect(ok('x'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false);
    expect(ok('x'.repeat(PASSWORD_MIN_LENGTH))).toBe(true);
  });

  it('refuses more than 72 bytes (bcrypt would truncate), counting UTF-8 bytes', () => {
    expect(ok('x'.repeat(72))).toBe(true);
    expect(ok('x'.repeat(73))).toBe(false);
    expect(ok('€'.repeat(24))).toBe(true); // 72 bytes
    expect(ok('€'.repeat(25))).toBe(false); // 75 bytes, 25 characters
  });
});
