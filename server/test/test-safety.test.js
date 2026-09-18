'use strict';
/**
 * Tests for the test-database guard itself (db/testSafety.js).
 *
 * These are deliberately pure: no server, no database, no network. The guard is
 * the thing that keeps every other suite away from the developer's database, so
 * it must be provably correct even when no database is reachable.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  TEST_DB_PATTERN,
  databaseName,
  isTestDatabaseName,
  testDatabaseName,
  assertTestDatabase,
} = require('../db/testSafety');

const APP_URL = 'postgres://vrt_admin:secret@localhost:5432/vrt_cms';
const TEST_URL = 'postgres://vrt_admin:secret@localhost:5432/vrt_cms_test_phase2_digest';

/** Runs `fn` with NODE_ENV temporarily set to `value`. */
function withNodeEnv(value, fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

describe('test database naming', () => {
  it('derives a marked throwaway name from the application database', () => {
    assert.equal(testDatabaseName(APP_URL, 'phase2 digest'), 'vrt_cms_test_phase2_digest');
    assert.ok(isTestDatabaseName(testDatabaseName(APP_URL, 'anything')));
  });

  it('keeps the name inside Postgres identifier limits', () => {
    const derived = testDatabaseName(APP_URL, 'x'.repeat(200));
    assert.ok(derived.length <= 63, `expected <=63 chars, got ${derived.length}`);
  });

  it('falls back to the postgres maintenance database when the URL has none', () => {
    assert.equal(testDatabaseName('postgres://user:pw@localhost:5432', 'suite'), 'postgres_test_suite');
  });

  it('never marks the application database itself as a test database', () => {
    assert.equal(databaseName(APP_URL), 'vrt_cms');
    assert.equal(isTestDatabaseName('vrt_cms'), false);
    assert.equal(isTestDatabaseName(''), false);
    assert.equal(isTestDatabaseName(undefined), false);
    // A name that merely *contains* "test" is not enough: only an explicit
    // `test` segment counts.
    assert.equal(TEST_DB_PATTERN.test('vrt_cms_testing'), false);
    assert.equal(TEST_DB_PATTERN.test('contested'), false);
  });

  it('handles an unparseable connection string without crashing', () => {
    assert.equal(databaseName('not a url'), '');
    assert.equal(isTestDatabaseName(databaseName('not a url')), false);
  });
});

describe('assertTestDatabase', () => {
  it('refuses a real database from a test process', () => {
    withNodeEnv('test', () => {
      assert.throws(() => assertTestDatabase(APP_URL), /Refusing database access:.*vrt_cms/s);
      assert.throws(
        () => assertTestDatabase(APP_URL, { purpose: 'connecting the Postgres pool' }),
        /Refusing connecting the Postgres pool:/
      );
    });
  });

  it('allows a marked test database from a test process', () => {
    withNodeEnv('test', () => {
      assert.doesNotThrow(() => assertTestDatabase(TEST_URL));
    });
  });

  it('refuses an unset DATABASE_URL from a test process', () => {
    withNodeEnv('test', () => {
      assert.throws(() => assertTestDatabase(undefined), /Refusing/);
    });
  });

  it('is a no-op outside test mode so npm start / npm run seed still work', () => {
    withNodeEnv('development', () => {
      assert.doesNotThrow(() => assertTestDatabase(APP_URL));
    });
    withNodeEnv(undefined, () => {
      assert.doesNotThrow(() => assertTestDatabase(APP_URL));
    });
  });
});
