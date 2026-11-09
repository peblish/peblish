import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clearDraft, readDraft, removeUnscopedDrafts, writeDraft } from './drafts.ts';

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
