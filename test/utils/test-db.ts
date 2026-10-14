import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { Database } from '../../src/database/types';

/**
 * Tests de integración: requieren un Postgres real con las migraciones
 * aplicadas (npm run migrate:up) y DATABASE_URL apuntando a él — nunca a
 * producción. Si no hay DATABASE_URL, los specs que usan este helper se
 * saltan (ver `describeIfDb`).
 */
export function createTestDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  });
}

export const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
