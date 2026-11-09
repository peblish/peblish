import type { MarkdownIt, StateCore, Token } from 'markdown-it';

// Image attributes in the forms the peers accept:
// - PieFed's sizing, `![alt :: width=200px height=100px align-left](url)`: width and height
//   in pixels (the px is optional) or percent, align left, right or center. The text after
//   `::` never reaches the alt text, as on PieFed.
// - Lemmy's custom emoji, `![alt](url "emoji shortcode")`, which lemmy-ui's emoji picker
//   inserts: the image gets class="emoji" so it renders at text size.

const dimension = /^(?:(\d{1,4})(?:px)?|(\d{1,3})%)$/;

function size(value: string): string | undefined {
  const match = dimension.exec(value);
  if (!match) return undefined;
  if (match[1]) return String(Number(match[1]));
  return Number(match[2]) <= 100 ? `${Number(match[2])}%` : undefined;
}

/**
 * The alt text and the sizing words of `alt :: words`, split at the first `::`, or
 * undefined when only whitespace follows it. Found with indexOf: a pattern with a lazy alt
 * beside whitespace backtracks quadratically on a long alt.
 */
function sizing(content: string): { alt: string; words: string } | undefined {
  const at = content.indexOf('::');
  const words = at < 0 ? '' : content.slice(at + 2).trim();
  return words === '' ? undefined : { alt: content.slice(0, at).trimEnd(), words };
}

function attributes(state: StateCore, image: Token): void {
  const sized = sizing(image.content);
  if (sized) {
    const alt = new state.Token('text', '', 0);
    alt.content = sized.alt;
    image.children = [alt];
    image.content = sized.alt;
    for (const word of sized.words.split(/\s+/)) {
      const [name, value = ''] = word.split('=', 2);
      if (name === 'width' || name === 'height') {
        const pixels = size(value);
        if (pixels) image.attrSet(name, pixels);
      } else if (/^align-(left|right|center)$/.test(word)) {
        image.attrSet('align', word.slice('align-'.length));
      }
    }
  }
  if (/^emoji \S/.test(String(image.attrGet('title') ?? ''))) image.attrJoin('class', 'emoji');
}

function imagesRule(state: StateCore): void {
  const visit = (tokens: Token[] | null) => {
    for (const token of tokens ?? []) {
      if (token.type === 'image') attributes(state, token);
      if (token.type === 'inline') visit(token.children);
    }
  };
  visit(state.tokens);
}

export function images(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'image_attributes', imagesRule);
}
