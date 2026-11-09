import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeEach, expect, test } from 'vitest';
import { truncateAll } from '../testing/db.ts';
import { db } from './read.ts';
import { authAccount, authSession, authTwoFactor, authUser, authVerification } from './tables/auth.ts';
import { writer } from './write.ts';

// Proves migration 0001's better-auth tables fit its Drizzle adapter (lane A configures the
// real instance in c/identity).

beforeEach(truncateAll);

test('better-auth signs up and opens a session on the 0001 tables', async () => {
  const auth = betterAuth({
    baseURL: 'https://feddit.test',
    secret: 'test-secret-test-secret-test-secret-0123',
    database: drizzleAdapter(writer(), {
      provider: 'pg',
      schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification, twoFactor: authTwoFactor },
    }),
    advanced: { database: { generateId: () => uuidv7() } },
    emailAndPassword: { enabled: true },
    plugins: [twoFactor()],
    telemetry: { enabled: false },
  });
  const result = await auth.api.signUpEmail({ body: { email: 'andrew@feddit.test', password: 'correct horse battery', name: 'Andrew' } });
  expect(result.user.email).toBe('andrew@feddit.test');
  const [user] = await db().select().from(authUser).where(eq(authUser.email, 'andrew@feddit.test'));
  expect(user).toMatchObject({ name: 'Andrew', emailVerified: false, role: 'user', twoFactorEnabled: false });
  expect(user?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  const sessions = await db().select().from(authSession).where(eq(authSession.userId, user!.id));
  expect(sessions).toHaveLength(1);
});
