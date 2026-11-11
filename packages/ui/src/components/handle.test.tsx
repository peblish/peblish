import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { BidiText, Handle, handleHost, neutraliseBidi } from './handle.tsx';

// Remote names and hosts come from other servers. A directional override (U+202E) or isolate
// (U+2066) in one could reorder what follows it, so `evil@evil.example` could be drawn to read
// as another account on another server. Escapes only: this file holds no control character.
const controls = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C';
const anyControl = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;
// The replacement mark: U+203D, which the Inter Latin slice draws (U+FFFD would load the whole font).
const mark = '\u203D';

test('every directional control character is neutralised, and nothing else changes', () => {
  expect(neutraliseBidi(`a${controls}b`, '')).toBe('ab');
  expect(neutraliseBidi(`a${controls}b`)).toBe(`a${mark.repeat(controls.length)}b`);
  expect(neutraliseBidi('Zoë_نص-42')).toBe('Zoë_نص-42');
});

test('the username and the host are separate left-to-right isolated runs, the prefix with the name', () => {
  expect(renderToStaticMarkup(<Handle prefix="@" handle="jun@lemmy.world" />)).toBe(
    '<span class="pb-handle" dir="ltr"><bdi class="pb-handle__name" dir="ltr">@jun</bdi><bdi class="pb-handle__host" dir="ltr">@lemmy.world</bdi></span>',
  );
  expect(renderToStaticMarkup(<Handle prefix="!" handle="news" />)).toBe(
    '<span class="pb-handle" dir="ltr"><bdi class="pb-handle__name" dir="ltr">!news</bdi></span>',
  );
});

test('an override or isolate in the username cannot reach the host: each shows as a replacement mark', () => {
  const html = renderToStaticMarkup(<Handle prefix="@" handle={'jun\u202E\u2066moc.elpmaxe@evil.example'} />);
  expect(html).not.toMatch(anyControl);
  expect(html).toContain(`<bdi class="pb-handle__name" dir="ltr">@jun${mark}${mark}moc.elpmaxe</bdi>`);
  expect(html).toContain('<bdi class="pb-handle__host" dir="ltr">@evil.example</bdi>');
});

test('controls in the host are neutralised too, so the host cannot be drawn reversed', () => {
  const html = renderToStaticMarkup(<Handle prefix="!" handle={'news@\u202Eelpmaxe.live\u202C'} />);
  expect(html).not.toMatch(anyControl);
  expect(html).toContain(`<bdi class="pb-handle__host" dir="ltr">@${mark}elpmaxe.live${mark}</bdi>`);
});

test('the host is what follows the last @, so an @ inside a remote username cannot pose as the host', () => {
  expect(renderToStaticMarkup(<Handle prefix="@" handle="alice@good.example@evil.example" />)).toContain(
    '<bdi class="pb-handle__name" dir="ltr">@alice@good.example</bdi><bdi class="pb-handle__host" dir="ltr">@evil.example</bdi>',
  );
});

test('a display name is an isolated run with its controls removed', () => {
  expect(renderToStaticMarkup(<BidiText text={'Ana\u202E\u2067 (admin)\u200F'} />)).toBe('<bdi>Ana (admin)</bdi>');
});

test('the host of a handle is what follows its last @, and a local handle has none', () => {
  expect(handleHost('news@lemmy.world')).toBe('lemmy.world');
  expect(handleHost('alice@good.example@evil.example')).toBe('evil.example');
  expect(handleHost('news')).toBe('');
});
