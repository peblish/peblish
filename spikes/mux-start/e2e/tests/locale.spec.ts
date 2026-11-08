import { expect, test, type Page } from '@playwright/test';
import { GATE_PATHS, gotoHydrated, recordConsole, slug, writeArtifact } from './support';

// Criterion (c): Accept-Language de-DE is detected on the server, and the locale-dependent
// fields' server HTML matches the hydrated DOM.

type Fields = { number: string; date: string };

const decode = (text: string) =>
  text.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function serverFields(html: string): Fields {
  const number = /data-testid="number-field">[\s\S]*?<input[^>]*\svalue="([^"]*)"/.exec(html)?.[1];
  const dateBlock = /data-testid="date-field">([\s\S]*?)<\/div><\/div><\/div>/.exec(html)?.[1] ?? '';
  const segments = [...dateBlock.matchAll(/class="muxui-date-segment"[^>]*>([^<]*)</g)].map((match) => match[1] ?? '');
  return { number: decode(number ?? ''), date: decode(segments.join('')) };
}

async function domFields(page: Page): Promise<Fields> {
  const number = await page.getByTestId('number-field').locator('input').inputValue();
  const segments = await page.getByTestId('date-field').locator('.muxui-date-segment').allTextContents();
  return { number, date: segments.join('') };
}

test.use({ locale: 'de-DE', extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' } });

for (const path of GATE_PATHS) {
  test(`server-detected de-DE on ${path}`, async ({ page, request }, info) => {
    const html = await (await request.get(path)).text();
    writeArtifact(`html/${path.slice(1)}.de-DE.html`, html);
    const server = serverFields(html);

    const log = recordConsole(page);
    await gotoHydrated(page, path);
    const atHydration = await domFields(page);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const settled = await domFields(page);
    log.save(slug(info));
    writeArtifact(`facts/${slug(info)}.json`, {
      path,
      htmlLang: /<html[^>]*\slang="([^"]*)"/.exec(html)?.[1],
      server,
      atHydration,
      settled,
      hydrationProblems: log.hydrationProblems(),
    });

    expect(log.hydrationProblems()).toEqual([]);
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
    await expect(page.getByTestId('server-locale')).toHaveText('de-DE');

    if (path === '/gate') {
      // With the provider, the server already renders German formats and nothing changes after hydration.
      expect(server).toEqual({ number: '1.234,50 €', date: '8.11.2026' });
      expect(atHydration).toEqual(server);
      expect(settled).toEqual(server);
    } else {
      // Without it, RAC renders its en-US default on the server and during hydration, then
      // re-renders in navigator.language right after (before the root marker). Recorded as a
      // visible locale flash; React reports no mismatch because hydration itself used en-US.
      expect(server).toEqual({ number: '€1,234.50', date: '11/8/2026' });
      expect(settled).toEqual({ number: '1.234,50 €', date: '8.11.2026' });
      info.annotations.push({ type: 'locale-flash', description: `${JSON.stringify(server)} -> ${JSON.stringify(settled)}` });
    }
  });
}
