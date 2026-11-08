import { spoilerDefaultTitle } from './spoiler.ts';

// What the composer's spoiler button inserts (C13). The format is the one Lemmy, lemmy-ui
// and PieFed all render: an opening line with a title, the body, a closing line, each block
// set apart from the text around it by a blank line. Its only import, spoiler.ts, has no
// runtime dependencies, so the browser can use it.

export interface Insertion {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** A blank line between `text` and what follows it, unless it is empty or already ends with one. */
const gapAfter = (text: string) => (text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n');
const gapBefore = (text: string) => (text === '' || text.startsWith('\n\n') ? '' : text.startsWith('\n') ? '\n' : '\n\n');

/**
 * Wraps the selection `value.slice(start, end)` in a spoiler titled `title`. With a
 * selection, the new title is selected so it can be typed over; without one, the caret
 * goes to the empty body line.
 */
export function insertSpoiler(value: string, start: number, end: number, title = spoilerDefaultTitle): Insertion {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const body = value.slice(start, end).replace(/\n+$/, '');
  const heading = `${gapAfter(before)}::: spoiler `;
  const name = title.replace(/\s+/g, ' ').trim() || spoilerDefaultTitle;
  const titleStart = before.length + heading.length;
  const bodyStart = titleStart + name.length + 1;
  const inserted = `${heading}${name}\n${body}\n:::`;
  return {
    value: `${before}${inserted}${gapBefore(after)}${after}`,
    selectionStart: body ? titleStart : bodyStart,
    selectionEnd: body ? titleStart + name.length : bodyStart,
  };
}
