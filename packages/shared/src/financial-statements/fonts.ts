// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Curated, freely-licensed (SIL OFL 1.1) fonts embedded into
// financial-statement PDFs. Files live in packages/api/assets/fs-fonts.
// Word/Excel exports name `msEquivalent` so the document opens in the
// familiar Office font (Liberation/Carlito/Caladea are metric-compatible
// with Times New Roman/Arial/Calibri/Cambria, so line breaks match).

export const FS_FONT_KEYS = [
  'liberation_serif', 'liberation_sans', 'carlito', 'caladea',
  'eb_garamond', 'source_serif', 'lato', 'libre_baskerville',
] as const;
export type FsFontKey = (typeof FS_FONT_KEYS)[number];

export interface FsFontFace {
  file: string;
  weight: string; // CSS font-weight (a range for variable fonts)
  style: 'normal' | 'italic';
}

export interface FsFontDef {
  key: FsFontKey;
  label: string;
  category: 'serif' | 'sans-serif';
  // Family name used in CSS (@font-face) — prefixed so it never collides
  // with a system font of the same name in the browser preview.
  cssFamily: string;
  msEquivalent: string;
  faces: FsFontFace[];
  // Face used by pdf-lib for the page footer / page numbers.
  footerFile: string;
}

const staticFaces = (prefix: string): FsFontFace[] => [
  { file: `${prefix}-Regular.ttf`, weight: '400', style: 'normal' },
  { file: `${prefix}-Bold.ttf`, weight: '700', style: 'normal' },
  { file: `${prefix}-Italic.ttf`, weight: '400', style: 'italic' },
  { file: `${prefix}-BoldItalic.ttf`, weight: '700', style: 'italic' },
];

const variableFaces = (prefix: string, range: string): FsFontFace[] => [
  { file: `${prefix}-VF.ttf`, weight: range, style: 'normal' },
  { file: `${prefix}-Italic-VF.ttf`, weight: range, style: 'italic' },
];

export const FS_FONTS: readonly FsFontDef[] = [
  { key: 'liberation_serif', label: 'Times New Roman (Liberation Serif)', category: 'serif', cssFamily: 'FS Liberation Serif', msEquivalent: 'Times New Roman', faces: staticFaces('LiberationSerif'), footerFile: 'LiberationSerif-Regular.ttf' },
  { key: 'liberation_sans', label: 'Arial (Liberation Sans)', category: 'sans-serif', cssFamily: 'FS Liberation Sans', msEquivalent: 'Arial', faces: staticFaces('LiberationSans'), footerFile: 'LiberationSans-Regular.ttf' },
  { key: 'carlito', label: 'Calibri (Carlito)', category: 'sans-serif', cssFamily: 'FS Carlito', msEquivalent: 'Calibri', faces: staticFaces('Carlito'), footerFile: 'Carlito-Regular.ttf' },
  { key: 'caladea', label: 'Cambria (Caladea)', category: 'serif', cssFamily: 'FS Caladea', msEquivalent: 'Cambria', faces: staticFaces('Caladea'), footerFile: 'Caladea-Regular.ttf' },
  { key: 'eb_garamond', label: 'Garamond (EB Garamond)', category: 'serif', cssFamily: 'FS EB Garamond', msEquivalent: 'Garamond', faces: variableFaces('EBGaramond', '400 800'), footerFile: 'EBGaramond-VF.ttf' },
  { key: 'source_serif', label: 'Georgia-style (Source Serif 4)', category: 'serif', cssFamily: 'FS Source Serif', msEquivalent: 'Georgia', faces: variableFaces('SourceSerif4', '200 900'), footerFile: 'SourceSerif4-VF.ttf' },
  { key: 'lato', label: 'Lato', category: 'sans-serif', cssFamily: 'FS Lato', msEquivalent: 'Calibri', faces: staticFaces('Lato'), footerFile: 'Lato-Regular.ttf' },
  { key: 'libre_baskerville', label: 'Baskerville (Libre Baskerville)', category: 'serif', cssFamily: 'FS Libre Baskerville', msEquivalent: 'Baskerville Old Face', faces: variableFaces('LibreBaskerville', '400 700'), footerFile: 'LibreBaskerville-VF.ttf' },
];

export function fsFont(key: string | null | undefined): FsFontDef {
  return FS_FONTS.find((f) => f.key === key) ?? FS_FONTS[0]!;
}

// Every file the public font route may serve.
export const FS_FONT_FILES: ReadonlySet<string> = new Set(FS_FONTS.flatMap((f) => f.faces.map((x) => x.file)));
