import * as m0001 from './0001_init.js';
import * as m0002 from './0002_ssa.js';
import * as m0003 from './0003_omm_updates.js';

// ============================================================
// Ordered migration list. The runner (migrate.ts) applies each entry not yet in
// schema_migrations, in array order, each in its own transaction. Append new
// migrations here — never edit an applied one.
// ============================================================

export interface Migration {
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  { name: m0001.name, sql: m0001.sql },
  { name: m0002.name, sql: m0002.sql },
  { name: m0003.name, sql: m0003.sql },
];
