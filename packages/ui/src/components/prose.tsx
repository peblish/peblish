import type { MouseEvent } from 'react';

/**
 * Renders HTML the Markdown pipeline already sanitised (packages/web/src/server/markdown.ts:
 * never pass anything else). Clicking a spoiler span reveals it, or hides it again; the
 * rest of the content styles are in prose.css.
 */
export function Prose({ html, className }: { html: string; className?: string }) {
  function toggleSpoiler(event: MouseEvent<HTMLDivElement>) {
    const spoiler = event.target instanceof Element ? event.target.closest('span.spoiler') : null;
    if (spoiler) spoiler.toggleAttribute('data-revealed');
  }
  return (
    <div className={className ? `pb-prose ${className}` : 'pb-prose'} onClick={toggleSpoiler} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
