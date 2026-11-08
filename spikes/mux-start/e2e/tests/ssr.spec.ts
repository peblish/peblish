import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { GATE_PATHS, writeArtifact } from './support';

// Criterion (d): the no-JavaScript server HTML carries Mux markup. Fetched with curl.

const ROOT_HOOKS = [
  'muxui-button',
  'muxui-menu__root',
  'muxui-tabs',
  'muxui-table',
  'muxui-select',
  'muxui-number-field',
  'muxui-date-field',
  'muxui-markdown',
  'muxui-text-editor',
  'muxui-virtualizer',
  'muxui-color-mode-toggle',
];

const count = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].length;

for (const path of GATE_PATHS) {
  test(`curl ${path} returns Mux markup`, async ({ baseURL }) => {
    const html = execFileSync('curl', ['-sS', '--fail', '-H', 'Accept-Language: en-US', `${baseURL}${path}`], { encoding: 'utf8' });
    const name = path.slice(1);
    writeArtifact(`html/${name}.curl.html`, html);

    const virtualizer = /class="muxui-virtualizer"[\s\S]*?data-focus-scope-end/.exec(html)?.[0] ?? '';
    const markdown = /class="muxui-markdown">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    const editor = /class="muxui-text-editor">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    const facts = {
      path,
      hooks: Object.fromEntries(ROOT_HOOKS.map((hook) => [hook, count(html, new RegExp(`class="(?:[^"]*\\s)?${hook}(?:\\s[^"]*)?"`, 'g'))])),
      tableRows: count(html, /class="muxui-table__row"/g),
      tabs: count(html, /role="tab"/g),
      virtualizer: {
        rows: count(virtualizer, /role="option"/g),
        spacer: /<div role="presentation" style="[^"]*height:(\d+)px/.exec(virtualizer)?.[1] ?? null,
      },
      markdown: {
        table: /<table/.test(markdown),
        strikethrough: /<(del|s)>/.test(markdown),
        literalTildes: markdown.includes('~~'),
        codeBlock: /<pre[^>]*muxui-markdown__code-block/.test(markdown),
        codeLanguage: /data-muxui-language="([^"]*)"/.exec(markdown)?.[1] ?? null,
        highlightedTokens: /<span[^>]*style="[^"]*color/.test(markdown),
      },
      textEditor: {
        toolbar: editor.includes('muxui-text-editor__toolbar'),
        contentEditable: /contenteditable/i.test(editor),
      },
    };
    writeArtifact(`facts/ssr-${name}.json`, facts);

    for (const hook of ROOT_HOOKS) expect(facts.hooks[hook], hook).toBeGreaterThan(0);
    expect(facts.tableRows).toBe(10);
    expect(facts.tabs).toBe(3);
    expect(html).toMatch(/<html[^>]*\sdata-muxui-theme="standard-harbour"/);
    expect(html).toMatch(/<html[^>]*\sdata-muxui-color-scheme="light"/);
  });
}
