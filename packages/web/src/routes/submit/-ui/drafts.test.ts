import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { carried, clearDraft, holds, readDraft, removeUnscopedDrafts, writeDraft } from './drafts.ts';

// A Storage with the parts the module uses; the tests run in Node, which has none.
function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  };
}

let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => vi.unstubAllGlobals());

const draft = { type: 'text', title: 'Mine', url: '', body: 'words', nsfw: false } as const;
const ann = { actorId: 'actor-ann', community: 'c1' };
const bob = { actorId: 'actor-bob', community: 'c1' };

test('a draft belongs to the person and the community it was written for', () => {
  expect(writeDraft(ann, draft)).toBe(true);
  expect(readDraft(ann)).toEqual(draft);
  // Another person in the same browser, or another community, finds nothing.
  expect(readDraft(bob)).toBeNull();
  expect(readDraft({ ...ann, community: 'c2' })).toBeNull();
  expect(readDraft({ ...ann, community: null })).toBeNull();
  clearDraft(ann);
  expect(readDraft(ann)).toBeNull();
});

test('the draft Browse carries is the person’s alone, apart from every community’s and from none chosen', () => {
  writeDraft({ ...ann, community: null }, { ...draft, title: 'Saved with none' });
  expect(writeDraft(carried(ann.actorId), draft)).toBe(true);
  expect(readDraft(carried(ann.actorId))).toEqual(draft);
  expect(readDraft(carried(bob.actorId))).toBeNull();
  expect(readDraft({ ...ann, community: null })?.title).toBe('Saved with none');
  expect(readDraft(ann)).toBeNull();
  clearDraft(carried(ann.actorId));
  expect(readDraft(carried(ann.actorId))).toBeNull();
  expect(readDraft({ ...ann, community: null })?.title).toBe('Saved with none');
});

test('a scope holds a draft until something else is written there or it is cleared', () => {
  writeDraft(ann, draft);
  expect(holds(ann, { ...draft })).toBe(true);
  expect(holds(ann, { ...draft, body: 'other words' })).toBe(false);
  writeDraft(ann, { ...draft, title: 'Newer' });
  expect(holds(ann, draft)).toBe(false);
  clearDraft(ann);
  expect(holds(ann, { ...draft, title: 'Newer' })).toBe(false);
});

test('a draft from before drafts were scoped to a person is never read and is removed', () => {
  storage.setItem('peblish.draft.c1', JSON.stringify(draft));
  storage.setItem('peblish.draft.none', JSON.stringify(draft));
  writeDraft(ann, draft);
  storage.setItem('unrelated', 'kept');
  expect(readDraft(ann)).toEqual(draft);
  expect(readDraft({ actorId: '', community: 'c1' })).toBeNull();

  removeUnscopedDrafts();
  expect([...storage.items.keys()].toSorted()).toEqual(['peblish.draft:actor-ann:c1', 'unrelated']);
});

test('blocked storage reads as no draft, refuses a write and clears nothing', () => {
  vi.stubGlobal('localStorage', {
    get length(): number {
      throw new Error('blocked');
    },
    key: () => {
      throw new Error('blocked');
    },
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  });
  expect(readDraft(ann)).toBeNull();
  expect(writeDraft(ann, draft)).toBe(false);
  expect(() => (clearDraft(ann), removeUnscopedDrafts())).not.toThrow();
});

test('a stored value that is not a draft reads as none', () => {
  storage.setItem('peblish.draft:actor-ann:c1', '{"type":"image"}');
  expect(readDraft(ann)).toBeNull();
  storage.setItem('peblish.draft:actor-ann:c1', 'not json');
  expect(readDraft(ann)).toBeNull();
});
