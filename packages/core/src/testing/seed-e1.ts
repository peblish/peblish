import { communityBlocks, instanceBlocks, personBlocks } from '../blocks/tables.ts';
import { writer } from '../db/write.ts';

// Lane E1's seeds (blocks, then profiles). Test code only.

type Row = { id: string };
type BlockTarget = (Row & { kind: string }) | { instance: Row };

/**
 * A block row, as a mutation would leave it but without the follow clean-up or the events.
 * The target is an actor row (a Group goes to the community blocks, anything else to the
 * person blocks) or `{ instance }` for an instance block.
 */
export async function seedBlock(blocker: Row, target: BlockTarget): Promise<void> {
  const db = writer();
  if ('instance' in target) {
    await db.insert(instanceBlocks).values({ blockerId: blocker.id, instanceId: target.instance.id }).onConflictDoNothing();
  } else if (target.kind === 'Group') {
    await db.insert(communityBlocks).values({ blockerId: blocker.id, communityId: target.id }).onConflictDoNothing();
  } else {
    await db.insert(personBlocks).values({ blockerId: blocker.id, blockedId: target.id }).onConflictDoNothing();
  }
}
