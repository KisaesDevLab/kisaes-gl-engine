// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export type TailscaleBackendState =
  | 'NoState'
  | 'NeedsMachineAuth'
  | 'NeedsLogin'
  | 'Starting'
  | 'Running'
  | 'Stopped';

export interface TailscaleNode {
  id: string;
  publicKey: string;
  hostName: string;
  dnsName: string;
  os: string;
  tailscaleIPs: string[];
  allowedIPs: string[];
  addrs: string[];
  curAddr: string;
  relay: string;
  rxBytes: number;
  txBytes: number;
  created: string;
  lastSeen: string;
  lastHandshake: string;
  online: boolean;
  exitNode: boolean;
  exitNodeOption: boolean;
  active: boolean;
  tags: string[];
  keyExpiry: string;
}

export interface TailscaleStatus {
  state: TailscaleBackendState;
  self: TailscaleNode | null;
  peers: TailscaleNode[];
  tailnetName: string;
  magicDNSSuffix: string;
  health: string[];
  currentTailscaleIPs: string[];
  version: string;
  authURL?: string;
  updatedAt: string;
}

export type HealthStatus = 'pass' | 'warn' | 'fail';
export type OverallHealth = 'healthy' | 'degraded' | 'critical' | 'disconnected';

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface TailscaleHealth {
  overall: OverallHealth;
  checks: HealthCheck[];
  lastCheckAt: string;
}

export interface TailscaleAuditEntry {
  id: number;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  target: string | null;
  details: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export interface TailscaleServeStatus {
  enabled: boolean;
  serveUrl: string | null;
  targetPort: number | null;
}

export interface TailscaleActionResult {
  success: boolean;
  message: string;
  state?: TailscaleBackendState;
  authURL?: string;
}

export interface TailscaleUpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
  upgradeCommand: string;
  checkedAt: string;
  error?: string;
}
