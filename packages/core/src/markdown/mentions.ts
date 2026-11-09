import { mentionMaxCount, type Mention } from '@peblish/schema/markdown';
import type { MarkdownIt, StateCore, Token } from 'markdown-it';
import { contexts, type RenderContext } from './context.ts';

// `@user@host` and `!community@host` in text (not in code or link text) become links to this
// instance's pages for them, /u/<name>@<host> and /c/<name>@<host> (the bare name for this
// instance's own host), as lemmy-ui does, and are collected for the caller (federation turns
// them into Mention tags). Only the first mentionMaxCount distinct mentions are linked and
// collected, so a body cannot fill a page with links or a post with tags; a later new one
// stays text.

const mention = /(?<![\w@!/.])([@!])([\w-]+(?:\.[\w-]+)*)@((?:[a-z\d-]+\.)+[a-z]{2,63})(?![\w-])/gi;

function link(state: StateCore, context: RenderContext, found: Mention): Token[] {
  const route = `${found.kind === 'person' ? 'u' : 'c'}/${found.name}${found.host === context.host ? '' : `@${found.host}`}`;
  const open = new state.Token('link_open', 'a', 1);
  open.attrs = [
    ['href', `${context.origin}/${route}`],
    ['class', found.kind === 'person' ? 'u-url mention' : 'u-url community'],
  ];
  const text = new state.Token('text', '', 0);
  text.content = `${found.kind === 'person' ? '@' : '!'}${found.name}@${found.host}`;
  return [open, text, new state.Token('link_close', 'a', -1)];
}

function split(state: StateCore, context: RenderContext, token: Token): Token[] | undefined {
  const parts: Token[] = [];
  let last = 0;
  for (const match of token.content.matchAll(mention)) {
    const found: Mention = { kind: match[1] === '@' ? 'person' : 'community', name: match[2]!, host: match[3]!.toLowerCase() };
    const key = `${found.kind} ${found.name.toLowerCase()}@${found.host}`;
    if (!context.mentions.has(key)) {
      if (context.mentions.size >= mentionMaxCount) continue;
      context.mentions.set(key, found);
    }
    if (match.index > last) {
      const text = new state.Token('text', '', 0);
      text.content = token.content.slice(last, match.index);
      parts.push(text);
    }
    parts.push(...link(state, context, found));
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return undefined;
  if (last < token.content.length) {
    const text = new state.Token('text', '', 0);
    text.content = token.content.slice(last);
    parts.push(text);
  }
  return parts;
}

function mentionsRule(state: StateCore): void {
  const context = contexts.get(state.env);
  if (!context) return;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const children: Token[] = [];
    let linkDepth = 0;
    for (const child of block.children) {
      if (child.type === 'link_open') linkDepth++;
      if (child.type === 'link_close') linkDepth--;
      const parts = child.type === 'text' && linkDepth === 0 ? split(state, context, child) : undefined;
      children.push(...(parts ?? [child]));
    }
    block.children = children;
  }
}

export function mentions(md: MarkdownIt): void {
  md.core.ruler.push('mentions', mentionsRule);
}
