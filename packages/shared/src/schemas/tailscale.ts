import { z } from 'zod';

export const tailscaleConnectSchema = z.object({
  authKey: z.string().trim().max(512).optional(),
  hostname: z.string().trim().max(63).optional(),
  acceptRoutes: z.boolean().optional(),
  shieldsUp: z.boolean().optional(),
});
export type TailscaleConnectInput = z.infer<typeof tailscaleConnectSchema>;

export const tailscaleServeSchema = z.object({
  targetPort: z.number().int().min(1).max(65535).default(5173),
});
export type TailscaleServeInput = z.infer<typeof tailscaleServeSchema>;

export const tailscaleDisconnectSchema = z.object({
  confirmation: z.literal('CONFIRM', {
    errorMap: () => ({ message: 'Destructive action requires confirmation: "CONFIRM"' }),
  }),
});
export type TailscaleDisconnectInput = z.infer<typeof tailscaleDisconnectSchema>;

export const tailscaleAuditFiltersSchema = z.object({
  action: z.string().max(50).optional(),
  actorUserId: z.string().uuid().optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TailscaleAuditFilters = z.infer<typeof tailscaleAuditFiltersSchema>;
