// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * AI connections (U-297, agent-principal-v1), mounted at /api/v1/mcp-connections.
 *
 *   POST   /        {name, role, templateId?} -> 201 {connection, apiKey}: mints the agent
 *                   user and its API key in one transaction; the key is shown once.
 *   GET    /        {connections: [...]}
 *   DELETE /:id     -> {revoked: true}: keys, access and the agent user turned off.
 *
 * A signed-in human only (403 SESSION_AUTH_REQUIRED for any API key, an
 * agent's included) with team_management on the company (the owner, a super
 * admin or a delegated firm member; 403 OWNER_REQUIRED otherwise). The
 * connection's role and permission template are changed on the Team routes
 * (PATCH /company/users/:id, PUT /company/users/:id/permissions) and apply on
 * its next request.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireSessionAuth } from '../middleware/auth.js';
import { requireTenantCapability } from '../middleware/firm-capabilities.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import { refuseAgentPrincipal } from '../services/principal-context.js';
import { AGENT_ROLES, listAgentConnections, mintAgentPrincipal, revokeAgentConnection } from '../services/agent-principal.service.js';

export const mcpConnectionsRouter = Router();
mcpConnectionsRouter.use(authenticate);
mcpConnectionsRouter.use(requireSessionAuth);
mcpConnectionsRouter.use(refuseAgentPrincipal);
mcpConnectionsRouter.use((req, _res, next) => {
  if (req.userType === 'client') throw AppError.notFound('Not found');
  next();
});
mcpConnectionsRouter.use(requireTenantCapability('team_management', 'Only the Admin can manage AI connections'));

const connectionView = z.object({
  id: z.string().uuid().describe('The connection id: the agent user id (audit origin mcp:<id>).'),
  name: z.string(),
  role: z.string(),
  templateId: z.string().uuid().nullable(),
  isActive: z.boolean(),
  keyPrefix: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const createConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.enum(AGENT_ROLES),
  templateId: z.string().uuid().nullable().optional().describe('A permission template of this company; needs role bookkeeper.'),
}).strict();

mcpConnectionsRouter.post('/', validate(createConnectionSchema), describe({
  summary: 'Create an AI connection: an agent user and its API key (agent-principal-v1)',
  description: 'Session only, team_management. The key (apiKey) is returned once and never again. The agent cannot sign in; '
    + 'its role is read live on every request. 400 AGENT_TEMPLATE_ROLE when templateId is sent without role bookkeeper.',
  tags: ['mcp-connections'],
  response: z.object({ connection: connectionView, apiKey: z.string() }),
}), async (req, res) => {
  const body = req.body as z.infer<typeof createConnectionSchema>;
  const result = await mintAgentPrincipal(req.tenantId, { name: body.name, role: body.role, templateId: body.templateId ?? null }, req.userId);
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json(result);
});

mcpConnectionsRouter.get('/', describe({
  summary: 'List the company\'s AI connections (agent-principal-v1)',
  tags: ['mcp-connections'],
  response: z.object({ connections: z.array(connectionView) }),
}), async (req, res) => {
  res.json({ connections: await listAgentConnections(req.tenantId) });
});

mcpConnectionsRouter.delete('/:id', describe({
  summary: 'Remove an AI connection: its key stops working at once (agent-principal-v1)',
  tags: ['mcp-connections'],
  params: z.object({ id: z.string().uuid() }),
  response: z.object({ revoked: z.literal(true) }),
}), async (req, res) => {
  const id = req.params['id']!;
  if (!z.string().uuid().safeParse(id).success) throw AppError.notFound('AI connection not found');
  await revokeAgentConnection(req.tenantId, id, req.userId);
  res.json({ revoked: true });
});
