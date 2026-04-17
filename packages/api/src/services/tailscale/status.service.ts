// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type {
  TailscaleStatus,
  TailscaleNode,
  TailscaleBackendState,
} from '@kis-books/shared';
import { tailscaleLocalApi } from './socket-client.js';

interface RawNode {
  ID?: string;
  PublicKey?: string;
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  AllowedIPs?: string[];
  Addrs?: string[];
  CurAddr?: string;
  Relay?: string;
  RxBytes?: number;
  TxBytes?: number;
  Created?: string;
  LastSeen?: string;
  LastHandshake?: string;
  Online?: boolean;
  ExitNode?: boolean;
  ExitNodeOption?: boolean;
  Active?: boolean;
  Tags?: string[];
  KeyExpiry?: string;
}

interface RawStatus {
  BackendState?: string;
  AuthURL?: string;
  Self?: RawNode;
  Peer?: Record<string, RawNode>;
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string } | null;
  MagicDNSSuffix?: string;
  Health?: string[];
  Version?: string;
}

function normalizeNode(raw: RawNode | undefined): TailscaleNode | null {
  if (!raw) return null;
  return {
    id: raw.ID ?? '',
    publicKey: raw.PublicKey ?? '',
    hostName: raw.HostName ?? '',
    dnsName: raw.DNSName ?? '',
    os: raw.OS ?? '',
    tailscaleIPs: raw.TailscaleIPs ?? [],
    allowedIPs: raw.AllowedIPs ?? [],
    addrs: raw.Addrs ?? [],
    curAddr: raw.CurAddr ?? '',
    relay: raw.Relay ?? '',
    rxBytes: raw.RxBytes ?? 0,
    txBytes: raw.TxBytes ?? 0,
    created: raw.Created ?? '',
    lastSeen: raw.LastSeen ?? '',
    lastHandshake: raw.LastHandshake ?? '',
    online: raw.Online ?? false,
    exitNode: raw.ExitNode ?? false,
    exitNodeOption: raw.ExitNodeOption ?? false,
    active: raw.Active ?? false,
    tags: raw.Tags ?? [],
    keyExpiry: raw.KeyExpiry ?? '',
  };
}

const VALID_STATES: TailscaleBackendState[] = [
  'NoState',
  'NeedsMachineAuth',
  'NeedsLogin',
  'Starting',
  'Running',
  'Stopped',
];

function normalizeState(raw: string | undefined): TailscaleBackendState {
  if (raw && (VALID_STATES as string[]).includes(raw)) {
    return raw as TailscaleBackendState;
  }
  return 'NoState';
}

export function normalizeStatus(raw: RawStatus): TailscaleStatus {
  const self = normalizeNode(raw.Self);
  const peers: TailscaleNode[] = [];
  if (raw.Peer) {
    for (const peer of Object.values(raw.Peer)) {
      const normalized = normalizeNode(peer);
      if (normalized) peers.push(normalized);
    }
  }
  return {
    state: normalizeState(raw.BackendState),
    self,
    peers,
    tailnetName: raw.CurrentTailnet?.Name ?? '',
    magicDNSSuffix: raw.CurrentTailnet?.MagicDNSSuffix ?? raw.MagicDNSSuffix ?? '',
    health: raw.Health ?? [],
    currentTailscaleIPs: self?.tailscaleIPs ?? [],
    version: raw.Version ?? 'unknown',
    authURL: raw.AuthURL || undefined,
    updatedAt: new Date().toISOString(),
  };
}

export async function getStatus(): Promise<TailscaleStatus> {
  const raw = await tailscaleLocalApi<RawStatus>('/status');
  return normalizeStatus(raw);
}

export async function getPeers(): Promise<TailscaleNode[]> {
  const status = await getStatus();
  return status.peers;
}

export async function getIPs(): Promise<string[]> {
  const status = await getStatus();
  return status.currentTailscaleIPs;
}

export async function getVersion(): Promise<string> {
  const status = await getStatus();
  return status.version;
}
