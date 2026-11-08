import { type } from 'arktype';
import { Entities } from '../corpus.ts';

// The fixture manifest (manifest.json), written by tools/fixture-import from the spike
// captures. Each entry is one captured wire document, committed under wire/, and says
// where it came from, what it maps to, and which documented vocabulary (../vocabulary.ts)
// may differ after the round trip.

export const Software = type({
  /** lemmy, piefed, mbin, or feddit-spike (the Phase 0 spike on Fedify 2.4.5, whose outbound peers accepted). */
  name: "'lemmy' | 'piefed' | 'mbin' | 'feddit-spike'",
  version: 'string',
});

export const Allowed = type({
  /** The diff path, with array indices: `object.object.tag[0]`. */
  path: 'string',
  change: "'dropped' | 'added' | 'changed'",
  /** The vocabulary entry that documents it. */
  vocabulary: 'string',
});

/**
 * A committed wire document, relative to this directory: a .json file beneath wire/ named by
 * plain segments, so no traversal (`..`, escaped or not), absolute path or URL, or backslash.
 */
export const FixturePath = type(/^wire(?:\/[\w-][\w.-]*)+\.json$/).describe('a .json path beneath wire/ without traversal');

export const ManifestEntry = type({
  id: 'string',
  software: Software,
  /** The document's shape: `Create(Page)`, `Announce(Undo(Like))`, `Group`. */
  type: 'string',
  /** inbound: received by the spike; outbound: sent by it; fetched: a GET it made; peer-log: a peer's own record of what it sent. */
  direction: "'inbound' | 'outbound' | 'fetched' | 'peer-log'",
  source: {
    /** Capture file under spikes/fedify-threadiverse/captures/ (gitignored; the copy is `fixture`). */
    file: 'string',
    /** 1-based line of the JSON Lines record. */
    line: 'number.integer >= 1',
    /** JSON pointer to the document inside the record; `json-string` when it is stored as JSON text. */
    pointer: 'string',
    'encoding?': "'json-string'",
    /** When the capture was recorded. */
    at: 'string.date.iso',
  },
  fixture: FixturePath,
  entity: type.enumerated(...Entities),
  allowed: Allowed.array(),
});
export type ManifestEntry = typeof ManifestEntry.infer;

export const Manifest = type({
  version: "'1'",
  entries: ManifestEntry.array(),
});
export type Manifest = typeof Manifest.infer;
