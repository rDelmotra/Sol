// Shared by the DB-backed ssa tests: a throwaway schema in the database DATABASE_URL points at, with every history migration applied.
// The tests skip when DATABASE_URL is not set. Never point DATABASE_URL at a shared or production database when running them.
import pg from 'pg';
import { migrations } from '../../src/history/db/migrations/index.js';

export const DB_URL = process.env.DATABASE_URL;

export interface TestDb { pool: pg.Pool; schema: string; drop: () => Promise<void> }

export async function createTestDb(applyMigrations = true): Promise<TestDb> {
  const schema = `ssa_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Pool({ connectionString: DB_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: DB_URL, max: 4, options: `-c search_path=${schema}` });
  if (applyMigrations) for (const m of migrations) await pool.query(m.sql);
  return {
    pool, schema,
    drop: async () => {
      await pool.end();
      const a = new pg.Pool({ connectionString: DB_URL, max: 1 });
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}
