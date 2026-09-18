'use strict';
/**
 * Shared helpers for the API test suite (node:test, zero extra dependencies).
 *
 * Each suite boots the real server against its own throwaway POSTGRES database
 * on its own port, talks to it over HTTP, asserts against the raw database, and
 * drops the database afterwards. Isolation is per suite so suites can run
 * concurrently without seeing each other's rows.
 *
 * The database under test is created from db/schema.sql + db/seed.pg.js by
 * running the real seeder as a child process, the same command a developer
 * would run, so a broken bootstrap fails the suite loudly instead of silently
 * diverging from production setup.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');

require('dotenv').config();

// Every suite process is a test process, so say so before anything can open a
// database connection. db/pg.js refuses to connect to a non-test database when
// NODE_ENV=test (see db/testSafety.js), which is what stops a stray
// DATABASE_URL from pointing a suite at the developer's data.
process.env.NODE_ENV = 'test';

const { databaseName, isTestDatabaseName, testDatabaseName } = require('../db/testSafety');

const SERVER_DIR = path.join(__dirname, '..');
const BASE_URL = process.env.DATABASE_URL;

// Database-management connections (CREATE/DROP of each suite's throwaway
// database) target the cluster's maintenance database rather than the app's own
// database, so a test run never opens a session on the developer's data at all.
const MAINTENANCE_DB = 'postgres';

function urlFor(baseUrl, database) {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Boots the API for one test suite.
 * @param {object} opts
 * @param {string} opts.name  Unique suite name (names the throwaway database).
 * @param {number} opts.port  Port for this suite (keep unique across suites).
 */
function startServer({ name, port }) {
  if (!BASE_URL) throw new Error('DATABASE_URL is not set: copy server/.env.example to server/.env');

  const TEST_DB = testDatabaseName(BASE_URL, name);
  const TEST_URL = urlFor(BASE_URL, TEST_DB);
  const base = `http://localhost:${port}`;

  // Belt and braces: the derived name must carry the test marker and must never
  // resolve back to the database the developer runs the app against.
  if (!isTestDatabaseName(TEST_DB)) {
    throw new Error(`refusing to run: "${TEST_DB}" is not a test database name`);
  }
  if (TEST_URL === BASE_URL || TEST_DB === databaseName(BASE_URL)) {
    throw new Error(
      `refusing to run: the test database resolved to the application database ("${TEST_DB}")`
    );
  }

  const env = {
    ...process.env,
    DATABASE_URL: TEST_URL,
    PORT: String(port),
    NODE_ENV: 'test',
    SEED_SUPERADMIN_PASSWORD: 'TestPass_123!',
    SEED_PASTOR_PASSWORD: 'TestPass_123!',
    // The suites make many logins from one process/IP; the per-IP safety net
    // (LOGIN_RATE_LIMIT_MAX per 15 min) would otherwise start returning 429
    // and mask the per-account lockout behavior under test.
    LOGIN_RATE_LIMIT_MAX: '1000',
    // Never let the suite hit the real SMS/email gateways (a developer .env
    // may carry sandbox or placeholder creds). Unset = every send logs
    // 'pending' deterministically.
    AT_API_KEY: '',
    AT_USERNAME: '',
    SMTP_HOST: '',
  };

  // The suite's own handle on the test database. Point the shared pool at it
  // BEFORE requiring db/pg so every test-process query (and its numeric type
  // parsers) target the throwaway database, never the developer's data.
  process.env.DATABASE_URL = TEST_URL;

  let pool = null;
  function db() {
    if (!pool) pool = require('../db/pg');
    return pool;
  }

  // `?` placeholders keep the test SQL readable and identical in shape to the
  // app's query-building code (see utils/sqlParams.js).
  const { toParams } = require('../utils/sqlParams');

  async function query(sql, params = []) {
    await ready;
    return db().query(toParams(sql), params);
  }
  async function get(sql, params = []) {
    const { rows } = await query(sql, params);
    return rows[0];
  }
  async function all(sql, params = []) {
    const { rows } = await query(sql, params);
    return rows;
  }
  async function run(sql, params = []) {
    const { rowCount } = await query(sql, params);
    return rowCount;
  }

  let log = '';
  let exited = null; // exit code/null while running: surfaces early crashes.
  let child = null;

  async function withAdmin(fn) {
    const { Client } = require('pg');
    // Only ever used to CREATE/DROP this suite's throwaway database, so it
    // connects to the maintenance database, never the application database.
    const admin = new Client({ connectionString: urlFor(BASE_URL, MAINTENANCE_DB) });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  async function bootstrap() {
    // Start from a clean database so a crashed earlier run cannot poison this
    // one. WITH (FORCE) (PG13+) terminates any connection left holding it.
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${TEST_DB}`);
    });

    const seeded = spawnSync('node', ['db/seed.pg.js'], { cwd: SERVER_DIR, env, encoding: 'utf8' });
    if (seeded.status !== 0) {
      throw new Error(`seed failed (${TEST_DB}):\n${seeded.stdout}\n${seeded.stderr}`);
    }

    child = spawn('node', ['index.js'], {
      cwd: SERVER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('exit', (code) => { exited = code; });
  }

  const ready = bootstrap();

  async function waitReady(timeoutMs = 30000) {
    await ready; // surfaces bootstrap/seed failures with their real output
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited !== null) {
        throw new Error(`server exited early (code ${exited}). log:\n` + log);
      }
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('server did not become ready. log:\n' + log);
  }

  // `extraHeaders` is how a test asks for a specific language (X-Language,
  // Accept-Language) or exercises anything else a client sends beyond auth and
  // content type.
  async function api(method, url, token, body, extraHeaders = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    // `headers` matters for session renewal: the replacement token arrives in a
    // response header (X-Refreshed-Token), not the body.
    return { status: res.status, json, text, headers: res.headers };
  }

  async function stop() {
    if (child && exited === null) child.kill();
    // Wait for the exit event before any fallback: killing by PID after the
    // child is already gone risks hitting a recycled PID on Windows.
    const deadline = Date.now() + 3000;
    while (child && exited === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (child && exited === null && process.platform === 'win32') {
      // child.kill() is TerminateProcess on Windows, so this is a last resort.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 250));
    }

    // Release our side of the database before dropping it.
    if (pool) {
      try { await pool.end(); } catch {}
      pool = null;
    }
    try {
      await withAdmin(async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      });
    } catch (err) {
      console.error(`warning: could not drop test database ${TEST_DB}:`, err.message);
    }
  }

  return { child, base, env, url: TEST_URL, DB: TEST_DB, log: () => log, api, query, get, all, run, waitReady, stop };
}

module.exports = { startServer };
