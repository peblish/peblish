import { createFederation, MemoryKvStore, type Federation } from '@fedify/fedify';

// Skeleton: the only package that imports @fedify/* (lint rule fedify-only-in-federation).
// Lane FED-A replaces the in-memory store with Postgres and adds the dispatchers
// (actors at their stored ap_id, WebFinger, NodeInfo 2.1, the instance actor at /).
export function createPeblishFederation(): Federation<void> {
  return createFederation<void>({ kv: new MemoryKvStore() });
}
