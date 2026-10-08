import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as config from '../../src/utils/config.ts';

const KEYS = [
  'PORT', 'NODE_ENV', 'CORS_ORIGIN', 'DATABASE_URL', 'HISTORY_DB_SSL', 'HISTORY_DB_POOL_MAX',
  'SPACETRACK_USER', 'SPACETRACK_PASS', 'ANALYTIC_COMPILER_MODEL', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
] as const;

/** Run fn with exactly the given env (others unset), restoring everything after. */
function withEnv(env: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void): void {
  const saved = new Map(KEYS.map(k => [k, process.env[k]]));
  try {
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('config accessors', () => {
  it('port defaults to 3001 and parses PORT', () => {
    withEnv({}, () => assert.equal(config.port(), 3001));
    withEnv({ PORT: '4242' }, () => assert.equal(config.port(), 4242));
  });

  it('isProd only for NODE_ENV=production', () => {
    withEnv({}, () => assert.equal(config.isProd(), false));
    withEnv({ NODE_ENV: 'development' }, () => assert.equal(config.isProd(), false));
    withEnv({ NODE_ENV: 'production' }, () => assert.equal(config.isProd(), true));
  });

  it('corsOrigin: * by default, split+trim on comma', () => {
    withEnv({}, () => assert.equal(config.corsOrigin(), '*'));
    withEnv({ CORS_ORIGIN: ' https://a.test , https://b.test' }, () =>
      assert.deepEqual(config.corsOrigin(), ['https://a.test', 'https://b.test']));
  });

  it('databaseUrl is trimmed and read per call', () => {
    withEnv({}, () => assert.equal(config.databaseUrl(), undefined));
    withEnv({ DATABASE_URL: '  fake://x  ' }, () => assert.equal(config.databaseUrl(), 'fake://x'));
  });

  it('historyDbSsl modes', () => {
    withEnv({}, () => assert.equal(config.historyDbSsl(), undefined));
    withEnv({ HISTORY_DB_SSL: 'disable' }, () => assert.equal(config.historyDbSsl(), undefined));
    withEnv({ HISTORY_DB_SSL: 'REQUIRE' }, () => assert.deepEqual(config.historyDbSsl(), { rejectUnauthorized: false }));
    withEnv({ HISTORY_DB_SSL: 'no-verify' }, () => assert.deepEqual(config.historyDbSsl(), { rejectUnauthorized: false }));
    withEnv({ HISTORY_DB_SSL: 'verify' }, () => assert.deepEqual(config.historyDbSsl(), { rejectUnauthorized: true }));
  });

  it('historyDbPoolMax: positive int else 8', () => {
    withEnv({}, () => assert.equal(config.historyDbPoolMax(), 8));
    withEnv({ HISTORY_DB_POOL_MAX: '12' }, () => assert.equal(config.historyDbPoolMax(), 12));
    withEnv({ HISTORY_DB_POOL_MAX: '0' }, () => assert.equal(config.historyDbPoolMax(), 8));
    withEnv({ HISTORY_DB_POOL_MAX: '-3' }, () => assert.equal(config.historyDbPoolMax(), 8));
    withEnv({ HISTORY_DB_POOL_MAX: 'abc' }, () => assert.equal(config.historyDbPoolMax(), 8));
  });

  it('spacetrack and api key accessors pass values through', () => {
    withEnv({}, () => {
      assert.equal(config.spacetrackUser(), undefined);
      assert.equal(config.geminiApiKey(), undefined);
      assert.equal(config.anthropicApiKey(), undefined);
    });
    withEnv({ SPACETRACK_USER: 'u', SPACETRACK_PASS: 'p', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, () => {
      assert.equal(config.spacetrackUser(), 'u');
      assert.equal(config.spacetrackPass(), 'p');
      assert.equal(config.geminiApiKey(), 'g');
      assert.equal(config.anthropicApiKey(), 'a');
    });
  });

  it('compiler model defaults and gemini prefix rule', () => {
    withEnv({}, () => {
      assert.equal(config.analyticCompilerModel(), 'claude-haiku-4-5');
      assert.equal(config.geminiCompilerModel(), 'gemini-3.1-flash-lite');
      assert.equal(config.analyticCompilerModelRaw(), undefined);
    });
    withEnv({ ANALYTIC_COMPILER_MODEL: 'claude-fake' }, () => {
      assert.equal(config.analyticCompilerModel(), 'claude-fake');
      assert.equal(config.geminiCompilerModel(), 'gemini-3.1-flash-lite');
    });
    withEnv({ ANALYTIC_COMPILER_MODEL: 'gemini-fake' }, () => {
      assert.equal(config.geminiCompilerModel(), 'gemini-fake');
    });
  });
});
