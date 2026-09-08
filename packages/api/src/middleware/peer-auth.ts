// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { verifyPeerToken, recordPeerError, type PeerClaims, type PeerRow } from '../services/peer-token.service.js';
import { resolveLink, type ResolvedPeerLink } from '../services/peer-portal.service.js';

// Vibe Practice Management peer auth (docs/vibe-pm-integration.md).
// Server-to-server only: a signed bearer token from PM, never a cookie,
// never a browser. Three composable pieces:
//
//   peerAuth          verifies the token → req.peer / req.peerClaims
//   requirePeerLink   pm_client_id → pm_client_links row → req.peerLink
//                     AND a synthetic req.portalContact so the existing
//                     portal routers run unchanged for the linked contact
//   peerCompanyScope  forces query/JSON companyId to the link's company
//
// `scopedCompanyId` is the in-handler twin of peerCompanyScope for the
// places a router reads companyId after mount-time middleware ran
// (multipart bodies parsed by multer inside the handler).

declare global {
  namespace Express {
    interface Request {
      peer?: PeerRow;
      peerClaims?: PeerClaims;
      peerLink?: ResolvedPeerLink;
    }
  }
}

export async function peerAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // A browser always sends Origin on cross-site requests; PM's server
  // never does. Refusing it up front means a leaked token pasted into a
  // web page is useless here.
  if (req.headers.origin !== undefined) {
    throw AppError.unauthorized('Peer token invalid', 'PEER_TOKEN_INVALID');
  }
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw AppError.unauthorized('Peer token invalid', 'PEER_TOKEN_INVALID');
  const result = await verifyPeerToken(match[1]!.trim());
  req.peer = result.peer;
  req.peerClaims = result.claims;
  next();
}

export async function requirePeerLink(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.peerLink) return next();
  if (!req.peer || !req.peerClaims) throw AppError.unauthorized('Peer token invalid', 'PEER_TOKEN_INVALID');
  const pmClientId = req.peerClaims.pm_client_id;
  if (!pmClientId) throw AppError.badRequest('This endpoint needs a pm_client_id claim', 'PEER_CLIENT_ID_REQUIRED');

  const link = await resolveLink(req.peer.firmId, pmClientId);
  if (!link) {
    void recordPeerError(req.peer.id, 'no_link');
    throw new AppError(404, 'No MyBooks client is linked to this PM client', 'PM_LINK_NOT_FOUND');
  }
  req.peerLink = link;
  req.portalContact = {
    sessionId: `peer:${req.peerClaims.jti}`,
    contactId: link.contactId,
    tenantId: link.tenantId,
    identityId: null,
    email: link.contact.email,
    firstName: link.contact.firstName,
    lastName: link.contact.lastName,
    isPreview: false,
    viaPeer: true,
  };

  // One audit row per token (every token is single-use). The actor is
  // whoever was signed in to PM — audit context only, never a user id.
  void auditLog(link.tenantId, 'login', 'portal_peer_access', link.contactId, null, {
    issuer: req.peer.issuer,
    firmId: req.peer.firmId,
    pmClientId,
    actor: req.peerClaims.actor ?? null,
    jti: req.peerClaims.jti,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    companyId: link.companyId,
  }).catch(() => { /* audit is best-effort here */ });

  next();
}

/**
 * Resolve the company a peer request may act on. With a peer link the
 * link's company is the only answer: a supplied id that differs is a
 * 400 (PM bug — it should never mix clients), a missing one is filled
 * in. Without a peer link (cookie session) the supplied value passes
 * through untouched so the existing portal code path is identical.
 */
export function scopedCompanyId(req: Request, supplied: string | undefined | null): string | undefined {
  const link = req.peerLink;
  if (!link) return supplied ?? undefined;
  if (supplied && supplied !== link.companyId) {
    throw AppError.badRequest('companyId does not match the linked client', 'PEER_COMPANY_MISMATCH');
  }
  return link.companyId;
}

export function peerCompanyScope(req: Request, _res: Response, next: NextFunction): void {
  const link = req.peerLink;
  if (!link) throw new AppError(404, 'No MyBooks client is linked to this PM client', 'PM_LINK_NOT_FOUND');
  const q = req.query as Record<string, unknown>;
  const qc = q['companyId'];
  if (qc !== undefined && qc !== link.companyId) {
    throw AppError.badRequest('companyId does not match the linked client', 'PEER_COMPANY_MISMATCH');
  }
  q['companyId'] = link.companyId;
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const body = req.body as Record<string, unknown>;
    const bc = body['companyId'];
    if (bc !== undefined && bc !== link.companyId) {
      throw AppError.badRequest('companyId does not match the linked client', 'PEER_COMPANY_MISMATCH');
    }
    body['companyId'] = link.companyId;
  }
  next();
}

/** Rate-limit key: per linked contact for peer traffic, per IP otherwise. */
export function portalLimiterKey(req: Request): string {
  if (req.peerLink && req.peer) return `peer:${req.peer.firmId}:${req.peerLink.contactId}`;
  return req.ip || 'unknown';
}
