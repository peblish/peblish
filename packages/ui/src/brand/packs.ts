import type { SiteBrand } from '@peblish/schema/site-settings';
import { pack as feddit } from './feddit/pack.ts';
import type { BrandPack } from './pack.ts';

/** Every checked-in pack by its `site.brand` id; the schema's list and this one must name the same packs. */
const packs = { feddit } satisfies Record<Exclude<SiteBrand, ''>, BrandPack>;

/** The pack a `site.brand` value names, or null for none. */
export const brandPack = (id: SiteBrand): BrandPack | null => (id === '' ? null : packs[id]);
