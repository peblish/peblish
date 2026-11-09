// PieFed limits what a young remote account can post (four posts in its first day). Every peblish
// user a run creates is "young" the first time PieFed sees it, so before each group the lab backdates
// PieFed's remote users by two days. X1 measures the cap on purpose: its author is created after this
// runs, so it is never backdated.
import postgres from 'postgres';

const URL = process.env.PIEFED_DATABASE_URL ?? 'postgres://piefed:piefed@piefed-db:5432/piefed';

export async function backdatePiefedRemoteUsers(): Promise<void> {
  const sql = postgres(URL, { max: 1, onnotice: () => undefined });
  try {
    await sql`update "user" set created = now() - interval '2 days' where instance_id <> 1 and created > now() - interval '2 days'`;
  } finally {
    await sql.end();
  }
}
