import type { Page } from '@playwright/test';

/**
 * The instance's name as the sidebar brand gives it (site.name, else the host): what every page title ends with.
 * With a brand pack the brand link is named by it and shows the pack's mark and wordmark instead.
 */
export async function siteName(page: Page): Promise<string> {
  const brand = page.locator('.pb-brand');
  return ((await brand.getAttribute('aria-label')) ?? (await brand.textContent()) ?? '').trim();
}
