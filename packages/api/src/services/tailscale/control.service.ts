import type {
  TailscaleActionResult,
  TailscaleConnectInput,
  TailscaleServeStatus,
} from '@kis-books/shared';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { tailscaleLocalApi } from './socket-client.js';
import { getStatus } from './status.service.js';
import { logTailscaleAudit, type AuditContext } from './audit.service.js';

/**
 * Bring the tailnet node up via the local API. This is the equivalent of
 * `tailscale up` but hits /localapi/v0/prefs + /start so we don't need a
 * CLI binary inside the api container.
 */
export async function connect(
  input: TailscaleConnectInput,
  ctx: AuditContext,
): Promise<TailscaleActionResult> {
  const previous = await safeStatus();

  // Step 1 — PATCH prefs for any non-auth settings. MaskedPrefs requires a
  // *Set sibling for each field to take effect.
  const prefs: Record<string, unknown> = { WantRunning: true, WantRunningSet: true };
  if (input.hostname || env.TS_HOSTNAME) {
    prefs['Hostname'] = input.hostname ?? env.TS_HOSTNAME;
    prefs['HostnameSet'] = true;
  }
  if (input.acceptRoutes !== undefined) {
    prefs['RouteAll'] = input.acceptRoutes;
    prefs['RouteAllSet'] = true;
  }
  if (input.shieldsUp !== undefined) {
    prefs['ShieldsUp'] = input.shieldsUp;
    prefs['ShieldsUpSet'] = true;
  }
  await tailscaleLocalApi('/prefs', { method: 'PATCH', body: prefs });

  // Step 2 — trigger (re)start. If an auth key was supplied, ipn.Options
  // carries it into the Start() call for non-interactive node-key auth.
  // Source: tailscale ipn/backend.go Options.AuthKey.
  const startBody: Record<string, unknown> = {};
  if (input.authKey) startBody['AuthKey'] = input.authKey;
  await tailscaleLocalApi('/start', { method: 'POST', body: startBody }).catch(() => undefined);

  // Step 3 — if still unauthenticated, kick interactive login so tailscaled
  // populates an AuthURL on /status for the operator to follow in-browser.
  // /login-interactive accepts no body (source: localapi/localapi.go
  // serveLoginInteractive) — send a zero-length POST only.
  if (!input.authKey) {
    await tailscaleLocalApi('/login-interactive', { method: 'POST' }).catch(() => undefined);
  }

  const current = await safeStatus();
  await logTailscaleAudit('connect', ctx, null, {
    previousState: previous?.state ?? 'unknown',
    newState: current?.state ?? 'unknown',
    hostname: prefs['Hostname'] ?? null,
    acceptRoutes: input.acceptRoutes ?? null,
    shieldsUp: input.shieldsUp ?? null,
    authKeyProvided: !!input.authKey,
  });

  return {
    success: current?.state === 'Running' || current?.state === 'Starting',
    message:
      current?.state === 'Running'
        ? 'Tailscale connected'
        : current?.authURL
          ? `Authentication required: open ${current.authURL} to complete login`
          : `Tailscale is ${current?.state ?? 'unknown'}`,
    state: current?.state,
    authURL: current?.authURL,
  };
}

export async function disconnect(ctx: AuditContext): Promise<TailscaleActionResult> {
  const previous = await safeStatus();
  await tailscaleLocalApi('/prefs', {
    method: 'PATCH',
    body: { WantRunning: false, WantRunningSet: true },
  });
  const current = await safeStatus();
  await logTailscaleAudit('disconnect', ctx, null, {
    previousState: previous?.state ?? 'unknown',
    newState: current?.state ?? 'unknown',
  });
  return {
    success: current?.state !== 'Running',
    message: 'Tailscale disconnected',
    state: current?.state,
  };
}

export async function reauth(ctx: AuditContext): Promise<TailscaleActionResult> {
  await tailscaleLocalApi('/logout', { method: 'POST' }).catch(() => undefined);
  // After logout, tailscaled produces a new AuthURL on /status that the
  // operator must follow to rejoin the tailnet. A zero-body POST to
  // /login-interactive kicks off that URL generation.
  await tailscaleLocalApi('/login-interactive', { method: 'POST' }).catch(() => undefined);
  const current = await safeStatus();
  await logTailscaleAudit('reauth', ctx, null, { newState: current?.state ?? 'unknown' });
  return {
    success: true,
    message: current?.authURL
      ? `Visit ${current.authURL} to reauthenticate`
      : 'Reauth initiated — check status for the auth URL',
    state: current?.state,
    authURL: current?.authURL,
  };
}

interface RawServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

export async function getServeStatus(): Promise<TailscaleServeStatus> {
  const raw = await tailscaleLocalApi<RawServeConfig | null>('/serve-config').catch(() => null);
  if (!raw || !raw.Web) {
    return { enabled: false, serveUrl: null, targetPort: null };
  }
  const [hostKey, webCfg] = Object.entries(raw.Web)[0] ?? [];
  const handler = webCfg?.Handlers?.['/'];
  const proxyMatch = handler?.Proxy?.match(/:(\d+)(?:\/|$)/);
  const targetPort = proxyMatch ? Number(proxyMatch[1]) : null;
  const hostName = hostKey?.split(':')[0] ?? null;
  return {
    enabled: true,
    serveUrl: hostName ? `https://${hostName}` : null,
    targetPort,
  };
}

export async function enableServe(
  targetPort: number,
  ctx: AuditContext,
): Promise<TailscaleServeStatus> {
  const status = await getStatus();
  const self = status.self;
  if (!self || status.state !== 'Running') {
    throw new AppError(
      409,
      'Tailscale must be connected before enabling Serve. Pair the node first.',
      'TAILSCALE_NOT_RUNNING',
    );
  }
  // Serve requires a MagicDNS-resolvable hostname so tailscaled can provision
  // a *.ts.net TLS cert. The short hostname alone won't work — the Web map
  // key must be the FQDN:port (see ipn/serve.go HostPort).
  const hostName = self.dnsName.replace(/\.$/, '');
  if (!hostName || !hostName.includes('.')) {
    throw new AppError(
      409,
      'MagicDNS is not active for this tailnet. Enable MagicDNS in the Tailscale admin console to use Serve.',
      'TAILSCALE_MAGICDNS_REQUIRED',
    );
  }

  const serveConfig = {
    TCP: { '443': { HTTPS: true } },
    Web: {
      [`${hostName}:443`]: {
        Handlers: {
          '/': { Proxy: `http://web:${targetPort}` },
        },
      },
    },
  };

  await tailscaleLocalApi('/serve-config', { method: 'POST', body: serveConfig });
  await logTailscaleAudit('serve_enable', ctx, hostName, { targetPort });

  return {
    enabled: true,
    serveUrl: `https://${hostName}`,
    targetPort,
  };
}

export async function disableServe(ctx: AuditContext): Promise<TailscaleServeStatus> {
  await tailscaleLocalApi('/serve-config', { method: 'POST', body: {} });
  await logTailscaleAudit('serve_disable', ctx, null, {});
  return { enabled: false, serveUrl: null, targetPort: null };
}

async function safeStatus() {
  try {
    return await getStatus();
  } catch {
    return null;
  }
}
