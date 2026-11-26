import { afterEach, expect, test, vi } from 'vitest';
import plugin, { checkRenderCapSetting } from './render-cap-plugin.ts';

// Nitro's definePlugin returns the plugin as given; the real module needs Nitro's build-time imports.
vi.mock('nitro', () => ({ definePlugin: <T>(definition: T) => definition }));

afterEach(() => vi.unstubAllEnvs());

test('the startup plugin is the setting check', () => {
  expect(plugin).toBe(checkRenderCapSetting);
});

test('startup refuses a PEBLISH_RENDER_CAP it cannot read, before the server listens', () => {
  vi.stubEnv('PEBLISH_RENDER_CAP', 'six');
  expect(checkRenderCapSetting).toThrow(/PEBLISH_RENDER_CAP/);
});

test('startup goes on with the default, off, or a valid limit and queue', () => {
  for (const value of ['', 'off', '8', '8,40']) {
    vi.stubEnv('PEBLISH_RENDER_CAP', value);
    expect(checkRenderCapSetting).not.toThrow();
  }
});
