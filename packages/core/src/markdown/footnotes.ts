import type { MarkdownIt, StateCore, Token } from 'markdown-it';

// markdown-it-footnote's tail rule, which moves the footnote definitions to a list at the
// end, appends each footnote with `state.tokens = state.tokens.concat(...)`: that copies the
// whole token stream once per footnote, so its time is quadratic in the number of footnotes
// (4,000 took about 2 s). This rule replaces it, builds the same tokens and appends them in
// place. Use it after the plugin.

/** What markdown-it-footnote keeps in env.footnotes for the tail rule. */
interface Footnotes {
  list?: { label?: string; count?: number; content?: string; tokens?: Token[] }[];
}

function footnoteTail(state: StateCore): void {
  // The plugin is untyped, and markdown-it types env values as unknown.
  const footnotes = state.env.footnotes as Footnotes | undefined;
  if (!footnotes) return;

  // Each definition's tokens leave the stream, kept by label (a later definition wins).
  const definitions = new Map<unknown, Token[]>();
  let definition: Token[] | undefined;
  let label: unknown;
  state.tokens = state.tokens.filter((token) => {
    if (token.type === 'footnote_reference_open') {
      definition = [];
      label = token.meta?.label;
      return false;
    }
    if (token.type === 'footnote_reference_close') {
      definitions.set(label, definition ?? []);
      definition = undefined;
      return false;
    }
    definition?.push(token);
    return definition === undefined;
  });

  const { list } = footnotes;
  if (!list) return;
  const tokens = state.tokens;
  tokens.push(new state.Token('footnote_block_open', '', 1));
  // As in the plugin, an entry with neither tokens nor a label repeats the one before.
  let body: Token[] | undefined;
  list.forEach((footnote, id) => {
    const open = new state.Token('footnote_open', '', 1);
    open.meta = { id, label: footnote.label };
    tokens.push(open);
    if (footnote.tokens) {
      const paragraphOpen = new state.Token('paragraph_open', 'p', 1);
      paragraphOpen.block = true;
      const inline = new state.Token('inline', '', 0);
      inline.children = footnote.tokens;
      inline.content = footnote.content ?? '';
      const paragraphClose = new state.Token('paragraph_close', 'p', -1);
      paragraphClose.block = true;
      body = [paragraphOpen, inline, paragraphClose];
    } else if (footnote.label) {
      body = definitions.get(footnote.label);
    }
    for (const token of body ?? []) tokens.push(token);
    // The back links go inside the footnote's last paragraph.
    const lastParagraph = tokens.at(-1)?.type === 'paragraph_close' ? tokens.pop() : undefined;
    const count = footnote.count ?? 0;
    for (let subId = 0; subId < Math.max(count, 1); subId++) {
      const anchor = new state.Token('footnote_anchor', '', 0);
      anchor.meta = { id, subId, label: footnote.label };
      tokens.push(anchor);
    }
    if (lastParagraph) tokens.push(lastParagraph);
    tokens.push(new state.Token('footnote_close', '', -1));
  });
  tokens.push(new state.Token('footnote_block_close', '', -1));
}

export function footnoteTailInPlace(md: MarkdownIt): void {
  md.core.ruler.at('footnote_tail', footnoteTail);
}
