'use strict';
/**
 * Guard rails that keep test runs away from a real database.
 *
 * The API test suite talks to a throwaway Postgres database per suite
 * (`<app-db>_test_<suite>`: see test/helpers.js). Because those databases are
 * created and dropped *by name* a mistake in the derivation, or a stray
 * DATABASE_URL, could point a test process at a developer's database and let
 * the bootstrap seed or the teardown wipe it. Two things prevent that:
 *
 *   1. The name is derived in exactly one place (testDatabaseName) and
 *      TEST_DB_PATTERN defines what a throwaway name must look like.
 *   2. assertTestDatabase() is called by db/pg.js, the pool every query goes
 *      through, so a process running with NODE_ENV=test refuses to open a
 *      connection to anything that is not a marked test database.
 *
 * The marker is required to be an explicit `test` segment, not merely "different
 * from the app database": a guard that cannot be satisfied by accidentally
 * reaching `vrt_cms` (or any future name) is the only useful one.
 */

/** A throwaway database name ends in `_test` or contains a `_test_` segment. */
const TEST_DB_PATTERN = /(^|_)test(_|$)/i;

/** The database name inside a connection string, or '' if it is unparseable. */
function databaseName(connectionString) {
  if (!connectionString) return '';
  try {
    return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, '')) || '';
  } catch {
    return '';
  }
}

/** Applies the marker rule to a bare database name (not a full URL). */
function isTestDatabaseName(name) {
  return TEST_DB_PATTERN.test(String(name || ''));
}

/** vrt_cms -> vrt_cms_test_phase2_digest (Postgres identifiers, lowercase). */
function testDatabaseName(baseUrl, name) {
  const base = databaseName(baseUrl) || 'postgres';
  const suffix = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `${base}_test_${suffix}`.slice(0, 63);
}

/** True when a connection string points at a marked throwaway database. */
function isTestDatabase(connectionString) {
  return isTestDatabaseName(databaseName(connectionString));
}

/**
 * Throws when a test process is about to touch a non-test database.
 * A no-op outside NODE_ENV=test: `npm start` and `npm run seed` are *supposed*
 * to reach the real database.
 */
function assertTestDatabase(connectionString, { purpose = 'database access' } = {}) {
  if (process.env.NODE_ENV !== 'test') return;

  const name = databaseName(connectionString);
  if (isTestDatabaseName(name)) return;

  throw new Error(
    `Refusing ${purpose}: NODE_ENV=test but the target database is "${name || '(unset)'}", ` +
      `which is not a test database. Throwaway databases must match ${TEST_DB_PATTERN} ` +
      '(test/helpers.js derives them from DATABASE_URL). This guard exists so the test ' +
      'suite can never write to the database named in .env.'
  );
}

module.exports = {
  TEST_DB_PATTERN,
  databaseName,
  isTestDatabaseName,
  isTestDatabase,
  testDatabaseName,
  assertTestDatabase,
};
