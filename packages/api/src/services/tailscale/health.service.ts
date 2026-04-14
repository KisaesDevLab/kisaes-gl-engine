import type {
  HealthCheck,
  OverallHealth,
  TailscaleHealth,
  TailscaleNode,
} from '@kis-books/shared';
import { TailscaleUnavailableError } from './socket-client.js';
import { getStatus } from './status.service.js';

function overallFrom(checks: HealthCheck[]): OverallHealth {
  const connection = checks.find((c) => c.name === 'connection');
  if (connection?.status === 'fail') return 'disconnected';
  if (checks.some((c) => c.status === 'fail')) return 'critical';
  if (checks.some((c) => c.status === 'warn')) return 'degraded';
  return 'healthy';
}

export async function getHealth(): Promise<TailscaleHealth> {
  const checks: HealthCheck[] = [];

  let connected = false;
  try {
    const status = await getStatus();
    connected = status.state === 'Running';
    checks.push({
      name: 'connection',
      status: connected ? 'pass' : 'fail',
      message: connected
        ? `Connected as ${status.self?.hostName || 'unknown'}`
        : `Tailscale is ${status.state}`,
      details: { state: status.state, ips: status.currentTailscaleIPs },
    });

    if (status.self?.keyExpiry) {
      const expiry = new Date(status.self.keyExpiry);
      if (!Number.isNaN(expiry.getTime())) {
        const daysUntil = Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
        const warnThreshold = 14;
        checks.push({
          name: 'key_expiry',
          status: daysUntil < 0 ? 'fail' : daysUntil < warnThreshold ? 'warn' : 'pass',
          message:
            daysUntil < 0
              ? `Node key expired ${Math.abs(daysUntil)} days ago`
              : `Node key expires in ${daysUntil} days`,
          details: { expiresAt: status.self.keyExpiry, daysRemaining: daysUntil },
        });
      }
    }

    const onlinePeers = status.peers.filter((p: TailscaleNode) => p.online);
    const relayedPeers = onlinePeers.filter((p: TailscaleNode) => !!p.relay);
    if (status.peers.length > 0) {
      checks.push({
        name: 'peers',
        status: onlinePeers.length === 0 ? 'warn' : 'pass',
        message: `${onlinePeers.length}/${status.peers.length} peers online, ${relayedPeers.length} relayed`,
        details: {
          total: status.peers.length,
          online: onlinePeers.length,
          relayed: relayedPeers.length,
        },
      });
    }

    if (status.health.length > 0) {
      checks.push({
        name: 'daemon_warnings',
        status: 'warn',
        message: `${status.health.length} warning(s) from tailscaled`,
        details: { warnings: status.health },
      });
    }
  } catch (err) {
    checks.push({
      name: 'connection',
      status: 'fail',
      message:
        err instanceof TailscaleUnavailableError
          ? err.message
          : `Cannot reach Tailscale: ${(err as Error).message}`,
    });
  }

  return {
    overall: overallFrom(checks),
    checks,
    lastCheckAt: new Date().toISOString(),
  };
}
