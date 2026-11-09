import type { Uuid } from '@peblish/schema/ids';
import { describe, expect, test } from 'vitest';
import { chooseNsfw, hideNsfw, nsfwOnceMax, nsfwSetCookies, parseNsfwChoice } from './gate.ts';

const id = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}` as Uuid;

describe('the Hide NSFW cookies', () => {
  test('absent, garbage or too long means hide', () => {
    expect(parseNsfwChoice(null)).toEqual(hideNsfw);
    expect(parseNsfwChoice('peblish_nsfw=yes; peblish_nsfw_once=not-a-uuid')).toEqual(hideNsfw);
    expect(parseNsfwChoice(`peblish_nsfw_once=${id(1)},oops`)).toEqual(hideNsfw);
    const eleven = Array.from({ length: nsfwOnceMax + 1 }, (_, n) => id(n)).join(',');
    expect(parseNsfwChoice(`peblish_nsfw_once=${eleven}`)).toEqual(hideNsfw);
  });

  test('reads Show always and the communities opened once', () => {
    const ten = Array.from({ length: nsfwOnceMax }, (_, n) => id(n));
    expect(parseNsfwChoice(`a=b; peblish_nsfw=show; peblish_nsfw_once=${ten.join(',')}`)).toEqual({ always: true, once: ten });
    expect(parseNsfwChoice(`xpeblish_nsfw=show`)).toEqual(hideNsfw);
  });

  test('once adds a community once and keeps the newest ten; always and hide replace', () => {
    let choice = hideNsfw;
    for (let n = 0; n <= nsfwOnceMax; n++) choice = chooseNsfw(choice, 'once', id(n));
    expect(choice.once).toEqual(Array.from({ length: nsfwOnceMax }, (_, n) => id(n + 1)));
    expect(chooseNsfw(choice, 'once', id(5)).once.at(-1)).toBe(id(5));
    expect(chooseNsfw(choice, 'once', id(5)).once).toHaveLength(nsfwOnceMax);
    expect(chooseNsfw(hideNsfw, 'always', id(1))).toEqual({ always: true, once: [] });
    expect(chooseNsfw({ always: true, once: [id(1)] }, 'hide', id(1))).toEqual(hideNsfw);
  });

  test('cookies are HttpOnly and Lax, Secure on https; Show once ends with the browser', () => {
    const [always, once] = nsfwSetCookies({ always: true, once: [id(1)] }, true);
    expect(always).toBe(`peblish_nsfw=show; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${365 * 24 * 60 * 60}`);
    expect(once).toBe(`peblish_nsfw_once=${id(1)}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    expect(nsfwSetCookies(hideNsfw, false)).toEqual([
      'peblish_nsfw=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'peblish_nsfw_once=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ]);
  });
});
