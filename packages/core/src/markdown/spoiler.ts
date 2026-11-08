import type { MarkdownIt, StateBlock } from 'markdown-it';

// The Lemmy spoiler container (C13):
//
//   ::: spoiler Title
//   hidden *Markdown*
//   :::
//
// renders as <details><summary>Title</summary>...</details>. Unlike Lemmy's own rule, the
// opening line may omit the title ("Spoiler", as PieFed does) and spoilers nest: each
// opening line inside the block needs its own closing line. An unclosed spoiler runs to the
// end of its parent block, as markdown-it-container does.

const opening = /^:{3,}[ \t]*spoiler(?:[ \t]+(.*?))?[ \t]*$/;
const closing = /^:{3,}[ \t]*$/;

/** The summary used when the opening line has no title. */
export const spoilerDefaultTitle = 'Spoiler';

function spoilerBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const lineText = (line: number) => state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]);
  const title = opening.exec(lineText(startLine));
  if (!title) return false;
  if (silent) return true;

  let line = startLine + 1;
  let depth = 1;
  for (; line < endLine; line++) {
    const text = lineText(line);
    // A non-blank line indented less than the block ends it (the end of a list item).
    if (text !== '' && state.sCount[line]! < state.blkIndent) break;
    if (state.sCount[line]! - state.blkIndent >= 4) continue;
    if (opening.test(text)) depth++;
    else if (closing.test(text) && --depth === 0) break;
  }
  const closed = depth === 0;

  const parentType = state.parentType;
  const lineMax = state.lineMax;
  state.parentType = 'spoiler';
  // Keeps lazy paragraph continuations from running past the closing line.
  state.lineMax = line;
  const open = state.push('spoiler_open', 'details', 1);
  open.block = true;
  open.info = title[1] ?? '';
  open.map = [startLine, line];
  state.md.block.tokenize(state, startLine + 1, line);
  state.push('spoiler_close', 'details', -1).block = true;
  state.parentType = parentType;
  state.lineMax = lineMax;
  state.line = closed ? line + 1 : line;
  return true;
}

export function spoiler(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'spoiler', spoilerBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.spoiler_open = (tokens, idx) =>
    `<details><summary>${md.utils.escapeHtml(tokens[idx]!.info.trim() || spoilerDefaultTitle)}</summary>\n`;
  md.renderer.rules.spoiler_close = () => '</details>\n';
}
