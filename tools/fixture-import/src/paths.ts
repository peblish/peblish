import { join } from 'node:path';

export const repoRoot = join(import.meta.dirname, '../../..');
/** Where the spike wrote its captures; gitignored, so only the maintainer's checkout has them. */
export const defaultCapturesDir = join(repoRoot, 'spikes/fedify-threadiverse/captures');
export const federationFixturesDir = join(repoRoot, 'packages/federation/src/test/fixtures');
export const coreSetsDir = join(repoRoot, 'packages/core/src/fixtures/sets');
