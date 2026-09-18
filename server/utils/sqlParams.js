// Converts a SQL string written with SQLite-style `?` placeholders into
// Postgres's positional `$1, $2, ...` style. Lets query-building code that
// assembles clauses dynamically (WHERE x = ? AND y = ?) stay unchanged in
// shape when converting from better-sqlite3 to pg.
function toParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

module.exports = { toParams };
