import { test, type APIRequestContext } from '@playwright/test';

/**
 * Skips the spec when the server does not serve the component gallery (/kit answers 404
 * unless PEBLISH_UI_KIT=1; CI's check job sets it). Call it from a beforeEach.
 */
export async function skipWithoutKit(request: APIRequestContext): Promise<void> {
  const response = await request.get('/kit');
  test.skip(response.status() === 404, 'the component gallery needs PEBLISH_UI_KIT=1 on the server');
}

/** The display cookie the server reads (packages/core/src/prefs/cookie.ts). */
export const prefsCookie = (density: 'card' | 'classic' | 'compact', scheme: 'system' | 'light' | 'dark') => ({
  name: 'peblish_prefs',
  value: `density=${density}&scheme=${scheme}`,
});
