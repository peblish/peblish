// S1 and R1 need lanes that have not merged yet. They are registered so the table of results
// lists them as pending, and the comment says what each will assert.
import type { Group } from '../context.ts';
import { Pending } from '../lab.ts';

export const pending: Group = {
  ids: ['S1', 'R1'],
  async run(ctx) {
    const { rec } = ctx;
    for (const peer of ctx.peers) {
      // S1: an instance-wide ban of a peer's user by a peblish admin federates (Block of the person
      // with the instance as target), the user can neither post nor comment in !lab, and a ban the
      // peer sends for its own user arrives as an inbound Block and is applied or refused with an
      // exact reason. Needs the MODF lane (M06).
      await rec.scenario('S1', peer.name, async () => {
        throw new Pending('MODF', 'instance-wide bans both ways wait for the MODF lane');
      });
      // R1: a report on a peblish post made on the peer arrives as a Flag and opens a report; a
      // report by a peblish user on a peer's post leaves as a Flag to the peer. Needs the REP lane (M01).
      await rec.scenario('R1', peer.name, async () => {
        throw new Pending('REP', 'Flag in and out wait for the REP lane');
      });
    }
  },
};
