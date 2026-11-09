import { type } from 'arktype';
import type { AssertNever, Overlap } from './registry.ts';
import { refusalAreas, refusalDescriptions } from './registry/refusals.gen.ts';

/** Every reason an authorization or service can refuse. Closed: assembled from refusals/<area>.ts. */
export type RefusalReason = keyof typeof refusalDescriptions;

export const refusalReasons = Object.keys(refusalDescriptions) as RefusalReason[];

export const RefusalReason = type.enumerated(...refusalReasons);

/** Developer-facing description of each reason; user-facing text belongs in the web i18n catalogues. */
export function describeRefusal(reason: RefusalReason): string {
  return refusalDescriptions[reason];
}

export type DuplicateRefusals = AssertNever<Overlap<typeof refusalAreas>>;
