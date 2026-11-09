// Writes peers.json: what Lemmy 0.19.21 and PieFed 1.8.11 federate as `content` for each
// Markdown case below, plus the peer-authored source and content pairs in the Phase 0 spike
// captures. Needs the federation lab (lab/README.md: `make up`, `make seed`, `make ports`);
// it creates one post per peer and edits its body for every case. Run from the repository
// root of a checkout that has the spike captures (they are gitignored):
//
//   node packages/core/src/markdown/__fixtures__/capture.ts > packages/core/src/markdown/__fixtures__/peers.json
//   pnpm prettier --write packages/core/src/markdown/__fixtures__/peers.json
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const lemmy = process.env.LEMMY_URL ?? 'http://localhost:18201';
const piefed = process.env.PIEFED_URL ?? 'http://localhost:18202';
const spikeCaptures = process.env.CAPTURES ?? 'spikes/fedify-threadiverse/captures';
const password = 'lab-password-1';

export const cases: { id: string; source: string }[] = [
  { id: 'emphasis', source: 'Plain **bold** *italic* ***both*** _under_ __strong__ and a_b_c' },
  { id: 'headings', source: '# One\n\n## Two\n\n### Three ###\n\n###### Six\n\nSetext\n===' },
  { id: 'lists', source: '- one\n- two\n  - nested\n- three\n\n3. third\n4. fourth\n\n* star\n+ plus' },
  { id: 'loose-list', source: '- one\n\n- two' },
  { id: 'blockquote', source: '> quoted\n> > nested\n\n> after' },
  { id: 'code-span-html', source: 'Use `<b>bold</b>` and `a & b`' },
  { id: 'fenced-code', source: '```js\nconst a = 1 < 2 && "x";\n```' },
  { id: 'fenced-code-plain', source: '```\nplain <code>\n```' },
  { id: 'indented-code', source: 'para\n\n    indented <x>\n    line two' },
  { id: 'table', source: '| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | **b** | `c` |\n| d | e |' },
  { id: 'strikethrough', source: 'This is ~~gone~~ now' },
  { id: 'footnote', source: 'Text with a note[^1] and another[^n].\n\n[^1]: The note.\n[^n]: Named *note*.' },
  { id: 'sub-sup', source: 'H~2~O and x^2^ and ~~strike~~' },
  { id: 'spoiler', source: '::: spoiler Title here\nhidden *text*\n:::' },
  { id: 'spoiler-untitled', source: '::: spoiler\nhidden\n:::' },
  { id: 'spoiler-nested', source: '::: spoiler outer\nfirst\n\n::: spoiler inner\nsecond\n:::\n\nthird\n:::' },
  { id: 'image', source: '![alt text](https://example.com/a.png "A title")' },
  { id: 'image-size-equals', source: '![alt](https://example.com/a.png =100x50)' },
  { id: 'image-size-equals-width', source: '![alt](https://example.com/a.png =100x)' },
  { id: 'image-size-braces', source: '![alt](https://example.com/a.png){width=100 height=50}' },
  { id: 'image-size-title', source: '![alt](https://example.com/a.png "t" =100x50)' },
  { id: 'image-in-link', source: '[![alt](https://example.com/a.png)](https://example.com/)' },
  { id: 'autolink-bare', source: 'See https://example.com/path?q=1. And www.example.org too.' },
  { id: 'autolink-angle', source: '<https://example.com/a> and <me@example.com>' },
  { id: 'autolink-email', source: 'Mail me@example.com please' },
  { id: 'link-title', source: '[text](https://example.com/ "Title") and [rel](/c/foo)' },
  { id: 'link-reference', source: '[ref][r]\n\n[r]: https://example.com/ref' },
  { id: 'soft-break', source: 'line one\nline two' },
  { id: 'hard-break-spaces', source: 'line one  \nline two' },
  { id: 'hard-break-backslash', source: 'line one\\\nline two' },
  { id: 'mention-user', source: 'Hi @lemmyuser@lemmy.lab.test and @someone@example.com' },
  { id: 'mention-community', source: 'Join !lab@lemmy.lab.test or !pflab@piefed.lab.test' },
  { id: 'emoji', source: 'Smile :smile: and :custom_one: here' },
  { id: 'raw-html', source: 'Raw <b>bold</b> and <script>alert(1)</script> end' },
  { id: 'raw-html-block', source: '<div onclick="x()">block</div>\n\nafter' },
  { id: 'hr', source: 'above\n\n---\n\nbelow\n\n***' },
  { id: 'typographer', source: '"Double" and \'single\' -- en --- em ... (c) (tm) +-' },
  { id: 'escapes', source: '\\*not emphasis\\* &copy; &lt;tag&gt; 5 < 6 & 7' },
  { id: 'ruby', source: '{漢字|かんじ}' },
  { id: 'task-list', source: '- [ ] todo\n- [x] done' },
  { id: 'javascript-link', source: '[click](javascript:alert(1)) and ![x](javascript:alert(2))' },
  { id: 'data-link', source: '[d](data:text/html;base64,PHNjcmlwdD4=)' },
  { id: 'table-inline-html', source: '| a | b |\n| - | - |\n| <img src=x onerror=alert(1)> | `|` |' },
  { id: 'heading-inline', source: '## Title with `code` and [link](https://example.com/)' },
  { id: 'nested-emphasis-link', source: '**[bold link](https://example.com/)** and *[em](https://example.com/)*' },
  { id: 'long-paragraphs', source: 'First paragraph.\n\nSecond paragraph with *emphasis*.\n\n\n\nThird after blank lines.' },
  { id: 'unicode', source: 'Ünïcödé — “quotes” 🙂 <3' },
  { id: 'image-size-piefed', source: '![A cat :: align-left width=200px height=100px](https://example.com/cat.jpg)' },
  { id: 'image-size-percent', source: '![Logo :: width=50%](https://example.com/logo.png)' },
  { id: 'emoji-custom-lemmy', source: 'Hi ![blobcat](https://example.com/blobcat.png "emoji blobcat") there' },
  { id: 'link-parens', source: '[w](https://en.wikipedia.org/wiki/Foo_(bar)) and https://en.wikipedia.org/wiki/Foo_(bar)' },
  { id: 'autolink-trailing', source: '(see https://example.com/a), or https://example.com/b!' },
  { id: 'blockquote-list', source: '> - a\n> - b\n>\n> text' },
  { id: 'hashtag', source: '#notheading and a #hashtag here' },
  { id: 'sup-spaces', source: 'x^a b^ and x^a\\ b^' },
  { id: 'url-in-code', source: 'Code `https://example.com/x` here' },
  { id: 'numeric-entities', source: '&#60;script&#62; and &#x3C;b&#x3E;' },
  { id: 'reddit-spoiler', source: 'This is >!secret!< text' },
  { id: 'fenced-tilde', source: '~~~python\nprint("hi")\n~~~' },
];

type Json = { [key: string]: unknown };

async function call(url: string, body: unknown, token?: string, method = 'POST'): Promise<Json> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function content(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: 'application/activity+json' } });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return String((await response.json()).content);
}

const postOf = (answer: Json) => (answer.post_view as { post: { id: number; ap_id: string } }).post;

async function captureLab() {
  const lemmyToken = String((await call(`${lemmy}/api/v3/user/login`, { username_or_email: 'lemmyuser', password })).jwt);
  const piefedToken = String((await call(`${piefed}/api/alpha/user/login`, { username: 'pfuser', password })).jwt);
  const lemmyPost = postOf(await call(`${lemmy}/api/v3/post`, { name: 'markdown capture', community_id: 2, body: 'start' }, lemmyToken));
  const piefedPost = postOf(
    await call(`${piefed}/api/alpha/post`, { title: 'markdown capture', community_id: 1, body: 'start' }, piefedToken),
  );
  const out = [];
  for (const c of cases) {
    await call(`${lemmy}/api/v3/post`, { post_id: lemmyPost.id, body: c.source }, lemmyToken, 'PUT');
    await call(`${piefed}/api/alpha/post`, { post_id: piefedPost.id, title: 'markdown capture', body: c.source }, piefedToken, 'PUT');
    out.push({
      ...c,
      lemmy: await content(`${lemmy}${new URL(lemmyPost.ap_id).pathname}`),
      piefed: await content(`${piefed}/post/${piefedPost.id}`),
    });
  }
  return out;
}

/** Peer-authored objects with both `content` and a Markdown `source`, one per distinct text. */
function captureSpike() {
  const found = new Map<string, { peer: string; file: string; source: string; content: string }>();
  const visit = (value: unknown, file: string): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, file));
    if (!value || typeof value !== 'object') return;
    const object = value as Json;
    const source = object.source as Json | undefined;
    const host = typeof object.id === 'string' && URL.canParse(object.id) ? new URL(object.id).hostname : '';
    if (typeof object.content === 'string' && typeof source?.content === 'string' && /^(lemmy|piefed)\./.test(host)) {
      // Run ids and timestamps differ between otherwise identical texts.
      const key = `${host} ${source.content.replace(/\d{6,}/g, 'N')}`;
      if (!found.has(key)) found.set(key, { peer: host.split('.')[0]!, file, source: source.content, content: object.content });
    }
    for (const child of Object.values(object)) visit(child, file);
  };
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : /\.jsonl?$/.test(entry.name) ? [join(dir, entry.name)] : [],
    );
  for (const file of files(spikeCaptures)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      visit(row, relative(spikeCaptures, file));
      const logged = (row as Json | null)?.activity_json;
      if (typeof logged === 'string') visit(JSON.parse(logged), relative(spikeCaptures, file));
    }
  }
  return [...found.values()];
}

console.log(
  JSON.stringify({
    about: 'Federated content from the lab peers for each case, and peer pairs from the Phase 0 spike captures (capture.ts).',
    captured: new Date().toISOString().slice(0, 10),
    peers: { lemmy: '0.19.21', piefed: '1.8.11' },
    cases: await captureLab(),
    spike: captureSpike(),
  }),
);
