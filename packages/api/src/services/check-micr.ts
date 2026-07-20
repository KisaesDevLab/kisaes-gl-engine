// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// E-13B MICR line rendering for check printing.
//
// The 14 MICR characters (digits 0-9 + Transit, Amount, On-Us, Dash) are
// drawn as vector outlines — no font file is embedded. Glyph geometry was
// transcribed from the ISO 1004-1995 dimensioned drawings reproduced in
// Payments Canada Standard 006, Appendix I (figs 1.8.1-1.8.14): every
// character is a union of rectangles (plus the "7"'s diagonal band) on a
// 0.165 mm (0.0065") design grid, 0.117" tall, on a 0.125" pitch
// (8 characters per inch). Corner radii are 0.165 mm, except the zero
// (0.330 mm inner / 0.660 mm outer), applied at draw time.
//
// Placement follows ANSI X9.100-160-1:
//   - baseline 3/16" above the bottom edge of the check, inside a 5/8"
//     clear band that must contain nothing else;
//   - characters occupy fixed 1/8" positions numbered right-to-left,
//     position 1 ending 5/16" from the right edge of the check;
//   - Amount field (positions 1-12) is LEFT BLANK — the bank of first
//     deposit encodes it;
//   - On-Us field (14-31): account number (left-aligned at 31) followed
//     by the On-Us symbol;
//   - Transit field (33-43): Transit symbols at 43 and 33 bracketing the
//     9-digit routing number;
//   - Auxiliary On-Us (45+): check serial number bracketed by On-Us
//     symbols (documents >= 6.5" wide, which all our layouts are).
//
// NOTE: a fully compliant physical check also requires magnetic (MICR)
// toner; image-based Check 21 clearing reads the line optically, so
// regular toner works with most banks, but magnetic toner is the standard.

import type { PDFPage } from 'pdf-lib';
import { rgb } from 'pdf-lib';

// ── Glyph geometry ────────────────────────────────────────────────
//
// Coordinates are integer design units: 6000 units per inch (the grid
// unit 0.0065" = 39 units; one character cell/pitch 0.125" = 750 units).
// y is up; baseline (character bottom) at y=0; characters are 702 units
// (0.117") tall. Contours wind so the nonzero fill rule renders holes
// (the 0's counter) correctly.

export const MICR_UNITS_PER_INCH = 6000;
export const MICR_PITCH_UNITS = 750; // 0.125"
export const MICR_CHAR_HEIGHT_UNITS = 702; // 0.117"
const CORNER_RADIUS = 39; // 0.165 mm
const ZERO_RADIUS_OUTER = 156; // 0.660 mm
const ZERO_RADIUS_INNER = 78; // 0.330 mm

type Contour = Array<[number, number]>;

export const E13B_GLYPHS: Record<string, Contour[]> = {
  '0': [
    [[103, 0], [103, 702], [649, 702], [649, 0]],
    [[571, 78], [571, 624], [181, 624], [181, 78]],
  ],
  '1': [
    [[337, 0], [337, 312], [415, 312], [415, 585], [337, 585], [337, 702], [493, 702], [493, 312], [649, 312], [649, 0]],
  ],
  '2': [
    [[337, 0], [337, 390], [571, 390], [571, 624], [337, 624], [337, 702], [649, 702], [649, 312], [415, 312], [415, 78], [649, 78], [649, 0]],
  ],
  '3': [
    [[259, 0], [259, 78], [493, 78], [493, 312], [259, 312], [259, 390], [493, 390], [493, 624], [259, 624], [259, 702], [571, 702], [571, 351], [649, 351], [649, 0]],
  ],
  '4': [
    [[493, 0], [493, 156], [181, 156], [181, 702], [337, 702], [337, 234], [493, 234], [493, 312], [649, 312], [649, 0]],
  ],
  '5': [
    [[259, 0], [259, 78], [571, 78], [571, 312], [259, 312], [259, 702], [649, 702], [649, 624], [337, 624], [337, 390], [649, 390], [649, 0]],
  ],
  '6': [
    [[181, 0], [181, 702], [493, 702], [493, 507], [415, 507], [415, 624], [259, 624], [259, 312], [649, 312], [649, 0]],
    [[571, 78], [571, 234], [259, 234], [259, 78]],
  ],
  '7': [
    [[415, 377], [571, 442], [571, 624], [337, 624], [337, 468], [259, 468], [259, 702], [649, 702], [649, 390], [493, 326], [493, 0], [415, 0]],
  ],
  '8': [
    [[103, 0], [103, 351], [181, 351], [181, 702], [571, 702], [571, 351], [649, 351], [649, 0]],
    [[493, 78], [493, 312], [259, 312], [259, 78]],
    [[493, 390], [493, 624], [259, 624], [259, 390]],
  ],
  '9': [
    [[493, 0], [493, 312], [181, 312], [181, 702], [649, 702], [649, 0]],
    [[571, 390], [571, 624], [259, 624], [259, 390]],
  ],
  transit: [
    [[103, 117], [103, 585], [259, 585], [259, 117]],
    [[415, 0], [415, 234], [649, 234], [649, 0]],
    [[415, 468], [415, 702], [649, 702], [649, 468]],
  ],
  amount: [
    [[103, 0], [103, 312], [259, 312], [259, 0]],
    [[337, 527], [415, 527], [415, 176], [337, 176]],
    [[493, 390], [493, 702], [649, 702], [649, 390]],
  ],
  onus: [
    [[103, 585], [181, 585], [181, 117], [103, 117]],
    [[259, 585], [337, 585], [337, 117], [259, 117]],
    [[415, 351], [415, 663], [649, 663], [649, 351]],
  ],
  dash: [
    [[103, 195], [103, 507], [259, 507], [259, 195]],
    [[337, 195], [337, 507], [493, 507], [493, 195]],
    [[571, 507], [649, 507], [649, 195], [571, 195]],
  ],
};

// Characters accepted in a MICR line string. Symbols use single-letter
// aliases so field builders can compose plain strings.
export const MICR_TRANSIT = 't';
export const MICR_ONUS = 'o';
export const MICR_AMOUNT = 'a';
export const MICR_DASH = '-';

const CHAR_TO_GLYPH: Record<string, string> = {
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
  '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  [MICR_TRANSIT]: 'transit', [MICR_ONUS]: 'onus',
  [MICR_AMOUNT]: 'amount', [MICR_DASH]: 'dash',
};

// ── Field layout (ANSI X9.100-160-1) ──────────────────────────────

export interface MicrPlacedChar {
  /** 1-based character position counted from the right edge of the check */
  position: number;
  /** key into E13B_GLYPHS */
  glyph: string;
}

const TRANSIT_OPEN_POS = 43;
const TRANSIT_CLOSE_POS = 33;
const ONUS_FIELD_LEFT_POS = 31; // leftmost usable On-Us position
const ONUS_FIELD_RIGHT_POS = 14; // rightmost usable On-Us position
const AUX_ONUS_CLOSE_POS = 45; // rightmost char of the auxiliary field

/**
 * Compute character placements for a check's MICR line.
 * Returns [] when the routing number is unusable (never print a
 * malformed transit field — a bad MICR line is worse than none).
 */
export function layoutMicrLine(opts: {
  routingNumber: string;
  accountNumber: string;
  /** check serial number; omitted from the line when null */
  checkNumber: number | null;
}): MicrPlacedChar[] {
  const routing = (opts.routingNumber || '').replace(/\D/g, '');
  if (routing.length !== 9) return [];

  const placed: MicrPlacedChar[] = [];

  // Transit field: ⑆RRRRRRRRR⑆ at fixed positions 43..33
  placed.push({ position: TRANSIT_OPEN_POS, glyph: 'transit' });
  for (let i = 0; i < 9; i++) {
    placed.push({ position: TRANSIT_OPEN_POS - 1 - i, glyph: routing[i]! });
  }
  placed.push({ position: TRANSIT_CLOSE_POS, glyph: 'transit' });

  // On-Us field: account number left-aligned at position 31, then the
  // On-Us symbol. Dashes and spaces in the stored account number are
  // preserved (dash prints the MICR dash symbol, space leaves a gap).
  const account = (opts.accountNumber || '').replace(/[^0-9\- ]/g, '');
  if (account.length > 0) {
    // account chars + closing symbol must fit positions 31..14
    const maxChars = ONUS_FIELD_LEFT_POS - ONUS_FIELD_RIGHT_POS; // 17
    const acct = account.slice(0, maxChars);
    let pos = ONUS_FIELD_LEFT_POS;
    for (const ch of acct) {
      if (ch !== ' ') {
        placed.push({ position: pos, glyph: CHAR_TO_GLYPH[ch === '-' ? MICR_DASH : ch]! });
      }
      pos--;
    }
    placed.push({ position: pos, glyph: 'onus' });
  }

  // Auxiliary On-Us field: ⑈NNNNNN⑈ check serial, zero-padded to six
  // digits, its rightmost symbol at position 45.
  if (opts.checkNumber != null) {
    const serial = String(opts.checkNumber).replace(/\D/g, '').padStart(6, '0');
    placed.push({ position: AUX_ONUS_CLOSE_POS, glyph: 'onus' });
    for (let i = 0; i < serial.length; i++) {
      placed.push({ position: AUX_ONUS_CLOSE_POS + serial.length - i, glyph: serial[i]! });
    }
    placed.push({ position: AUX_ONUS_CLOSE_POS + serial.length + 1, glyph: 'onus' });
  }

  // Amount field (positions 1-12) intentionally left blank.
  return placed;
}

// ── Drawing ───────────────────────────────────────────────────────

/** Distance from the right edge of the check to the right edge of a
 *  character position's cell, in inches. */
export function micrPositionRightOffsetInches(position: number): number {
  return 0.3125 + (position - 1) * 0.125;
}

function roundedContourPath(contour: Contour, radius: number, flipHeight: number): string {
  // Emit an SVG path for the contour with each corner replaced by a
  // quadratic arc of the given radius (clamped to half the adjacent edge
  // lengths). SVG y runs down, so flip within flipHeight.
  const n = contour.length;
  const pts = contour.map(([x, y]) => [x, flipHeight - y] as [number, number]);
  const seg: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const lenIn = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const lenOut = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    const inDir = [(cur[0] - prev[0]) / lenIn, (cur[1] - prev[1]) / lenIn];
    const outDir = [(next[0] - cur[0]) / lenOut, (next[1] - cur[1]) / lenOut];
    const p1 = [cur[0] - inDir[0]! * r, cur[1] - inDir[1]! * r];
    const p2 = [cur[0] + outDir[0]! * r, cur[1] + outDir[1]! * r];
    const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
    seg.push(`${i === 0 ? `M ${fmt(p1[0]!)} ${fmt(p1[1]!)}` : `L ${fmt(p1[0]!)} ${fmt(p1[1]!)}`} Q ${fmt(cur[0])} ${fmt(cur[1])} ${fmt(p2[0]!)} ${fmt(p2[1]!)}`);
  }
  return seg.join(' ') + ' Z';
}

/** Build the complete SVG path (all contours) for one glyph, in design
 *  units with SVG y-down orientation. Exposed for tests. */
export function glyphSvgPath(glyphKey: string): string {
  const contours = E13B_GLYPHS[glyphKey];
  if (!contours) throw new Error(`Unknown MICR glyph: ${glyphKey}`);
  const isZeroOuter = glyphKey === '0';
  return contours
    .map((c, idx) => {
      let r = CORNER_RADIUS;
      if (isZeroOuter) r = idx === 0 ? ZERO_RADIUS_OUTER : ZERO_RADIUS_INNER;
      return roundedContourPath(c, r, MICR_CHAR_HEIGHT_UNITS);
    })
    .join(' ');
}

/**
 * Draw a MICR line onto a pdf-lib page.
 *
 * checkRightEdgeX / checkBottomY locate the physical check's right and
 * bottom edges (the tear/perforation lines, not the sheet edges) in PDF
 * points. offsetX/offsetY shift everything (printer alignment tuning).
 */
export function drawMicrLine(
  page: PDFPage,
  placed: MicrPlacedChar[],
  opts: { checkRightEdgeX: number; checkBottomY: number; offsetX?: number; offsetY?: number },
): void {
  const scale = 72 / MICR_UNITS_PER_INCH; // design units -> points
  const baselineY = opts.checkBottomY + 0.1875 * 72 + (opts.offsetY ?? 0);
  const black = rgb(0, 0, 0);
  for (const pc of placed) {
    const cellRightX = opts.checkRightEdgeX - micrPositionRightOffsetInches(pc.position) * 72 + (opts.offsetX ?? 0);
    const cellLeftX = cellRightX - MICR_PITCH_UNITS * scale;
    page.drawSvgPath(glyphSvgPath(pc.glyph), {
      x: cellLeftX,
      y: baselineY + MICR_CHAR_HEIGHT_UNITS * scale,
      scale,
      color: black,
      borderWidth: 0,
    });
  }
}
