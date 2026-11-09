import type { MarkdownIt, StateBlock } from 'markdown-it';

// The Lemmy spoiler container (C13):
//
//   ::: spoiler Title
//   hidden *Markdown*
//   :::
//
// renders as <details><summary>Title</summary>...</details>. Unlike Lemmy's own rule, the
// opening line may omit the title ("Spoiler", as PieFed does) and spoilers nest: each
// opening line inside the block needs its own closing line, and marker lines inside fenced
// code do not count. An unclosed spoiler runs to the end of its parent block, as
// markdown-it-container does.

/** The summary used when the opening line has no title. */
export const spoilerDefaultTitle = 'Spoiler';

// The marker lines are parsed by hand, in one pass each: every body line is tested at every
// nesting level, and a pattern with a lazy title beside trailing whitespace backtracks
// quadratically on a padded line.
const isSpaceOrTab = (code: number) => code === 0x20 || code === 0x09;
const skipSpaces = (text: string, pos: number) => {
  while (isSpaceOrTab(text.charCodeAt(pos))) pos++;
  return pos;
};
/** Where the leading run of colons ends, or 0 when there are fewer than three. */
const colons = (text: string) => {
  let pos = 0;
  while (text.charCodeAt(pos) === 0x3a /* : */) pos++;
  return pos >= 3 ? pos : 0;
};

/** The title of an opening line, `::: spoiler Title` ('' without one), or undefined for any other line. */
function openingTitle(text: string): string | undefined {
  const marker = colons(text);
  if (marker === 0) return undefined;
  const word = skipSpaces(text, marker);
  const end = word + 'spoiler'.length;
  if (!text.startsWith('spoiler', word) || (end < text.length && !isSpaceOrTab(text.charCodeAt(end)))) return undefined;
  const start = skipSpaces(text, end);
  let stop = text.length;
  while (stop > start && isSpaceOrTab(text.charCodeAt(stop - 1))) stop--;
  return text.slice(start, stop);
}

/** A closing line: three or more colons and nothing else but spaces and tabs. */
function isClosing(text: string): boolean {
  const marker = colons(text);
  return marker > 0 && skipSpaces(text, marker) === text.length;
}

/**
 * A fenced code block the scan is inside: its marker character and run length. Fences are
 * recognised as markdown-it does at the spoiler's own level, fewer than four columns past
 * its indent. That is exact at the top of the spoiler and in a list item whose fence, code
 * and closing line share the item's indent; a fence in a deeper item is skipped, as are
 * marker lines that deep. Only a list item whose fence is indented differently from its own
 * code or closing line can still end the spoiler early.
 */
interface Fence {
  marker: number;
  length: number;
}

/** The marker run at the start of a line if it is three or more ` or ~ (no ` may follow a backtick run). */
function fenceRun(text: string): Fence | undefined {
  const marker = text.charCodeAt(0);
  if (marker !== 0x60 /* ` */ && marker !== 0x7e /* ~ */) return undefined;
  let length = 1;
  while (text.charCodeAt(length) === marker) length++;
  if (length < 3 || (marker === 0x60 && text.includes('`', length))) return undefined;
  return { marker, length };
}

/** A line that closes `fence`: the same marker, at least as long, then only spaces and tabs. */
function closesFence(fence: Fence, text: string): boolean {
  const run = fenceRun(text);
  return run !== undefined && run.marker === fence.marker && run.length >= fence.length && skipSpaces(text, run.length) === text.length;
}

function spoilerBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const lineText = (line: number) => state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]);
  const title = openingTitle(lineText(startLine));
  if (title === undefined) return false;
  if (silent) return true;

  let line = startLine + 1;
  let depth = 1;
  let fence: Fence | undefined;
  for (; line < endLine; line++) {
    const text = lineText(line);
    // A non-blank line indented less than the block ends it (the end of a list item).
    if (text !== '' && state.sCount[line]! < state.blkIndent) break;
    if (state.sCount[line]! - state.blkIndent >= 4) continue;
    if (fence) {
      if (closesFence(fence, text)) fence = undefined;
      continue;
    }
    fence = fenceRun(text);
    if (fence) continue;
    if (openingTitle(text) !== undefined) depth++;
    else if (isClosing(text) && --depth === 0) break;
  }
  const closed = depth === 0;

  const parentType = state.parentType;
  const lineMax = state.lineMax;
  state.parentType = 'spoiler';
  // Keeps lazy paragraph continuations from running past the closing line.
  state.lineMax = line;
  const open = state.push('spoiler_open', 'details', 1);
  open.block = true;
  open.info = title;
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
