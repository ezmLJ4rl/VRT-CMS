'use strict';
/**
 * Sample months for the center-trends charts (QA tooling, not app data).
 *
 * "By revival center" draws each center's last six COMPLETE months, and a
 * development database typically has nothing before the month in progress, so
 * every center correctly reads "no activity" and the charts cannot be seen doing
 * their job. This writes a few months of plausible attendance and giving so the
 * growth, fade and steady states are all visible, and removes them again.
 *
 * HOW IT IS IDENTIFIED, SO THE PURGE IS EXACT
 * ------------------------------------------
 * The sample rows carry a structural marker rather than a time window: every
 * sample service belongs to one SERVICE TYPE of its own (`qa_sample_trends`,
 * created inactive so the front desk's dropdown never offers it). That makes
 * "everything this script wrote" a question the database can answer exactly:
 * the attendance and offerings hanging off those services, plus any member it
 * had to create for a center with nobody to attribute giving to. No timestamps,
 * no guessing, and nothing real is ever a candidate for deletion.
 *
 * The counts of the affected tables are recorded before seeding and compared
 * after purging, so "the database is as it was" is checked, not assumed.
 *
 * USAGE
 *   node scripts/sample-trends.js seed
 *   node scripts/sample-trends.js purge            # dry run: what would go
 *   node scripts/sample-trends.js purge --apply
 *
 * Pairing: `seed` writes the baseline manifest, `purge --apply` verifies against
 * it and removes both the sample rows and the manifest.
 */
require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('../db/pg');

const MODE = process.argv[2];
const APPLY = process.argv.includes('--apply');

const SAMPLE_TYPE_KEY = 'qa_sample_trends';
const SAMPLE_TYPE_NAME = 'QA Sample Service';
const SAMPLE_MEMBER_PREFIX = 'QA Trend Sample';
const BASELINE_FILE = path.join(os.tmpdir(), 'vrt-sample-trends-baseline.json');

// How many complete months to fill, and how many centers to give a story to.
const MONTHS = 6;
const CENTERS = 3;

/**
 * Shared by the services of one month, split across four Sundays. Uneven on
 * purpose: identical weeks would draw a ruler-straight line and hide whether the
 * chart is doing anything.
 */
const ATTENDANCE_SPLIT = [0.27, 0.26, 0.24, 0.23];
const GIVING_SPLIT = [0.31, 0.27, 0.22, 0.2];

/**
 * The three shapes the charts claim to tell apart, one per center: a center that
 * is growing, one that is fading, and one that is holding steady (steady within
 * the ±3% the client's trend rule calls noise).
 */
const STORIES = [
  {
    attendance: [60, 68, 76, 84, 96, 108],
    giving: [1120000, 1360000, 1600000, 1920000, 2240000, 2560000],
  },
  {
    attendance: [88, 80, 72, 60, 48, 40],
    giving: [1680000, 1520000, 1320000, 1120000, 880000, 640000],
  },
  {
    attendance: [70, 71, 70, 70, 71, 70],
    giving: [1000000, 1010000, 995000, 1005000, 1000000, 1005000],
  },
];

/** The same six complete months the endpoint uses (see reports.js completeMonths). */
function completeMonths(count, today = new Date()) {
  const keys = [];
  for (let back = 1; back <= count; back += 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys.reverse();
}

const target = () => {
  const url = new URL(process.env.DATABASE_URL);
  return `${url.hostname}:${url.port || 5432}${url.pathname}`;
};

/** Everything this script has ever written, found structurally. */
async function sampleFootprint(runner) {
  const type = await runner.query('SELECT id FROM service_types WHERE key = $1', [SAMPLE_TYPE_KEY]);
  const typeId = type.rows[0] ? type.rows[0].id : null;
  const services = typeId
    ? (await runner.query('SELECT id FROM services WHERE service_type_id = $1', [typeId])).rows.map((r) => r.id)
    : [];
  const attendance = services.length
    ? (await runner.query('SELECT id FROM attendance WHERE service_id = ANY($1::int[])', [services])).rows.map((r) => r.id)
    : [];
  const offerings = services.length
    ? (await runner.query('SELECT id FROM offerings WHERE service_id = ANY($1::int[])', [services])).rows.map((r) => r.id)
    : [];
  const members = (await runner.query('SELECT id FROM members WHERE name LIKE $1', [`${SAMPLE_MEMBER_PREFIX}%`])).rows.map((r) => r.id);
  return { typeId, services, attendance, offerings, members };
}

async function counts(runner) {
  const { rows } = await runner.query(
    `SELECT
       (SELECT count(*)::int FROM services) AS services,
       (SELECT count(*)::int FROM attendance) AS attendance,
       (SELECT count(*)::int FROM offerings) AS offerings,
       (SELECT count(*)::int FROM attendance_attendees) AS attendees,
       (SELECT count(*)::int FROM members) AS members,
       (SELECT count(*)::int FROM service_types) AS service_types`
  );
  return rows[0];
}

function printCounts(label, c) {
  console.log(`  ${label.padEnd(16)} services ${c.services} · attendance ${c.attendance} · offerings ${c.offerings} · attendees ${c.attendees} · members ${c.members} · types ${c.service_types}`);
}

async function seed() {
  const existing = await sampleFootprint(pool);
  if (existing.typeId) {
    throw new Error('sample data is already present: run `purge --apply` first, then seed again');
  }

  const baseline = await counts(pool);
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ baseline, seededAt: new Date().toISOString() }, null, 2)}\n`);

  const centers = (await pool.query('SELECT id, name FROM revival_centers ORDER BY sort_order, id LIMIT $1', [CENTERS])).rows;
  if (centers.length < CENTERS) throw new Error(`expected ${CENTERS} centers to describe, found ${centers.length}`);

  const recorder = (await pool.query(
    "SELECT id, name FROM users WHERE is_active = 1 AND role IN ('receptionist','admin','superadmin') ORDER BY CASE role WHEN 'receptionist' THEN 0 ELSE 1 END, id LIMIT 1"
  )).rows[0];
  if (!recorder) throw new Error('no active user to attribute the sample records to');

  const general = (await pool.query("SELECT id FROM offering_categories WHERE key = 'general'")).rows[0];
  const months = completeMonths(MONTHS);

  const written = { services: 0, attendance: 0, offerings: 0, members: 0 };
  const monthly = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const type = (await client.query(
      `INSERT INTO service_types (name, key, kind, attendance_mode, sort_order, is_active)
       VALUES ($1, $2, 'service', 'headcount', 999, 0) RETURNING id`,
      [SAMPLE_TYPE_NAME, SAMPLE_TYPE_KEY]
    )).rows[0].id;

    for (const [index, center] of centers.entries()) {
      const story = STORIES[index % STORIES.length];

      // Giving is attributed to a center through the member who gave it (see
      // routes/reports.js), so a center needs a member before it can have money.
      const member = (await client.query(
        'SELECT id, name FROM members WHERE revival_center_id = $1 ORDER BY is_active DESC, id LIMIT 1',
        [center.id]
      )).rows[0];
      let memberId;
      if (member) {
        memberId = member.id;
      } else {
        const created = await client.query(
          'INSERT INTO members (name, revival_center_id, notes) VALUES ($1, $2, $3) RETURNING id',
          [`${SAMPLE_MEMBER_PREFIX}: ${center.name}`, center.id, 'Written by scripts/sample-trends.js for chart verification.']
        );
        memberId = created.rows[0].id;
        written.members += 1;
      }

      for (const [m, month] of months.entries()) {
        let attendanceTotal = 0;
        let givingTotal = 0;
        // One service per Sunday, so each month has real dated sessions behind it
        // (the Reports page lists them, and its session count stays believable).
        for (const [w, day] of ['07', '14', '21', '28'].entries()) {
          const date = `${month}-${day}`;
          const service = (await client.query(
            'INSERT INTO services (name, date, service_type_id, is_temporary) VALUES ($1, $2, $3, 0) RETURNING id',
            [`Sample Sunday: ${center.name}`, date, type]
          )).rows[0].id;
          written.services += 1;

          const attendance = Math.round(story.attendance[m] * ATTENDANCE_SPLIT[w]);
          await client.query(
            `INSERT INTO attendance (service_id, count, mode, recorded_by, revival_center_id, timestamp)
             VALUES ($1, $2, 'headcount', $3, $4, $5)`,
            [service, attendance, recorder.id, center.id, `${date} 10:30:00`]
          );
          written.attendance += 1;
          attendanceTotal += attendance;

          const giving = Math.round((story.giving[m] * GIVING_SPLIT[w]) / 1000) * 1000;
          await client.query(
            `INSERT INTO offerings (service_id, category_id, type, amount, currency, member_id, revival_center_id, recorded_by, timestamp)
             VALUES ($1, $2, 'general', $3, 'TZS', $4, $5, $6, $7)`,
            [service, general ? general.id : null, giving, memberId, center.id, recorder.id, `${date} 11:15:00`]
          );
          written.offerings += 1;
          givingTotal += giving;
        }
        monthly.push({ center: center.name, month, attendance: attendanceTotal, giving: givingTotal });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`\nTarget      : ${target()}`);
  console.log(`Months      : ${months[0]} .. ${months[months.length - 1]} (complete months only)`);
  console.log(`Recorded by : ${recorder.name} (id ${recorder.id})`);
  console.log(`Written     : ${written.services} services, ${written.attendance} attendance, ${written.offerings} offerings, ${written.members} sample member(s)\n`);
  for (const row of monthly) {
    console.log(`  ${row.center.padEnd(18)} ${row.month}  attendance ${String(row.attendance).padStart(4)}   giving ${row.giving.toLocaleString('en-GB').padStart(11)} TZS`);
  }
  console.log('\nOpen the Centers page ("By revival center") to see the curves.');
  console.log(`Remove with: npm run purge:samples -- --apply   (baseline saved in ${BASELINE_FILE})\n`);
}

async function purge() {
  const footprint = await sampleFootprint(pool);
  const total = footprint.services.length + footprint.attendance.length + footprint.offerings.length + footprint.members.length + (footprint.typeId ? 1 : 0);

  console.log(`\nTarget : ${target()}`);
  if (!total) {
    console.log('Nothing to purge: no sample rows found.\n');
    return;
  }

  console.log('Would remove:');
  console.log(`  ${'service_types'.padEnd(12)} 1  (${SAMPLE_TYPE_NAME})`);
  console.log(`  ${'services'.padEnd(12)} ${footprint.services.length}`);
  console.log(`  ${'attendance'.padEnd(12)} ${footprint.attendance.length}`);
  console.log(`  ${'offerings'.padEnd(12)} ${footprint.offerings.length}`);
  console.log(`  ${'members'.padEnd(12)} ${footprint.members.length}\n`);

  if (!APPLY) {
    console.log('DRY RUN: nothing changed. Re-run with `--apply` to remove it.\n');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Children before parents: an offering or an attendance row references its
    // service, and the services reference the sample type.
    await client.query('DELETE FROM offerings WHERE id = ANY($1::int[])', [footprint.offerings]);
    await client.query('DELETE FROM attendance WHERE id = ANY($1::int[])', [footprint.attendance]);
    await client.query('DELETE FROM services WHERE id = ANY($1::int[])', [footprint.services]);
    await client.query('DELETE FROM members WHERE id = ANY($1::int[])', [footprint.members]);
    if (footprint.typeId) await client.query('DELETE FROM service_types WHERE id = $1', [footprint.typeId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Proof rather than confidence: nothing structural is left, and every table is
  // back to the count recorded before the seed.
  const left = await sampleFootprint(pool);
  const remaining = left.services.length + left.attendance.length + left.offerings.length + left.members.length + (left.typeId ? 1 : 0);
  const after = await counts(pool);

  let baseline = null;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).baseline;
  } catch {
    console.log(`(no baseline file at ${BASELINE_FILE}: comparing to the counts above only)`);
  }

  console.log('Removed.');
  printCounts('now', after);
  if (baseline) {
    printCounts('before seed', baseline);
    const same = Object.keys(baseline).every((key) => baseline[key] === after[key]);
    console.log(same
      ? 'Baseline match: every affected table is back to the count it had before the seed.\n'
      : 'MISMATCH, a table does not match its pre-seed count; look before trusting this database.\n');
    if (same) fs.unlinkSync(BASELINE_FILE);
  }
  if (remaining) console.log(`WARNING: ${remaining} sample row(s) still match the marker.\n`);
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to run: NODE_ENV=production');
  if (MODE === 'seed') return seed();
  if (MODE === 'purge') return purge();
  console.log('Usage: node scripts/sample-trends.js seed | purge [--apply]');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Failed:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
