// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// POST /api/v1/document-reading/assist (U-92d, document-assist-v1): a client
// that already read a document sends its text (and optionally up to three
// page images) and gets field suggestions back. Nothing is stored or posted.

import { z } from 'zod';
import { DOCUMENT_DRAFT_KINDS } from './document-drafts.js';

/** At most this many page images per request. */
export const DOCUMENT_ASSIST_MAX_IMAGES = 3;
/** The decoded page images together are at most this many bytes (2 MiB). */
export const DOCUMENT_ASSIST_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** The page text is at most this many characters (about 10 dense pages). */
export const DOCUMENT_ASSIST_MAX_TEXT_CHARS = 60_000;

// The schema bounds the shapes only; the limits above are checked by the
// route so each refusal has its own code (TEXT_TOO_LONG, TOO_MANY_IMAGES,
// IMAGES_TOO_LARGE, IMAGE_NOT_PNG, NOTHING_TO_READ). The string caps here
// only stop an absurd body before it is decoded.
export const documentAssistRequestSchema = z.object({
  text: z.string().max(DOCUMENT_ASSIST_MAX_TEXT_CHARS * 4)
    .describe(`the document's page text as the client read it, at most ${DOCUMENT_ASSIST_MAX_TEXT_CHARS} characters (else 400 TEXT_TOO_LONG); may be empty when pageImages are sent`),
  pageImages: z.array(z.string().max(4 * 1024 * 1024)).max(16).optional()
    .describe(`page images as base64 PNG (no data: prefix), at most ${DOCUMENT_ASSIST_MAX_IMAGES} (else 400 TOO_MANY_IMAGES) and ${DOCUMENT_ASSIST_MAX_IMAGE_BYTES} decoded bytes together (else 400 IMAGES_TOO_LARGE); anything that is not a PNG is 400 IMAGE_NOT_PNG`),
  kindHint: z.enum(DOCUMENT_DRAFT_KINDS).optional().default('unknown')
    .describe('what the client thinks the document is; only steers the prompt'),
});
export type DocumentAssistRequest = z.infer<typeof documentAssistRequestSchema>;
