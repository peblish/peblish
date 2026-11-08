/**
 * Keys that occur in more than one member of `Areas`, or `never` when the areas are
 * disjoint. Per-area registries (events, refusals, authz actions) assert `never` so two
 * lanes cannot claim the same name.
 */
export type Overlap<Areas> = {
  [A in keyof Areas]: {
    [B in Exclude<keyof Areas, A>]: keyof Areas[A] & keyof Areas[B];
  }[Exclude<keyof Areas, A>];
}[keyof Areas];

/** Compiles only when `T` is `never`; the error names the offending keys. */
export type AssertNever<T extends never> = T;
