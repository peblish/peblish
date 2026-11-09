import { Tokenizer, type TokenizerCallbacks } from 'htmlparser2';

// What a page says about itself, read from its <head>: Open Graph first, Twitter cards and the
// plain <title> and description after. The tokenizer is htmlparser2's (linear in the input, as
// the sanitiser's is); nothing is built beyond the few strings kept.

export const maxTitleLength = 200;
export const maxDescriptionLength = 500;

export type PageMeta = { title: string | null; description: string | null; image: string | null };

const KEYS = new Set([
  'og:title',
  'twitter:title',
  'og:description',
  'twitter:description',
  'description',
  'og:image',
  'og:image:secure_url',
  'og:image:url',
  'twitter:image',
  'twitter:image:src',
]);

class HeadReader implements TokenizerCallbacks {
  readonly meta = new Map<string, string>();
  documentTitle = '';
  private tag = '';
  private attributeName = '';
  private attributeValue = '';
  private attributes = new Map<string, string>();
  private inTitle = false;
  private done = false;
  private readonly input: string;
  constructor(input: string) {
    this.input = input;
  }

  onopentagname(start: number, end: number): void {
    this.tag = this.input.slice(start, end).toLowerCase();
    this.attributes = new Map();
    // The body starts after the head: what follows is the page, not its description.
    if (this.tag === 'body') this.done = true;
  }
  onattribname(start: number, end: number): void {
    this.attributeName = this.input.slice(start, end).toLowerCase();
    this.attributeValue = '';
  }
  onattribdata(start: number, end: number): void {
    this.attributeValue += this.input.slice(start, end);
  }
  onattribentity(codepoint: number): void {
    this.attributeValue += String.fromCodePoint(codepoint);
  }
  onattribend(): void {
    // As in HTML, the first of two same-named attributes wins.
    if (!this.attributes.has(this.attributeName)) this.attributes.set(this.attributeName, this.attributeValue);
  }
  onopentagend(): void {
    if (this.done) return;
    if (this.tag === 'meta') {
      const key = (this.attributes.get('property') || this.attributes.get('name') || '').toLowerCase();
      const content = this.attributes.get('content');
      if (KEYS.has(key) && content && !this.meta.has(key)) this.meta.set(key, content);
    } else if (this.tag === 'title' && !this.documentTitle) {
      this.inTitle = true;
    }
  }
  onselfclosingtag(): void {
    this.onopentagend();
  }
  onclosetag(start: number, end: number): void {
    const name = this.input.slice(start, end).toLowerCase();
    if (name === 'title') this.inTitle = false;
    if (name === 'head') this.done = true;
  }
  ontext(start: number, end: number): void {
    if (this.inTitle && !this.done && this.documentTitle.length < 4 * maxTitleLength) this.documentTitle += this.input.slice(start, end);
  }
  ontextentity(codepoint: number): void {
    if (this.inTitle && !this.done && this.documentTitle.length < 4 * maxTitleLength) this.documentTitle += String.fromCodePoint(codepoint);
  }
  oncdata(): void {}
  oncomment(): void {}
  ondeclaration(): void {}
  onprocessinginstruction(): void {}
  onend(): void {}
}

const tidy = (text: string | undefined, max: number) => {
  const collapsed = text?.replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return collapsed ? collapsed : null;
};

/** The title, description and image URL (resolved against `baseUrl`, http or https only) a page's head gives. */
export function readPageMeta(html: string, baseUrl: string): PageMeta {
  const reader = new HeadReader(html);
  const tokenizer = new Tokenizer({ decodeEntities: true }, reader);
  tokenizer.write(html);
  tokenizer.end();
  const { meta } = reader;
  const imageValue =
    meta.get('og:image') ??
    meta.get('og:image:secure_url') ??
    meta.get('og:image:url') ??
    meta.get('twitter:image') ??
    meta.get('twitter:image:src');
  let image: string | null = null;
  try {
    const url = imageValue ? new URL(imageValue.trim(), baseUrl) : null;
    if (url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) image = url.href;
  } catch {
    // An unparseable image URL is no image.
  }
  return {
    title: tidy(meta.get('og:title') ?? meta.get('twitter:title') ?? reader.documentTitle, maxTitleLength),
    description: tidy(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), maxDescriptionLength),
    image,
  };
}
