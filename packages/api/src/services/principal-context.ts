// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Agent principals (U-297, agent-principal-v1).
 *
 * An agent is a `users` row with user_type 'agent': a no-login principal the
 * engine mints, with its one API key, when a signed-in human admin creates an
 * MCP connection (services/agent-principal.service.ts). Its kind travels in
 * `req.principalKind` and in this AsyncLocalStorage store, never in
 * `req.userType` (which stays 'staff', so every staff and template path
 * resolves as before). Code far from the request reads the store:
 *   - the audit writer stamps `origin` ('mcp:<agent user id>') and
 *     `action_id` on the agent's rows (middleware/audit.ts);
 *   - the owner-only powers (Q-332: users and roles, the closing date and its
 *     password, backup / restore / export) answer false for an agent even
 *     with an owner role (`isAgentPrincipal`).
 *
 * Human requests run with no store, exactly as before.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';

export type PrincipalKind = 'human' | 'agent';

export interface PrincipalContext {
  kind: PrincipalKind;
  userId: string;
  /** Agent only: 'mcp:<agent user id>'. */
  origin: string | null;
  /** The agent action this request belongs to, once validated (U-300). */
  actionId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      /** 'agent' for an agent user's API key (U-297); unset for everyone else. */
      principalKind?: PrincipalKind;
      /** Agent only: the audit origin ('mcp:<agent user id>'). */
      principalOrigin?: string;
      /** Agent only: the validated action id (set by setPrincipalActionId). */
      principalActionId?: string;
    }
  }
}

const storage = new AsyncLocalStorage<PrincipalContext>();

/** The audit origin of an agent user: its connection id is its user id. */
export function agentOrigin(agentUserId: string): string {
  return `mcp:${agentUserId}`;
}

/** Runs `fn` with `ctx` as the current principal. */
export function runWithPrincipal<T>(ctx: PrincipalContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current principal (agent requests and the jobs that copy them), if any. */
export function currentPrincipal(): PrincipalContext | undefined {
  return storage.getStore();
}

/** A copy of the current principal, for a background job to run under (`runWithPrincipal`). */
export function capturePrincipal(): PrincipalContext | undefined {
  const s = storage.getStore();
  return s ? { ...s } : undefined;
}

/**
 * True when the request (or, without one, the current async context) is an
 * agent principal. Both are checked so a guard holds even where a parser
 * lost the async context.
 */
export function isAgentPrincipal(req?: { principalKind?: PrincipalKind }): boolean {
  return req?.principalKind === 'agent' || storage.getStore()?.kind === 'agent';
}

/** Runs the rest of the request in the agent's store; a no-op for everyone else. */
export function runAsPrincipal(req: Request, next: () => void): void {
  if (req.principalKind !== 'agent') {
    next();
    return;
  }
  runWithPrincipal({
    kind: 'agent',
    userId: req.userId,
    origin: req.principalOrigin ?? agentOrigin(req.userId),
    actionId: req.principalActionId ?? null,
  }, next);
}

/**
 * Names the agent action the rest of this request belongs to. For the U-300
 * gate, after it has checked the action against the agent's own rows; never
 * from a header alone. Throws for a non-agent request.
 */
export function setPrincipalActionId(req: Request, actionId: string): void {
  if (req.principalKind !== 'agent') throw new Error('setPrincipalActionId: not an agent request');
  req.principalActionId = actionId;
  const s = storage.getStore();
  if (s && s.kind === 'agent' && s.userId === req.userId) s.actionId = actionId;
}

/** Audit columns for the current principal: both null for a human. */
export function auditPrincipalColumns(): { origin: string | null; actionId: string | null } {
  const s = storage.getStore();
  if (!s || s.kind !== 'agent') return { origin: null, actionId: null };
  return { origin: s.origin, actionId: s.actionId };
}

export const AGENT_NOT_ALLOWED = 'AGENT_NOT_ALLOWED';

/** 403 AGENT_NOT_ALLOWED: a Q-332 power an AI connection never has. */
export function agentNotAllowed(): AppError {
  return AppError.forbidden('An AI connection cannot do this. Ask a person with Admin rights.', AGENT_NOT_ALLOWED);
}

/** Router or route guard: refuses agent principals (403 AGENT_NOT_ALLOWED). Mount after authenticate. */
export function refuseAgentPrincipal(req: Request, _res: Response, next: NextFunction): void {
  if (isAgentPrincipal(req)) throw agentNotAllowed();
  next();
}
