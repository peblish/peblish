import { boolean, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, id } from '../columns.ts';

// better-auth's tables (emailAndPassword plus the twoFactor plugin) for its Drizzle adapter.
// Pass them as drizzleAdapter(db, { provider: 'pg', schema: { user: authUser, session:
// authSession, account: authAccount, verification: authVerification, twoFactor: authTwoFactor } })
// with advanced.database.generateId returning a uuidv7. The TypeScript keys are better-auth's
// field names; the SQL names are snake_case. Lane A owns their configuration.

export const authUser = pgTable('auth_user', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
  /** Site role, as better-auth's admin plugin spells it: 'user' or 'admin'. */
  role: text('role').notNull().default('user'),
  createdAt: createdAt(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const authSession = pgTable(
  'auth_session',
  {
    id: id(),
    token: text('token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    expiresAt: at('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  // expires_at serves the hourly sweep of expired sessions (identity/sessions/sweep.ts).
  (t) => [index('auth_session_user').on(t.userId), index('auth_session_expires_at').on(t.expiresAt)],
);

export const authAccount = pgTable(
  'auth_account',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: at('access_token_expires_at'),
    refreshTokenExpiresAt: at('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [index('auth_account_user').on(t.userId)],
);

export const authVerification = pgTable(
  'auth_verification',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [index('auth_verification_identifier').on(t.identifier)],
);

export const authTwoFactor = pgTable(
  'auth_two_factor',
  {
    id: id(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: at('locked_until'),
  },
  (t) => [index('auth_two_factor_user').on(t.userId), index('auth_two_factor_secret').on(t.secret)],
);
