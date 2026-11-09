// The duplicate-name guard the per-area registries rely on, checked by tsc. The expected
// error below turns into a typecheck failure if overlapping areas ever stop being one.
import type { AssertNever, Overlap } from './registry.ts';

type Disjoint = { posts: { 'post.created': 1 }; comments: { 'comment.created': 2 } };
type Clashing = { a: { x: 1 }; b: { x: 2 } };

export type DisjointPasses = AssertNever<Overlap<Disjoint>>;
// @ts-expect-error two areas both register x
export type OverlapFails = AssertNever<Overlap<Clashing>>;

/** The overlap names the clashing key. */
export const clash: Overlap<Clashing> = 'x';
