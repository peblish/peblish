// The scanner seam. A provider looks at one image and says whether it is known abusive material.
// The local SHA-256 list is checked first (blocklist.ts); then each external provider here.
// Anything but a clear answer is a ScanError: the caller treats it as `failed`, never `clean`.

/** What a provider classifies a match as. `test` is the harmless drill image: it is quarantined, and no report is due. */
export type MatchClassification = 'csam' | 'harmful-abusive-material' | 'test';

export type ScanInput = { bytes: Uint8Array; mimeType: string; sha256: string };

export type ScanVerdict =
  | { result: 'no-match' }
  | {
      result: 'match';
      classification: MatchClassification;
      matchType: 'exact' | 'near' | null;
      /** The provider's answer as received, size-bounded (arachnid.ts), kept in the evidence manifest. */
      raw: unknown;
    };

/** The provider could not give a clear answer: an error, a timeout, a non-2xx status or a malformed body. The message holds no credential and no URL. */
export class ScanError extends Error {
  override readonly name = 'ScanError';
}

export interface ScanProvider {
  readonly name: string;
  scan(input: ScanInput, signal: AbortSignal): Promise<ScanVerdict>;
  /** The provider's hash-list version, for the manifest and the status line; null when it has none. */
  version?(signal: AbortSignal): Promise<string | null>;
}
