// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export type ThemeMode = 'light' | 'dark' | 'system';
export type FontScaleLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const FONT_SCALE_VALUES: Record<FontScaleLevel, number> = {
  1: 0.8125,  // 13px
  2: 0.875,   // 14px
  3: 1,       // 16px (default)
  4: 1.125,   // 18px
  5: 1.25,    // 20px
  6: 1.375,   // 22px
  7: 1.5,     // 24px
};

export const FONT_SCALE_LABELS: Record<FontScaleLevel, string> = {
  1: 'XS',
  2: 'S',
  3: 'M',
  4: 'L',
  5: 'XL',
  6: '2XL',
  7: '3XL',
};

export interface DisplayPreferences {
  fontScale: number;
  theme: ThemeMode;
}
