import { defineConfig } from 'drizzle-kit';

// G0's tables live in src/db/tables; a lane that needs a new table adds src/<area>/tables.ts
// and asks root to generate the migration (migrations and the journal are root-owned).
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/tables/*.ts', './src/*/tables.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://peblish:peblish@127.0.0.1:18432/peblish' },
  strict: true,
  verbose: true,
});
