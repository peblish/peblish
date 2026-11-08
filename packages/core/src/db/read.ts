import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { readPool } from './pools.ts';

/** Read-only Drizzle handle for queries outside a transaction. Writes through it fail. */
export const db = () => readPool().db;

/** Anything that can run queries: the read handle or a transaction's handle. */
export type Queryable = PgDatabase<PostgresJsQueryResultHKT>;
