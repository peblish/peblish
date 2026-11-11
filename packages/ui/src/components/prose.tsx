import { createContext, useContext, useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';

/** The one string Prose adds to rendered content; the web app provides it in the request's language. */
export interface ProseLabels {
  /** The name of the control that reveals a spoiler too complex to be a button itself. */
  revealSpoiler: string;
}

const ProseLabelsContext = createContext<ProseLabels>({ revealSpoiler: 'Reveal spoiler' });
export const ProseLabelsProvider = ProseLabelsContext.Provider;

/** Marks the reveal control Prose inserts before a compound spoiler. */
const REVEAL = 'button[data-spoiler-reveal]';
/** What a button must not contain, and what a keyboard user reaches by itself. */
const CONTROLS = 'a[href], button, input, select, textarea, summary, [tabindex]';

/**
 * The footnote back link's arrow (U+21A9, with the text-style selector U+FE0E) is outside Mux
 * UI's Latin font slices, so drawing it fetches the full font file (e2e/payload checks for it).
 * The up arrow (U+2191) is in the slice; only the arrow inside the renderer's back link is swapped.
 */
const backArrow = /(<a [^>]*class="footnote-backref"[^>]*>)\u21a9\ufe0e?(<\/a>)/g;

/** A leaf spoiler holds no control and no other spoiler, so it can be the button itself. */
const isLeaf = (spoiler: Element) => spoiler.querySelector(`${CONTROLS}, span.spoiler`) === null;

/** The control Prose inserted before a compound spoiler. */
const revealControl = (spoiler: Element) => {
  const before = spoiler.previousElementSibling;
  return before?.matches(REVEAL) ? before : null;
};

/** Reveals or hides one spoiler and keeps the button that stands for it in step. */
function toggle(spoiler: Element): void {
  const revealed = spoiler.toggleAttribute('data-revealed');
  // aria-pressed belongs to a real button only: the leaf span itself, or the inserted control.
  const button = spoiler.getAttribute('role') === 'button' ? spoiler : revealControl(spoiler);
  button?.setAttribute('aria-pressed', String(revealed));
}

/**
 * Renders HTML the Markdown pipeline already sanitised (packages/web/src/server/markdown.ts:
 * never pass anything else). A spoiler span (`span.spoiler`) stays blacked out until it is
 * clicked, or reached with the keyboard and activated with Enter or Space; the rest of the
 * content styles are in prose.css.
 *
 * The sanitiser's output stays plain: once mounted, this adds the semantics a spoiler needs.
 * A leaf spoiler (no link, control or other spoiler inside) becomes the button itself
 * (tabindex, role="button", aria-pressed). A compound one cannot, since a button must not
 * contain a control or another button, so it stays a plain span and gets its own small
 * button inserted before it, which reveals it independently of the links inside.
 */
export function Prose({ html, className }: { html: string; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const { revealSpoiler } = useContext(ProseLabelsContext);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    for (const spoiler of node.querySelectorAll<HTMLElement>('span.spoiler')) {
      const revealed = String(spoiler.hasAttribute('data-revealed'));
      if (isLeaf(spoiler)) {
        spoiler.tabIndex = 0;
        spoiler.setAttribute('role', 'button');
        spoiler.setAttribute('aria-pressed', revealed);
      } else {
        const control = document.createElement('button');
        control.type = 'button';
        control.setAttribute('data-spoiler-reveal', '');
        control.setAttribute('aria-label', revealSpoiler);
        control.setAttribute('aria-pressed', revealed);
        spoiler.before(control);
      }
    }
    // A new label or new html starts over, so no control is inserted twice.
    return () => {
      for (const control of node.querySelectorAll(REVEAL)) control.remove();
    };
  }, [html, revealSpoiler]);

  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest(REVEAL);
    const spoiler = control ? control.nextElementSibling : event.target.closest('span.spoiler');
    if (spoiler?.matches('span.spoiler')) toggle(spoiler);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Only a focused leaf spoiler: Enter on a control inside or beside a compound one keeps its own meaning.
    if (
      (event.key === 'Enter' || event.key === ' ') &&
      event.target instanceof Element &&
      event.target.matches('span.spoiler[role="button"]')
    ) {
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
      dangerouslySetInnerHTML={{ __html: html.replace(backArrow, '$1\u2191$2') }}
    />
  );
}
