import { expect, test } from 'vitest';
import { scanConfig } from './config.ts';

test('with nothing set the scanner has no provider and the documented defaults', () => {
  expect(scanConfig({})).toEqual({ arachnid: null, localOnly: false, timeoutMs: 8000, undecidedPurgeDays: 7 });
});

test('both credentials make the provider, with the Shield host unless a base URL is set', () => {
  const env = { ARACHNID_USERNAME: 'u', ARACHNID_PASSWORD: 'p' };
  expect(scanConfig(env).arachnid).toEqual({ username: 'u', password: 'p', baseUrl: 'https://shield.projectarachnid.com' });
  expect(scanConfig({ ...env, ARACHNID_BASE_URL: 'http://127.0.0.1:9000/' }).arachnid?.baseUrl).toBe('http://127.0.0.1:9000');
});

test('one credential, a plain-http remote host, credentials in the URL and bad numbers are refused without echoing a value', () => {
  const bad: Record<string, string>[] = [
    { ARACHNID_USERNAME: 'u' },
    { ARACHNID_PASSWORD: 'p' },
    { ARACHNID_USERNAME: 'u', ARACHNID_PASSWORD: 'p', ARACHNID_BASE_URL: 'http://shield.example' },
    { ARACHNID_USERNAME: 'u', ARACHNID_PASSWORD: 'p', ARACHNID_BASE_URL: 'https://user:hunter2@shield.example' },
    { MEDIASCAN_TIMEOUT_MS: '0' },
    { MEDIASCAN_TIMEOUT_MS: 'soon' },
    { MEDIASCAN_UNDECIDED_PURGE_DAYS: '-3' },
  ];
  for (const env of bad) {
    const attempt = () => scanConfig(env);
    expect(attempt, JSON.stringify(Object.keys(env))).toThrow();
    try {
      attempt();
    } catch (error) {
      expect(String(error)).not.toMatch(/hunter2|\bp\b/);
    }
  }
});

test('local-only is on only for 1', () => {
  expect(scanConfig({ MEDIASCAN_LOCAL_ONLY: '1' }).localOnly).toBe(true);
  expect(scanConfig({ MEDIASCAN_LOCAL_ONLY: '0' }).localOnly).toBe(false);
  expect(scanConfig({ MEDIASCAN_LOCAL_ONLY: '' }).localOnly).toBe(false);
});
