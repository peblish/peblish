import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef } from '@peblish/schema/views';

/** An actor row as a reference: `name` for a local actor, `name@host` for a remote one (views.ts: ActorRef.handle). */
export function actorRef(row: {
  id: Uuid;
  apId: string;
  kind: ActorRef['kind'];
  name: string;
  displayName: string | null;
  local: boolean;
  host: string;
}): ActorRef {
  return {
    id: row.id,
    apId: row.apId,
    kind: row.kind,
    name: row.name,
    displayName: row.displayName,
    local: row.local,
    handle: row.local ? row.name : `${row.name}@${row.host}`,
  };
}
