import type { MarkdownIt, StateInline } from 'markdown-it';
import { contexts } from './context.ts';

// `:shortcode:` tokens, looked up in the caller's table. A string value is Unicode text; a
// custom emoji is an <img class="emoji"> (plain `:shortcode:` text under the link image
// policy). Shortcodes missing from the table stay as typed.

const shortcode = /^:([\w+-]{1,64}):/;

function emojiRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3a /* : */) return false;
  const context = contexts.get(state.env);
  const match = context && shortcode.exec(state.src.slice(state.pos, state.pos + 67));
  if (!context || !match) return false;
  // Own keys only, so :constructor: or :__proto__: never reach Object.prototype.
  const value = Object.hasOwn(context.emoji, match[1]!) ? context.emoji[match[1]!] : undefined;
  if (value === undefined) return false;
  if (!silent) {
    if (typeof value === 'string' || context.images === 'link') {
      state.push('text', '', 0).content = typeof value === 'string' ? value : match[0];
    } else {
      const token = state.push('emoji', 'img', 0);
      token.attrs = [
        ['src', value.url],
        ['alt', value.alt ?? match[0]],
        ['title', match[0]],
        ['class', 'emoji'],
      ];
    }
  }
  state.pos += match[0].length;
  return true;
}

export function emoji(md: MarkdownIt): void {
  md.inline.ruler.after('emphasis', 'emoji', emojiRule);
  md.renderer.rules.emoji = (tokens, idx, options, _env, renderer) => renderer.renderToken(tokens, idx, options);
}
