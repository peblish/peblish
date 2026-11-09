import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';

/** Reveals or hides one spoiler and keeps its button state in step. */
function toggle(spoiler: Element): void {
  spoiler.setAttribute('aria-pressed', String(spoiler.toggleAttribute('data-revealed')));
}

/**
 * Renders HTML the Markdown pipeline already sanitised (packages/web/src/server/markdown.ts:
 * never pass anything else). A spoiler span (`span.spoiler`) stays blacked out until it is
 * clicked, or focused and activated with Enter or Space; the rest of the content styles are
 * in prose.css.
 *
 * The sanitiser's output stays plain: once mounted, this adds the button semantics a spoiler
 * needs (tabindex, role="button", aria-pressed) to the spans it finds. A spoiler that holds a
 * link or another control is left a plain span, since a button must not contain one.
 */
export function Prose({ html, className }: { html: string; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const spoiler of root.current?.querySelectorAll<HTMLElement>('span.spoiler') ?? []) {
      if (spoiler.querySelector('a[href], button, input, select, textarea, summary, [tabindex]')) continue;
      spoiler.tabIndex = 0;
      spoiler.setAttribute('role', 'button');
      spoiler.setAttribute('aria-pressed', String(spoiler.hasAttribute('data-revealed')));
    }
  }, [html]);

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const spoiler = event.target instanceof Element ? event.target.closest('span.spoiler') : null;
    if (spoiler) toggle(spoiler);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Only the focused spoiler itself: Enter on a control inside it keeps its own meaning.
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.matches('span.spoiler')) {
      event.preventDefault();
      toggle(event.target);
    }
  }
  return (
    <div
      ref={root}
      className={className ? `pb-prose ${className}` : 'pb-prose'}
      onClick={onClick}
      onKeyDown={onKeyDown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
