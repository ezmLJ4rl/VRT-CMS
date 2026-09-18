'use strict';
/**
 * The church's member number: `VRT-0042`.
 *
 * WHY THIS IS ITS OWN MODULE: the number is not decoration. It is the code a
 * member quotes when they pay by bank or mobile money, and `utils/paymentIntake.js`
 * matches an incoming payment on it (a reference reading `ZAKA VRT-0042` is the
 * one identity a payer cannot share with anybody else). Three places therefore
 * have to agree on exactly how one is minted: the member form
 * (routes/members.js), the boot migration that fills in any member who predates
 * the number (db/migrate.js) and, by way of matching, the reconciliation screen.
 * Two implementations would drift, and the drift would be silent: the form would
 * hand out a number the matcher could not recognise.
 *
 * THE FORMAT IS 'VRT-' + FOUR DIGITS, zero-padded, allocated as MAX+1 over the
 * rows that actually parse as numbers. A malformed `member_no` on an old row
 * therefore cannot break the allocation (hence the regex filter rather than a
 * bare CAST, which Postgres would raise on).
 */

/**
 * The next free member number. Takes an optional transaction client, so a caller
 * allocating inside a transaction reads on the connection it will insert on.
 */
async function nextMemberNo(client = null) {
  const runner = client || require('../db/pg');
  const { rows } = await runner.query(
    "SELECT MAX(CAST(substr(member_no, 5) AS INTEGER)) AS max_no FROM members WHERE member_no ~ '^VRT-[0-9]+$'"
  );
  return `VRT-${String((rows[0].max_no || 0) + 1).padStart(4, '0')}`;
}

module.exports = { nextMemberNo };
