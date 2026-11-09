import type { Page } from '@playwright/test';

/** The instance's name as the sidebar brand prints it (site.name, else the host): what every page title ends with. */
export async function siteName(page: Page): Promise<string> {
  return ((await page.locator('.pb-brand').textContent()) ?? '').trim();
}
