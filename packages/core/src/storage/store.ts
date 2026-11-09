/** An object the store holds: its bytes and the content type it was put with. */
export type StoredObject = { body: Uint8Array; contentType: string | null };

/**
 * Where stored media lives (lane B2 builds the S3 adapter, `s3.ts`). Keys are chosen by this
 * codebase, never by a person: `[A-Za-z0-9._-]` segments joined by `/`, no empty or dot segment.
 */
export type ObjectStore = {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object, or null when the key holds none. */
  get(key: string): Promise<StoredObject | null>;
  /** Deleting a key that holds nothing succeeds. */
  delete(key: string): Promise<void>;
};

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws unless `key` is one the store accepts. */
export function assertKey(key: string): void {
  const segments = key.split('/');
  if (key.length > 512 || !segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
    throw new TypeError(`not a storage key: ${JSON.stringify(key.slice(0, 80))}`);
  }
}
