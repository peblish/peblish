import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { siteBans } from '../bans/tables.ts';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { localUser, seedActor } from '../testing/seed.ts';
import { outboxEvents } from '../testing/seed-az.ts';
import { seedLocalInstance } from '../testing/seed-fed-a.ts';
import { declareAgeAs } from './age.ts';

beforeEach(truncateAll);

const now = new Date('2026-11-09T12:00:00Z');
const rows = async () => db().select().from(ageDeclarations);

async function person() {
  const { instance } = await seedLocalInstance();
  return seedActor(instance, 'Person', 'sam');
}

describe('declareAgeAs', () => {
  test('under 16 writes nothing, a missing or false date is refused', async () => {
    const sam = await person();
    expect(await declareAgeAs(localUser(sam.id), { day: '10', month: '11', year: '2010' }, now)).toEqual({
      ok: false,
      reason: 'age.under_16',
    });
    expect(await declareAgeAs(localUser(sam.id), { day: '31', month: '2', year: '1990' }, now)).toEqual({
      ok: false,
      reason: 'age.declaration_required',
    });
    expect(await declareAgeAs({ kind: 'anonymous' }, { day: '1', month: '1', year: '1990' }, now)).toEqual({
      ok: false,
      reason: 'auth.required',
    });
    expect(await rows()).toEqual([]);
    expect(await outboxEvents()).toEqual([]);
  });

  test('16 or older writes one row and one event, and a repeat writes nothing', async () => {
    const sam = await person();
    // Turns 16 today.
    expect(await declareAgeAs(localUser(sam.id), { day: '9', month: '11', year: '2010' }, now)).toEqual({ ok: true, created: true });
    expect(await rows()).toHaveLength(1);
    expect(await db().select().from(ageDeclarations).where(eq(ageDeclarations.actorId, sam.id))).toHaveLength(1);
    expect(await outboxEvents()).toEqual([{ type: 'age.declared', v: 1, actorId: sam.id }]);

    expect(await declareAgeAs(localUser(sam.id), { day: '1', month: '1', year: '1980' }, now)).toEqual({ ok: true, created: false });
    expect(await rows()).toHaveLength(1);
    expect(await outboxEvents()).toHaveLength(1);
  });

  test('a site-banned person cannot declare', async () => {
    const sam = await person();
    await writer().insert(siteBans).values({ actorId: sam.id, source: 'local' });
    expect(await declareAgeAs(localUser(sam.id), { day: '1', month: '1', year: '1980' }, now)).toEqual({
      ok: false,
      reason: 'auth.site_banned',
    });
    expect(await rows()).toEqual([]);
    expect(await outboxEvents()).toEqual([]);
  });
});
