import { isPageSlug } from '@peblish/core/pages/slugs';
import { parseShipped } from '@peblish/core/pages/shipped';
import type { ShippedPage } from '@peblish/core/pages/save';

// The legal texts that ship with the app (content/legal/<slug>.en.md), read at build time: the
// production image carries the bundle, not the repository's content folder. Imported by the
// server handler that adds them as drafts, so they stay out of the browser's bundle.
const files = import.meta.glob<string>('../../../../../../content/legal/*.en.md', { query: '?raw', import: 'default', eager: true });

export const shippedPages: ShippedPage[] = Object.entries(files).flatMap(([path, text]) => {
  const slug = /([^/]+)\.en\.md$/.exec(path)?.[1];
  const draft = parseShipped(text);
  return slug && isPageSlug(slug) && draft ? [{ slug, draft }] : [];
});
