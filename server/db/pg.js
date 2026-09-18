const { Pool, types } = require('pg');
const { assertTestDatabase } = require('./testSafety');

// better-sqlite3 returned every numeric column, including COUNT(*) and SUM()
// as a JS number. node-postgres instead returns int8 (bigint) and numeric as
// *strings* to avoid precision loss. Those strings silently break the app:
// arithmetic like `0 + row.attendance` would concatenate ("03") and the clients
// render values with .toLocaleString()/comparisons that expect numbers. Nothing
// in this schema approaches 2^53 (ids, counts, and money aggregates), so parsing
// them back to numbers restores the exact response shapes the frontend depends on.
types.setTypeParser(20, (value) => (value === null ? null : parseInt(value, 10))); // int8 / bigint
types.setTypeParser(1700, (value) => (value === null ? null : parseFloat(value))); // numeric

// Last line of defence for the test suite: every data query in the app goes
// through this pool, so a test process (NODE_ENV=test) that has been handed the
// real DATABASE_URL dies here: before any seed/bootstrap query runs: instead
// of writing to a developer's database. See db/testSafety.js.
assertTestDatabase(process.env.DATABASE_URL, { purpose: 'connecting the Postgres pool' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = pool;