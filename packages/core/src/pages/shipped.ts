import type { PageDraft } from './save.ts';

/**
 * A shipped text (content/legal/<slug>.en.md) as a draft: the first `# ` heading is the title
 * and the rest is the body, since the page route prints the title itself.
 */
export function parseShipped(text: string): PageDraft | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() !== '');
  const heading = at === -1 ? null : /^# (.+)$/.exec(lines[at] ?? '');
  if (!heading?.[1]) return null;
  return {
    title: heading[1].trim(),
    bodyMd: lines
      .slice(at + 1)
      .join('\n')
      .trim(),
  };
}
