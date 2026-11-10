import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { gotoHydrated } from '../support/route-marker.ts';
import { community, seed, signedIn, type Seed } from './support.ts';

// Preview against what is published, byte for byte, for the Markdown corpus. A remote image in
// the text renders through the proxy only while remote_media.enabled is on, so these cases run
// in the serial project, after the parallel one, where no other spec flips that switch between
// the two renders.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ mode: 'serial' });

let world: Seed;
let poster: BrowserContext;

test.beforeAll(async ({ browser, baseURL }) => {
  world = seed();
  poster = await signedIn(browser, baseURL!, world.people.poster, world.password);
});
test.afterAll(async () => {
  await poster.close();
});

const body = (page: Page) => page.getByRole('textbox', { name: 'Body', exact: true });
const post = (page: Page) => page.getByRole('button', { name: 'Post', exact: true });

/** What the editor's Preview shows, then what the post page shows for the same text once posted. */
async function previewThenPublish(page: Page, text: string) {
  await body(page).fill(text);
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.locator('.pb-md__preview .pb-prose');
  await expect(preview).toBeVisible();
  const previewed = await preview.innerHTML();
  await post(page).click();
  await page.waitForURL(/\/post\/[0-9a-f-]{36}$/);
  await page.locator('html[data-hydrated="1"]').waitFor({ state: 'attached' });
  return { previewed, published: await page.locator('.post-text').innerHTML(), id: page.url().split('/').at(-1)! };
}

// The preview of a new post has no post id yet, so its footnote anchors lack the id the published
// page gives them and its proxied images are not signed for the post; everything else is byte for
// byte the same.
const withoutFootnoteId = (html: string) =>
  html
    .replace(/(fn|fnref)-[0-9a-f-]{36}-(\d+)/g, '$1$2')
    // A proxied image is signed for what it is shown in: the preview's reference expires, the
    // published post's names the post. The image URL it carries (after the head line) must match.
    .replace(/\/media\/proxy\/[\w-]+\/([\w-]+)/g, (_, target: string) => {
      const payload = Buffer.from(target, 'base64url').toString('utf8');
      return `/media/proxy/${payload.slice(payload.indexOf('\n') + 1)}`;
    });

const corpus: Record<string, string> = {
  'a spoiler, a table and code': [
    '::: spoiler Ending\nThe *butler* did it.\n\nTwice.\n:::',
    '| a | b |\n| - | -: |\n| 1 | 2 |',
    '```ts\nconst answer: number = 42;\n```',
    'Inline `code` and a [link](https://example.org/a?b=1&c=2).',
  ].join('\n\n'),
  'footnotes, lists and quotes':
    'Claim[^1] and ~~strike~~.\n\n[^1]: The note.\n\n> quoted\n\n1. one\n2. two\n\n- a\n- b\n\n## Heading\n\n<b>raw</b> & <script>alert(1)</script>',
  'mentions and images':
    'Hello @someone@lemmy.world, see !tech@lemmy.world.\n\n![remote](https://10.0.0.5/pic.png) and ![own](/media/nothing.png)',
};

for (const [name, text] of Object.entries(corpus)) {
  test(`what Preview shows is what is published: ${name}`, async () => {
    const page = await poster.newPage();
    await gotoHydrated(page, '/submit');
    await community(page, world.communities.open.handle).check();
    await page.getByLabel('Title').fill(`Preview ${name}`);
    const { previewed, published } = await previewThenPublish(page, text);
    expect(previewed.length).toBeGreaterThan(40);
    expect(withoutFootnoteId(published)).toBe(withoutFootnoteId(previewed));
    await page.close();
  });
}
