import { expect, test } from 'vitest';
import { readPageMeta } from './html.ts';

const page = (head: string, body = '<p>hi</p>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test('Open Graph wins over Twitter cards and the plain title and description', () => {
  const html = page(`
    <title>Plain title</title>
    <meta name="description" content="Plain description">
    <meta name="twitter:title" content="Twitter title">
    <meta property="og:title" content="OG &amp; title">
    <meta property="og:description" content="OG description">
    <meta property="og:image" content="/img/cover.png">
    <meta name="twitter:image" content="https://cdn.example/other.png">`);
  expect(readPageMeta(html, 'https://example.com/a/b')).toEqual({
    title: 'OG & title',
    description: 'OG description',
    image: 'https://example.com/img/cover.png',
  });
});

test('without Open Graph the <title>, the description and the Twitter image are used, whitespace collapsed', () => {
  const html = page(`<title>
      A   long
      title &mdash; here</title>
    <meta name="description" content=" line one
      line two ">
    <meta name="twitter:image" content="https://cdn.example/t.jpg">`);
  expect(readPageMeta(html, 'https://example.com/')).toEqual({
    title: 'A long title — here',
    description: 'line one line two',
    image: 'https://cdn.example/t.jpg',
  });
});

test('only the head counts: tags in the body, and after </head>, are the page, not its description', () => {
  const html = `<html><head><title>Real</title></head><meta property="og:title" content="Spoofed"><body><meta property="og:image" content="https://x.example/a.png"><title>Other</title></body></html>`;
  expect(readPageMeta(html, 'https://example.com/')).toEqual({ title: 'Real', description: null, image: null });
});

test('image URLs must be http or https without credentials; titles and descriptions are capped', () => {
  for (const image of [
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'ftp://x.example/a.png',
    'https://u:p@x.example/a.png',
    'http://[bad',
  ]) {
    expect(readPageMeta(page(`<meta property="og:image" content="${image}">`), 'https://example.com/').image, image).toBeNull();
  }
  const long = 'x'.repeat(5000);
  const meta = readPageMeta(
    page(`<meta property="og:title" content="${long}"><meta property="og:description" content="${long}">`),
    'https://example.com/',
  );
  expect([meta.title?.length, meta.description?.length]).toEqual([200, 500]);
});

test('markup that is not a page gives nothing, and hostile nesting stays fast', () => {
  expect(readPageMeta('', 'https://example.com/')).toEqual({ title: null, description: null, image: null });
  expect(readPageMeta('{"json": true}', 'https://example.com/')).toEqual({ title: null, description: null, image: null });
  const hostile = `<head>${'<a><b><i><meta '.repeat(20_000)}`;
  const started = performance.now();
  readPageMeta(hostile, 'https://example.com/');
  expect(performance.now() - started).toBeLessThan(500);
});
