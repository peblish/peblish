import { expect, test } from '@playwright/test';
import { findActorByHandle } from '../../packages/core/src/bans/read.ts';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { inviteUses } from '../../packages/core/src/db/tables/site.ts';
import { writer } from '../../packages/core/src/db/write.ts';
import { seedInvite } from '../../packages/core/src/testing/seed-a.ts';
import { seedWorld, signedInAdmin, type World } from '../modlog/support.ts';
import { withoutScripts } from '../admin-safety/support.ts';
import { gotoHydrated } from '../support/route-marker.ts';

// Who used an invite is one disclosure away in the invites table. Without scripts the
// disclosure is a link to the page with that list rendered open.
test.skip(Boolean(process.env.BASE_URL), 'needs the lane database for its seed (DATABASE_URL)');
test.describe.configure({ timeout: 90_000 });

let world: World;
let invite: string;
let label: string;
test.beforeAll(async () => {
  world = seedWorld();
  const id = async (name: string) => (await findActorByHandle(name, ['Person']))!.id;
  label = `used ${world.suffix}`;
  invite = (await seedInvite(await id(world.admin.name), { maxUses: 3, useCount: 2, label })).id;
  for (const name of [world.bystander.name, world.author.name])
    await writer()
      .insert(inviteUses)
      .values({ inviteId: invite, actorId: await id(name) });
});
test.afterAll(async () => {
  await closePools();
});

test('the people who used an invite open in place, and without scripts through a link', async ({ page, browser }) => {
  await signedInAdmin(page, world);
  await gotoHydrated(page, '/admin/registration');
  const row = page.getByRole('row').filter({ hasText: label });
  await expect(row.getByText(`@${world.bystander.name}`)).toBeHidden();
  await row.getByRole('button', { name: '2 people' }).click();
  await expect(row.getByText(`@${world.bystander.name}`)).toBeVisible();
  await expect(row.getByText(`@${world.author.name}`)).toBeVisible();

  const plain = await withoutScripts(page, browser);
  await plain.goto('/admin/registration');
  const closed = plain.getByRole('row').filter({ hasText: label });
  await expect(closed.getByText(`@${world.bystander.name}`)).toBeHidden();
  const open = closed.getByRole('link', { name: '2 people' });
  await expect(open).toHaveAttribute('href', `/admin/registration?usedBy=${invite}#used-by-${invite}`);
  await open.click();
  await expect(plain).toHaveURL(new RegExp(`usedBy=${invite}`));
  const shown = plain.getByRole('row').filter({ hasText: label });
  await expect(shown.getByText(`@${world.bystander.name}`)).toBeVisible();
  await expect(shown.getByText(`@${world.author.name}`)).toBeVisible();
  // Rendered open, its label is plain text: no link or button of that name in the row.
  await expect(shown.getByRole('link', { name: '2 people' })).toHaveCount(0);
  await expect(shown.getByRole('button', { name: '2 people' })).toBeHidden();
});
