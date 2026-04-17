// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import http from 'node:http';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class TailscaleUnavailableError extends AppError {
  constructor(message: string) {
    super(503, message, 'TAILSCALE_UNAVAILABLE');
    this.name = 'TailscaleUnavailableError';
  }
}

interface LocalApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  timeoutMs?: number;
  rawResponse?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
}

function mapSocketError(err: NodeJS.ErrnoException): Error {
  switch (err.code) {
    case 'ENOENT':
      return new TailscaleUnavailableError(
        'Tailscale sidecar is not running. Start the tailscale service (docker compose up -d tailscale).',
      );
    case 'EACCES':
      return new TailscaleUnavailableError(
        'Permission denied reading the Tailscale socket. Check that the ts-socket volume is mounted on the api service.',
      );
    case 'ECONNREFUSED':
      return new TailscaleUnavailableError(
        'Tailscale daemon is not accepting connections yet. It may still be starting up.',
      );
    default:
      return err;
  }
}

function buildPath(base: string, query?: LocalApiOptions['query']): string {
  const prefix = base.startsWith('/') ? base : `/${base}`;
  if (!query) return `/localapi/v0${prefix}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `/localapi/v0${prefix}?${qs}` : `/localapi/v0${prefix}`;
}

/**
 * Call the Tailscale local HTTP API over the sidecar's Unix socket.
 *
 * The socket is shared into this container via a Docker named volume,
 * which works identically on Linux, Windows Docker Desktop, macOS, and
 * Raspberry Pi (unlike host-mode bind mounts of /var/run/tailscale).
 */
export function tailscaleLocalApi<T = unknown>(
  path: string,
  options: LocalApiOptions = {},
): Promise<T> {
  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, rawResponse = false, query } = options;
  const socketPath = env.TAILSCALE_SOCKET_PATH;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: buildPath(path, query),
        method,
        headers: {
          'Content-Type': 'application/json',
          Host: 'local-tailscaled.sock',
          // tailscaled requires a Sec-Tailscale header to thwart CSRF
          // via DNS rebinding from localhost origins. Any value works.
          'Sec-Tailscale': 'localapi',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            reject(new AppError(status, raw || `Tailscale API returned ${status}`, 'TAILSCALE_API_ERROR'));
            return;
          }
          if (rawResponse) {
            resolve(raw as unknown as T);
            return;
          }
          if (!raw) {
            resolve(undefined as unknown as T);
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            resolve(raw as unknown as T);
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Tailscale API call timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      reject(mapSocketError(err as NodeJS.ErrnoException));
    });

    if (payload) req.write(payload);
    req.end();
  });
}
