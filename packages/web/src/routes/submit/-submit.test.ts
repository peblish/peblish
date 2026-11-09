import { expect, test } from 'vitest';
import { parseSubmission, type Submission } from './-submit.ts';

const community = '0192f5a0-1234-7abc-8def-0123456789ab';
const parsed = (fields: Record<string, string>, image: Uint8Array | null = null) => parseSubmission(fields, image) as Submission;

test('the fields become a submission: line breaks are LF, the title is one line, the checkbox is a boolean', () => {
  expect(parsed({ community, title: '  Two\n  lines ', body: 'a\r\nb\rc', nsfw: 'on', alt: 'x' })).toEqual({
    editing: null,
    community,
    type: 'text',
    title: 'Two lines',
    url: '',
    body: 'a\nb\nc',
    alt: 'x',
    nsfw: true,
    image: null,
  });
  expect(parsed({ community, title: 't' }).nsfw).toBe(false);
});

test('what is wrong is named by its code', () => {
  expect(parseSubmission({ title: 't' }, null)).toBe('community.required');
  expect(parseSubmission({ community: 'not-a-uuid', title: 't' }, null)).toBe('community.required');
  expect(parseSubmission({ community, title: ' ' }, null)).toBe('title.required');
  expect(parseSubmission({ community, type: 'link', title: 't', url: 'x' }, null)).toBe('url.invalid');
  expect(parseSubmission({ community, type: 'image', title: 't' }, new Uint8Array())).toBe('image.required');
  expect(parseSubmission({ edit: 'nope', title: 't' }, null)).toBe('target.not_found');
  expect(parseSubmission({ community, type: 'poll', title: 't' }, null)).toBe('generic');
});

test('an edit needs no community and a link post made new may leave the title for the page to give', () => {
  expect(parsed({ edit: community, title: 'New title' }).editing).toBe(community);
  expect(parseSubmission({ edit: community, type: 'link', url: 'https://example.org/', title: '' }, null)).toBe('title.required');
  expect(parsed({ community, type: 'link', url: 'https://example.org/', title: '' }).title).toBe('');
});
