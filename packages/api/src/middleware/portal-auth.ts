// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import * as portalAuth from '../services/portal-auth.service.js';
import { AppError } from '../utils/errors.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 9.9 + 8.4 — portal auth.
// Distinct from staff `authenticate`. Two cookie variants:
//   • kisbooks_portal_session — real contact session (magic-link)
//   • kisbooks_portal_preview — staff impersonation token (8.4)
// When a preview token is present it takes precedence and the
// request runs in simulated mode (req.portalContact.isPreview=true).

declare global {
  namespace Express {
    interface Request {
      portalContact?: {
        sessionId: string;
        contactId: string;
        tenantId: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        /** True when the request is running inside a "View as Client"
         *  preview. Mutation services consult this flag and short-
         *  circuit any write that would touch live tables. */
        isPreview: boolean;
        /** Set on preview requests — staff user id of the initiator,
         *  for audit and to re-validate role on every hit. */
        previewInitiatorId?: string;
        /** preview_sessions.id — used to end the session on logout. */
        previewSessionId?: string;
        /** Active company scope. For real sessions the contact may
         *  switch companies via UI; for previews this is fixed. */
        previewCompanyId?: string;
      };
    }
  }
}

export const PORTAL_SESSION_COOKIE = 'kisbooks_portal_session';
export const PORTAL_PREVIEW_COOKIE = 'kisbooks_portal_preview';

function readCookie(req: Request, name: string): string {
  const cookieHeader = req.headers.cookie ?? '';
  const match = cookieHeader
    .split(';')
    .map((s) => s.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

export async function portalAuthenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  // Preview takes precedence — staff impersonation.
  const previewToken = readCookie(req, PORTAL_PREVIEW_COOKIE);
  if (previewToken) {
    try {
      const payload = portalAuth.verifyPreviewToken(previewToken);
      // Hydrate contact details for parity with real sessions so the
      // portal layout / question views render the right name + email.
      // We bypass the session table — preview never touches it.
      const contact = await import('../db/index.js').then(async (m) => {
        const { portalContacts } = await import('../db/schema/index.js');
        const { eq } = await import('drizzle-orm');
        return m.db.query.portalContacts.findFirst({
          where: eq(portalContacts.id, payload.contactId),
        });
      });
      if (!contact) throw AppError.unauthorized('Preview contact not found');

      req.portalContact = {
        sessionId: `preview:${payload.previewSessionId}`,
        contactId: payload.contactId,
        tenantId: payload.tenantId,
        email: contact.email,
        firstName: contact.firstName,
        lastName: contact.lastName,
        isPreview: true,
        previewInitiatorId: payload.initiatingUserId,
        previewSessionId: payload.previewSessionId,
        previewCompanyId: payload.companyId,
      };
      next();
      return;
    } catch (err) {
      next(err);
      return;
    }
  }

  // Real session.
  const token = readCookie(req, PORTAL_SESSION_COOKIE);
  try {
    const session = await portalAuth.resolveSession(token);
    req.portalContact = {
      sessionId: session.sessionId,
      contactId: session.contactId,
      tenantId: session.tenantId,
      email: session.contact.email,
      firstName: session.contact.firstName,
      lastName: session.contact.lastName,
      isPreview: false,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Guard for write endpoints — refuse to mutate live state during preview. */
export function refuseDuringPreview(req: Request): void {
  if (req.portalContact?.isPreview) {
    throw AppError.forbidden(
      'Action disabled in preview mode',
      'PREVIEW_READ_ONLY',
    );
  }
}
