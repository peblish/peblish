// What the editor's toolbar buttons insert. Each function takes the textarea's text and its
// selection (`start` to `end`, equal for a caret) and returns the new text with the selection
// to put back. Pure, so the web app can bind them to a textarea and tests can run them as they
// are. The spoiler block is core's (@peblish/core/markdown/toolbar), because its format must
// match the renderer; web passes it to the editor.

export interface Insertion {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Takes the text and its selection, answers the edit. */
export type Insert = (value: string, start: number, end: number) => Insertion;

/** `marker` on both sides of the selection (a caret gets an empty pair), the inner text left selected. */
export const wrap =
  (marker: string): Insert =>
  (value, start, end) => ({
    value: `${value.slice(0, start)}${marker}${value.slice(start, end)}${marker}${value.slice(end)}`,
    selectionStart: start + marker.length,
    selectionEnd: end + marker.length,
  });

/** `[text](url)`: a selected address becomes the target and the text is typed next; anything else becomes the text and `url` is typed next. */
export const link =
  (placeholder: { text: string; url: string }): Insert =>
  (value, start, end) => {
    const selected = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);
    if (/^https?:\/\/\S+$/.test(selected)) {
      return {
        value: `${before}[${placeholder.text}](${selected})${after}`,
        selectionStart: start + 1,
        selectionEnd: start + 1 + placeholder.text.length,
      };
    }
    const text = selected || placeholder.text;
    const urlStart = start + text.length + 3;
    return {
      value: `${before}[${text}](${placeholder.url})${after}`,
      selectionStart: urlStart,
      selectionEnd: urlStart + placeholder.url.length,
    };
  };

/** Where the line holding `index` starts. */
const lineStart = (value: string, index: number) => (index === 0 ? 0 : value.lastIndexOf('\n', index - 1) + 1);

/** The whole lines the selection touches: where they start and end, and their text. */
function lineSpan(value: string, start: number, end: number) {
  const from = lineStart(value, start);
  // A selection that ends right after a line break does not include the next line.
  const stop = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const found = value.indexOf('\n', stop);
  const to = found === -1 ? value.length : found;
  return { from, to, lines: value.slice(from, to).split('\n') };
}

/** `prefix(index)` at the start of every line the selection touches; the lines stay selected. */
const prefixLines =
  (prefix: (index: number) => string): Insert =>
  (value, start, end) => {
    const { from, to, lines } = lineSpan(value, start, end);
    const changed = lines.map((line, index) => `${prefix(index)}${line}`).join('\n');
    return {
      value: `${value.slice(0, from)}${changed}${value.slice(to)}`,
      selectionStart: start + prefix(0).length,
      selectionEnd: end + changed.length - (to - from),
    };
  };

export const quote = prefixLines(() => '> ');
export const bulletList = prefixLines(() => '- ');
export const numberedList = prefixLines((index) => `${index + 1}. `);

/** Makes the first line of the selection a second-level heading; a line that already is a heading is left alone. */
export const heading: Insert = (value, start, end) => {
  const from = lineStart(value, start);
  if (/^#{1,6} /.test(value.slice(from, from + 8))) return { value, selectionStart: start, selectionEnd: end };
  return { value: `${value.slice(0, from)}## ${value.slice(from)}`, selectionStart: start + 3, selectionEnd: end + 3 };
};

/**
 * Code: backticks around a selection within one line (or a caret), a fenced block around a
 * selection that spans lines. The block sits apart from the text around it, like core's
 * spoiler block, and the caret goes inside it.
 */
export const code: Insert = (value, start, end) => {
  const selected = value.slice(start, end);
  if (!selected.includes('\n')) return wrap('`')(value, start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const opening = `${before}${lead}\`\`\`\n`;
  return {
    value: `${opening}${selected.replace(/\n+$/, '')}\n\`\`\`${trail}${after}`,
    selectionStart: opening.length,
    selectionEnd: opening.length + selected.replace(/\n+$/, '').length,
  };
};
