import { describe, expect, test } from 'vitest';
import { communityRulesMax, emptyValues, problemsOf, readFormValues, toPatch, type FormValues } from './-form.ts';

const values = (extra: Partial<FormValues>): FormValues => ({ ...emptyValues, name: 'news', ...extra });

describe('the community form', () => {
  test('reads a posted form: rules by row, languages and checkboxes by name, line breaks as LF', () => {
    const form = new FormData();
    form.set('name', ' news ');
    form.set('description', 'a\r\nb');
    form.set('rules.0.title', 'Be civil');
    form.set('rules.0.body', 'No harassment.');
    form.set('rules.2.title', 'No spam');
    form.set('lang.de', 'on');
    form.set('lang.xx', 'on');
    form.set('nsfl', 'on');
    form.set('indexable', 'on');
    expect(readFormValues(form)).toEqual({
      name: 'news',
      displayName: '',
      description: 'a\nb',
      rules: [
        { title: 'Be civil', body: 'No harassment.' },
        { title: 'No spam', body: '' },
      ],
      languages: ['de'],
      sensitive: false,
      nsfl: true,
      restricted: false,
      discoverable: false,
      indexable: true,
    });
  });

  test('makes the patch core takes: empty text clears, a row without a title is no rule, NSFL implies NSFW', () => {
    expect(
      toPatch(
        values({
          displayName: '  ',
          description: ' Hello ',
          rules: [
            { title: 'One', body: '' },
            { title: '   ', body: 'orphan' },
            { title: 'Two', body: ' text ' },
          ],
          nsfl: true,
        }),
      ),
    ).toMatchObject({
      displayName: null,
      description: 'Hello',
      rules: [
        { title: 'One', body: null },
        { title: 'Two', body: 'text' },
      ],
      sensitive: true,
      nsfl: true,
    });
  });

  test('names the field that is wrong, the same way for the browser and the server', () => {
    expect(problemsOf(values({}), true)).toEqual({});
    expect(problemsOf(values({ name: 'bad name' }), true)).toEqual({ name: true });
    expect(problemsOf(values({ name: 'bad name' }), false)).toEqual({});
    expect(problemsOf(values({ displayName: 'x'.repeat(101) }), false)).toEqual({ displayName: true });
    expect(problemsOf(values({ description: 'x'.repeat(10_001) }), false)).toEqual({ description: true });
    expect(problemsOf(values({ rules: Array.from({ length: communityRulesMax + 1 }, () => ({ title: 'r', body: '' })) }), false)).toEqual({
      rules: true,
    });
    expect(problemsOf(values({ rules: [{ title: 'x'.repeat(201), body: '' }] }), false)).toEqual({ rules: true });
  });
});
