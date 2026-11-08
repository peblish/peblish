import {
  SanitizeOptions,
  excerptLength as defaultExcerptLength,
  htmlMaxDepth,
  remoteHtmlMaxLength,
  type ImagePolicy,
  type SanitizedHtml,
} from '@peblish/schema/markdown';
import { Tokenizer, type TokenizerCallbacks } from 'htmlparser2';

// The allowlist HTML sanitiser behind both paths: remote `content` (Lemmy, PieFed, Mbin,
// Mastodon) through sanitizeRemoteHtml, and renderMarkdown's own output.
//
// It drives htmlparser2's Tokenizer (which tokenises like a browser, raw text elements
// included) and keeps its own element stack instead of using htmlparser2's Parser, whose
// stack handling is quadratic in nesting depth. Every step here is amortised O(1) per
// token, so the time is linear in the input. The output is rebuilt from scratch: only the
// elements and attributes below, each attribute checked and escaped, text escaped, every
// element closed. So a browser reads exactly the tags written here, and a second pass
// returns the output unchanged. The stack models the HTML tree builder only in part, so a
// browser may still rearrange those tags (insert a tbody, move text out of a table, close a
// p around a block inside an inline element), but all it has to rearrange are allowlisted
// elements with checked attributes.

/**
 * Where an inline image loads from: the URL to use (the media proxy, or the URL itself for
 * this instance's own media; absolute http(s) or a path on this origin), or null to show
 * the image as a link instead.
 */
export type ImageRewrite = (url: string) => string | null;

export type SanitizeHooks = { rewriteImageUrl?: ImageRewrite };

/** Resolved sanitiser options. */
export interface SanitizeContext {
  baseUrl: string | undefined;
  images: ImagePolicy;
  rewriteImageUrl: ImageRewrite | undefined;
  maxDepth: number;
  excerptLength: number;
}

/** Elements kept, by source name, with the name written out. Anything else is unwrapped. */
const kept = new Map<string, string>([
  ...'p br hr h1 h2 h3 h4 h5 h6 strong b em i u s del ins sub sup code pre kbd blockquote ul ol li table thead tbody tfoot tr th td details summary img a span div section ruby rt rp'
    .split(' ')
    .map((name) => [name, name] as const),
  ['strike', 's'],
  // PieFed's inline spoiler (>!text!<); the UI hides .spoiler until revealed.
  ['tg-spoiler', 'span'],
]);
/** Elements dropped with everything inside them. */
const dropped = new Set(
  'script style template textarea title iframe object applet noscript noembed noframes xmp plaintext svg math select datalist head audio video canvas frameset'.split(
    ' ',
  ),
);
const voids = new Set('area base br col embed hr img input link meta param source track wbr keygen frame basefont bgsound'.split(' '));
/** Elements whose edges separate words in the excerpt. */
const blocks = new Set('p br hr h1 h2 h3 h4 h5 h6 li blockquote pre tr td th div section details summary ul ol table'.split(' '));

// Implied end tags, enough for real-world remote HTML: opening an element closes the open
// elements it may not sit in, looking only at the innermost written element (so O(1)
// amortised). Unwrapped elements are passed over, as a browser reading the output never
// sees them, so a second pass makes the same decisions as the first.
const closesP = 'p div ul ol table h1 h2 h3 h4 h5 h6 blockquote pre details summary hr section';
const implied = new Map<string, Set<string>>([
  ...closesP.split(' ').map((name) => [name, new Set(['p'])] as const),
  ['li', new Set(['li', 'p'])],
  ['tr', new Set(['tr', 'td', 'th'])],
  ['td', new Set(['td', 'th'])],
  ['th', new Set(['td', 'th'])],
  ['thead', new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])],
  ['tbody', new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])],
  ['tfoot', new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])],
  ['rt', new Set(['rt', 'rp'])],
  ['rp', new Set(['rt', 'rp'])],
]);

/** Classes kept on each element; a trailing * is a prefix. */
const classes: Record<string, readonly string[]> = {
  a: ['u-url', 'mention', 'hashtag', 'community', 'footnote-backref'],
  code: ['language-*'],
  // highlight.js tokens (hljs-*, with scope suffixes such as function_), Mastodon's h-card
  // and link-shortening spans, and spoilers.
  span: ['hljs-*', '*_', 'h-card', 'invisible', 'ellipsis', 'spoiler'],
  img: ['emoji'],
  sup: ['footnote-ref'],
  section: ['footnotes'],
  hr: ['footnotes-sep'],
  ol: ['footnotes-list'],
  li: ['footnote-item'],
};
/** Classes whose text stays out of the excerpt: footnotes, Mastodon's hidden link parts and PieFed's inline spoilers. */
const quietClasses = new Set(['footnotes', 'footnote-ref', 'invisible', 'spoiler']);
/** Links that are not "links found": mentions, hashtags and community references. */
const referenceClasses = new Set(['mention', 'hashtag', 'community']);

const footnoteId = /^(fn|fnref)[\w:-]{1,80}$/;
const fragment = /^#[\w:.-]{1,100}$/;
const schemes = new Set(['https:', 'http:', 'mailto:']);
const align = /^(left|center|right)$/;
// Matched against a trimmed value: no two whitespace runs meet, so it cannot backtrack.
const textAlign = /^text-align\s*:\s*(left|center|right)\s*;?$/i;
const dimension = /^\s*(?:(\d{1,4})(?:px)?|(\d{1,3})%)\s*$/;

/** The rel every outgoing link carries; target is never kept. */
const rel = 'noopener noreferrer nofollow ugc';

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;');
const serialize = (pairs: [string, string][]) => pairs.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');

/**
 * The URL a browser would follow for an href or src, canonical, or undefined when it is not
 * allowed: http, https and mailto only (http(s) for images), no credentials, and a relative
 * reference only against a base and only onto the base's own origin (so no
 * protocol-relative //host). Same-page fragments stay as they are.
 */
function safeUrl(raw: string, base: string | undefined, image = false): string | undefined {
  // As the URL parser does: drop leading and trailing C0 controls and spaces, and every tab and newline.
  const value = trimControls(raw.replace(/[\t\n\r]/g, ''));
  // An empty href is the page itself: PieFed writes one in place of a javascript: URL.
  if (value === '') return undefined;
  if (value.startsWith('#')) return !image && fragment.test(value) ? value : undefined;
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
  let url: URL;
  try {
    url = new URL(value, absolute ? undefined : base);
  } catch {
    return undefined;
  }
  if (!schemes.has(url.protocol) || (image && url.protocol === 'mailto:')) return undefined;
  if (url.username || url.password) return undefined;
  if (!absolute && url.origin !== new URL(base ?? 'about:blank').origin) return undefined;
  return url.href;
}

function trimControls(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

/** What the image hook returned, if allowed: absolute http(s), or a path on this origin. */
function rewritten(value: string): string | undefined {
  if (/^\/(?![/\\])/.test(value)) {
    const local = new URL(value, 'https://local.invalid');
    return local.origin === 'https://local.invalid' ? `${local.pathname}${local.search}${local.hash}` : undefined;
  }
  return safeUrl(value, undefined, true);
}

function classList(tag: string, value: string | undefined): string[] {
  const allowed = classes[tag];
  if (!allowed || !value) return [];
  const keep = (name: string) =>
    allowed.some((rule) =>
      rule.startsWith('*') ? name.endsWith(rule.slice(1)) : rule.endsWith('*') ? name.startsWith(rule.slice(0, -1)) : name === rule,
    );
  return [...new Set(value.split(/\s+/).filter((name) => name.length <= 64 && /^[\w+#.-]+$/.test(name) && keep(name)))];
}

/** Lemmy's table alignment, `text-align: left` and nothing else, from a style attribute. */
function styleAlign(style: string | undefined): string | undefined {
  if (style === undefined || style.length > 200) return undefined;
  return textAlign.exec(style.trim())?.[1]?.toLowerCase();
}

function size(value: string | undefined): string | undefined {
  const match = value === undefined ? null : dimension.exec(value);
  if (!match) return undefined;
  if (match[1]) return String(Number(match[1]));
  return Number(match[2]) <= 100 ? `${Number(match[2])}%` : undefined;
}

/**
 * How many containers a browser inserts above a table part written inside `parent`: a
 * tbody above a row in a table, and a row above a cell outside one. They count toward the
 * depth cap, since the browser's tree is the one that has to stay within it.
 */
function insertedContainers(tag: string, parent: string | undefined): number {
  if (tag === 'tr') return parent === 'table' ? 1 : 0;
  if (tag !== 'td' && tag !== 'th') return 0;
  return parent === 'table' ? 2 : parent === 'tbody' || parent === 'thead' || parent === 'tfoot' ? 1 : 0;
}

interface Frame {
  /** The source element name, matched by end tags. */
  name: string;
  /** The element written out, or undefined when this one is unwrapped or dropped. */
  out: string | undefined;
  /** The innermost written frame at or below this one on the stack: the element a browser is in here. */
  current: Frame | undefined;
  /** A written frame's depth in the tree a browser builds (inserted table containers included). */
  level: number;
  drop: boolean;
  quiet: boolean;
  /** A summary inside a quiet details: its text is excerpted again. */
  loud: boolean;
  link: boolean;
}

class Sanitizer implements TokenizerCallbacks {
  private html = '';
  private plain = '';
  private readonly links = new Set<string>();
  private readonly stack: Frame[] = [];
  /** Open frames per source name, so an end tag with no open element costs O(1). */
  private readonly open = new Map<string, number>();
  private dropDepth = 0;
  private quietDepth = 0;
  private linkDepth = 0;
  private tag = '';
  private attributeName = '';
  private attributeValue = '';
  private attributes = new Map<string, string>();

  private readonly input: string;
  private readonly context: SanitizeContext;

  constructor(input: string, context: SanitizeContext) {
    this.input = input;
    this.context = context;
  }

  result(truncated: boolean): SanitizedHtml {
    while (this.stack.length > 0) this.pop();
    return { html: this.html, excerpt: excerpt(this.plain, this.context.excerptLength), links: [...this.links], truncated };
  }

  // Tokenizer callbacks. Positions index this.input, which is written in one piece.
  onopentagname(start: number, end: number): void {
    const name = this.input.slice(start, end).toLowerCase();
    this.tag = name === 'image' ? 'img' : name;
    this.attributes = new Map();
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
    this.start(this.tag, this.attributes);
  }
  onselfclosingtag(): void {
    // HTML ignores the slash: <b/> opens a b.
    this.start(this.tag, this.attributes);
  }
  onclosetag(start: number, end: number): void {
    this.end(this.input.slice(start, end).toLowerCase());
  }
  ontext(start: number, end: number): void {
    this.text(this.input.slice(start, end));
  }
  ontextentity(codepoint: number): void {
    this.text(String.fromCodePoint(codepoint));
  }
  oncdata(): void {}
  oncomment(): void {}
  ondeclaration(): void {}
  onprocessinginstruction(): void {}
  onend(): void {}

  private get top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** The depth of the innermost written element; a new element goes one (or more) below it. */
  private get level(): number {
    return this.top?.current?.level ?? 0;
  }

  private start(name: string, attributes: Map<string, string>): void {
    // The innermost written element, once implied end tags have closed what this one may not
    // sit in. Dropped content writes nothing, so it closes nothing.
    const closes = this.dropDepth === 0 ? implied.get(name) : undefined;
    let current = this.top?.current;
    while (closes && current && closes.has(current.out!)) {
      while (this.pop() !== current);
      current = this.top?.current;
    }
    if (this.dropDepth > 0 || dropped.has(name)) {
      if (!voids.has(name)) this.push({ name, out: undefined, current, level: 0, drop: true, quiet: false, loud: false, link: false });
      return;
    }
    if (blocks.has(name)) this.excerptText(' ');
    const out = kept.get(name);
    if (name === 'img') return this.image(attributes);
    if (voids.has(name)) {
      if (out && this.level < this.context.maxDepth) this.html += `<${out}${serialize(this.attributesOf(name, out, attributes))}>`;
      return;
    }
    const sourceClasses = (attributes.get('class') ?? '').split(/\s+/);
    const quiet = name === 'details' || name === 'tg-spoiler' || sourceClasses.some((c) => quietClasses.has(c));
    const loud = name === 'summary' && this.top?.name === 'details' && this.top.quiet;
    const level = (current?.level ?? 0) + 1 + (out ? insertedContainers(out, current?.out) : 0);
    let written: string | undefined;
    if (out && level <= this.context.maxDepth && !(out === 'a' && this.linkDepth > 0)) {
      const pairs = this.attributesOf(name, out, attributes);
      // A link that lost its href (and is no footnote target) is unwrapped.
      if (out !== 'a' || pairs.some(([attribute]) => attribute === 'href' || attribute === 'id')) {
        this.html += `<${out}${serialize(pairs)}>`;
        written = out;
      }
    }
    const frame: Frame = { name, out: written, current, level, drop: false, quiet, loud, link: written === 'a' };
    if (written) frame.current = frame;
    this.push(frame);
  }

  private end(name: string): void {
    if (voids.has(name) || !this.open.get(name)) return;
    let frame: Frame | undefined;
    do frame = this.pop();
    while (frame && frame.name !== name);
  }

  private push(frame: Frame): void {
    this.stack.push(frame);
    this.open.set(frame.name, (this.open.get(frame.name) ?? 0) + 1);
    if (frame.drop) this.dropDepth++;
    if (frame.quiet) this.quietDepth++;
    if (frame.loud) this.quietDepth--;
    if (frame.link) this.linkDepth++;
  }

  private pop(): Frame | undefined {
    const frame = this.stack.pop();
    if (!frame) return undefined;
    this.open.set(frame.name, (this.open.get(frame.name) ?? 1) - 1);
    if (frame.out) this.html += `</${frame.out}>`;
    if (frame.drop) this.dropDepth--;
    if (frame.quiet) this.quietDepth--;
    if (frame.loud) this.quietDepth++;
    if (frame.link) this.linkDepth--;
    if (blocks.has(frame.name)) this.excerptText(' ');
    return frame;
  }

  private text(text: string): void {
    if (this.dropDepth > 0) return;
    const clean = text.replaceAll('\0', '');
    this.html += escapeText(clean);
    if (this.quietDepth === 0) this.excerptText(clean);
  }

  /** Collects excerpt text until there is enough to cut from. */
  private excerptText(text: string): void {
    if (this.plain.length <= this.context.excerptLength * 2) this.plain += text;
  }

  private image(attributes: Map<string, string>): void {
    const src = safeUrl(attributes.get('src') ?? '', this.context.baseUrl, true);
    const alt = (attributes.get('alt') ?? '').slice(0, 1000);
    const room = this.level < this.context.maxDepth;
    if (src && this.context.images === 'inline' && room) {
      const loaded = this.context.rewriteImageUrl ? this.context.rewriteImageUrl(src) : src;
      const url = loaded === null ? undefined : rewritten(loaded);
      if (url) {
        this.html += `<img${serialize([['src', url], ...this.attributesOf('img', 'img', attributes), ['loading', 'lazy']])}>`;
        return;
      }
    }
    // Shown as a link to the image, or as its alt text inside another link, without a src or
    // where a link would pass the depth cap.
    if (src && this.linkDepth === 0 && room) this.html += `<a href="${escapeAttribute(src)}" rel="${rel}">${escapeText(alt || src)}</a>`;
    else this.html += escapeText(alt);
  }

  /** The attributes kept on an element, checked, as name and value pairs. */
  private attributesOf(source: string, tag: string, attributes: Map<string, string>): [string, string][] {
    const pairs: [string, string][] = [];
    const add = (name: string, value: string | undefined) => {
      if (value !== undefined && value !== '') pairs.push([name, value]);
    };
    const id = attributes.get('id');
    if ((tag === 'a' || tag === 'sup' || tag === 'li') && id && footnoteId.test(id)) add('id', id);
    switch (tag) {
      case 'a': {
        const href = safeUrl(attributes.get('href') ?? '', this.context.baseUrl);
        add('href', href);
        add('title', attributes.get('title')?.slice(0, 500));
        const kept = classList(tag, attributes.get('class'));
        add('class', kept.join(' '));
        if (href && !href.startsWith('#')) {
          add('rel', rel);
          if (!kept.some((c) => referenceClasses.has(c))) this.links.add(href);
        }
        break;
      }
      case 'img':
        add('alt', attributes.get('alt')?.slice(0, 1000));
        add('title', attributes.get('title')?.slice(0, 500));
        add('width', size(attributes.get('width')));
        add('height', size(attributes.get('height')));
        add('align', attributes.get('align')?.toLowerCase().match(align)?.[1]);
        add('class', classList(tag, attributes.get('class')).join(' '));
        break;
      case 'ol': {
        const start = attributes.get('start');
        if (start && /^\d{1,9}$/.test(start)) add('start', String(Number(start)));
        add('class', classList(tag, attributes.get('class')).join(' '));
        break;
      }
      case 'th':
      case 'td':
        add('align', attributes.get('align')?.toLowerCase().match(align)?.[1] ?? styleAlign(attributes.get('style')));
        break;
      case 'span':
        add('class', source === 'tg-spoiler' ? 'spoiler' : classList(tag, attributes.get('class')).join(' '));
        break;
      default:
        add('class', classList(tag, attributes.get('class')).join(' '));
    }
    return pairs;
  }
}

function excerpt(plain: string, length: number): string {
  const text = plain.replace(/\s+/g, ' ').trim();
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const space = cut.lastIndexOf(' ');
  return `${(space > length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Sanitises HTML with resolved options; renderMarkdown calls it on its own output. */
export function sanitize(html: string, context: SanitizeContext, maxLength: number): SanitizedHtml {
  const truncated = html.length > maxLength;
  let input = truncated ? html.slice(0, maxLength) : html;
  // A cut inside a tag drops the partial tag rather than leaving its start as text.
  if (truncated && input.lastIndexOf('<') > input.lastIndexOf('>')) input = input.slice(0, input.lastIndexOf('<'));
  const sanitizer = new Sanitizer(input, context);
  const tokenizer = new Tokenizer({ decodeEntities: true }, sanitizer);
  tokenizer.write(input);
  tokenizer.end();
  return sanitizer.result(truncated);
}

/**
 * Sanitises HTML that arrived in a remote object's `content` (Lemmy, PieFed, Mbin, Mastodon)
 * for display: the allowlist above, safe URLs only, no styles, handlers or data: URLs, with
 * depth and length caps, links marked nofollow, and images through the rewrite hook.
 */
export function sanitizeRemoteHtml(html: string, options: SanitizeOptions & SanitizeHooks = {}): SanitizedHtml {
  const { rewriteImageUrl, ...data } = options;
  const checked = SanitizeOptions.assert(data);
  const context: SanitizeContext = {
    baseUrl: checked.baseUrl,
    images: checked.images ?? 'inline',
    rewriteImageUrl,
    maxDepth: checked.maxDepth ?? htmlMaxDepth,
    excerptLength: checked.excerptLength ?? defaultExcerptLength,
  };
  return sanitize(html, context, checked.maxLength ?? remoteHtmlMaxLength);
}
