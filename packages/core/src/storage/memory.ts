import { assertKey, type ObjectStore, type StoredObject } from './store.ts';

/** An in-memory store for tests of code that puts and deletes media; never used by product code. */
export function memoryStore(): ObjectStore & { readonly objects: ReadonlyMap<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  return {
    objects,
    async put(key, body, contentType) {
      assertKey(key);
      objects.set(key, { body: new Uint8Array(body), contentType });
    },
    async get(key) {
      assertKey(key);
      return objects.get(key) ?? null;
    },
    async delete(key) {
      assertKey(key);
      objects.delete(key);
    },
  };
}
