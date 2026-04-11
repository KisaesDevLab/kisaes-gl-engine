import { describe, it, expect, vi, afterEach } from 'vitest';
import { sentinelAudit } from './sentinel-audit.js';

const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

afterEach(() => {
  consoleSpy.mockClear();
});

describe('sentinelAudit', () => {
  it('writes a greppable line prefixed [sentinel-audit]', () => {
    sentinelAudit('sentinel.create', { installationId: 'abc-123' });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const [line] = consoleSpy.mock.calls[0] as [string];
    expect(line).toMatch(/^\[sentinel-audit\] /);
  });

  it('includes the event name and details in a JSON payload', () => {
    sentinelAudit('installation.database_reset_detected', {
      installationId: 'abc-123',
      reason: 'DB empty',
    });
    const [line] = consoleSpy.mock.calls[0] as [string];
    const json = line.replace('[sentinel-audit] ', '');
    const parsed = JSON.parse(json);
    expect(parsed.event).toBe('installation.database_reset_detected');
    expect(parsed.kind).toBe('sentinel-audit');
    expect(parsed.installationId).toBe('abc-123');
    expect(parsed.reason).toBe('DB empty');
    expect(typeof parsed.ts).toBe('string');
  });

  it('handles events without details', () => {
    sentinelAudit('sentinel.reset');
    const [line] = consoleSpy.mock.calls[0] as [string];
    const json = line.replace('[sentinel-audit] ', '');
    const parsed = JSON.parse(json);
    expect(parsed.event).toBe('sentinel.reset');
  });
});
