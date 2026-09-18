'use strict';
/**
 * Keeps `offerings.type` in step with `offering_categories` (the single source
 * of truth for an offering's category).
 *
 * Historically the type TEXT column carried free-form values, including the
 * pre-categorization keys 'tithe'/'service'. Reporting groups by type, so any
 * spelling drift split totals and made the LEFT JOIN to offering_categories
 * miss rows. Two passes fix that:
 *
 *   1. rows with a category_id adopt that category's key;
 *   2. rows still without one are folded from the legacy key to its canonical
 *      replacement (tithe -> zaka, service -> general).
 *
 * Ported from the pre-Postgres SQLite schema, which ran this on every boot. index.js still calls it at startup as a cheap self-repair, and
 * db/seed.pg.js calls it so seeded/imported data lands canonical.
 */
const pool = require('./pg');

// Legacy free-form type -> canonical offering_categories.key
const LEGACY_TYPE_MAP = { tithe: 'zaka', service: 'general' };

async function canonicalizeOfferingTypes() {
  // Pass 1: category_id wins whenever it is present.
  const synced = await pool.query(
    `UPDATE offerings
        SET type = oc.key
       FROM offering_categories oc
      WHERE offerings.category_id = oc.id
        AND offerings.type <> oc.key`
  );

  // Pass 2: rows with no category_id follow the legacy key mapping.
  let folded = 0;
  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_TYPE_MAP)) {
    const result = await pool.query('UPDATE offerings SET type = $1 WHERE type = $2 AND category_id IS NULL', [
      canonicalKey,
      legacyKey,
    ]);
    folded += result.rowCount;
  }

  return { synced: synced.rowCount, folded };
}

module.exports = { canonicalizeOfferingTypes, LEGACY_TYPE_MAP };
