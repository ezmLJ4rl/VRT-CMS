'use strict';
/**
 * Character encoding (the bug where "·" showed as "Â·" and "—" as "â€”").
 *
 * The root cause was not the database, the connection, or the response headers:
 * it was the source files. A handful of JSX literals had been through a cp1252
 * round trip, so the *bytes in the file* were the mojibake ("Â·" is C3 82 C2 B7:
 * UTF-8 for the two characters "Â" and "·"), and the browser faithfully rendered
 * exactly what was written. Postgres was UTF8 throughout and the API always
 * declared charset=utf-8, which is why nothing else looked wrong.
 *
 * Two guards keep that from happening again:
 *   1. a sweep of every text file in the repo: no BOM, no invalid UTF-8, no
 *      mojibake sequence (this fails the moment an editor saves a file wrong);
 *   2. a real round trip through the pipeline: a digest is written with "·",
 *      "•", "’" and an em dash in a free-text note, and read back out of the
 *      API byte-for-byte intact, which is the end-to-end proof the reported
 *      symptom is gone.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'encoding', port: 4609 });

const REPO_ROOT = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dev-dist', '.git', '.freebuff', 'coverage']);
// This file has to spell out the very sequences it hunts for, so it would always
// match itself. It is the one documented hole in the sweep: nothing else in the
// repo is exempt, and the end-to-end round trip below covers this file's area.
const SELF = 'encoding.test.js';
const TEXT_EXTENSIONS = new Set(['.js', '.jsx', '.cjs', '.mjs', '.json', '.css', '.md', '.html', '.yml', '.yaml', '.sql']);

// The characters a cp1252 round trip leaves behind. Each is a *sequence* that
// only appears when correctly-encoded text has been decoded as cp1252 and then
// re-encoded: "Â" / "â€" / "âœ" / "Ã" always start one.
const MOJIBAKE = /Â|â€|âœ|Ã[\u0080-\u00ff]|\ufffd/;

const MIDDLE_DOT = '\u00b7'; // ·
const EM_DASH = '\u2014'; // the character itself
const BULLET = '\u2022'; // •
const APOSTROPHE = '\u2019'; // ’

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const PASTOR = { email: 'pastor@victoryrevival.church', password: 'TestPass_123!' };

function textFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) textFiles(path.join(dir, entry.name), found);
      continue;
    }
    if (entry.name === SELF) continue;
    if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(path.join(dir, entry.name));
  }
  return found;
}

describe('encoding: every text file in the repo is clean UTF-8', () => {
  const files = textFiles(REPO_ROOT);

  it('finds the source tree (a sweep over nothing would pass silently)', () => {
    assert.ok(files.length > 50, `expected to sweep the repo, found only ${files.length} files`);
    assert.ok(files.some((f) => f.endsWith(path.join('client-pastor', 'src', 'pages', 'Messages.jsx'))));
  });

  it('saves every file without a byte-order mark', () => {
    const bom = files.filter((f) => {
      const buf = fs.readFileSync(f);
      return buf.length > 2 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    });
    assert.deepEqual(bom.map((f) => path.relative(REPO_ROOT, f)), [], 'a BOM is the signature of a bad save');
  });

  it('contains only valid UTF-8 bytes', () => {
    const invalid = files.filter((f) => {
      const buf = fs.readFileSync(f);
      return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) !== 0;
    });
    assert.deepEqual(invalid.map((f) => path.relative(REPO_ROOT, f)), []);
  });

  it('shows no mojibake anywhere, in any language catalog or component', () => {
    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (MOJIBAKE.test(line)) offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(offenders, [], 'text that was decoded as cp1252 and written back leaves these behind');
  });
});

describe('encoding: the API delivers them intact', () => {
  let adminToken;
  let receptionistToken;
  let pastorToken;
  let past;

  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, ADMIN);
    assert.equal(admin.status, 200, admin.text);
    adminToken = admin.json.token;
  });

  after(() => suite.stop());

  it('declares utf-8 on JSON responses', async () => {
    const health = await suite.api('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-type'), /application\/json;\s*charset=utf-8/i);
  });

  it('stores in a UTF-8 database', async () => {
    const { rows } = await suite.query('SHOW server_encoding');
    assert.equal(rows[0].server_encoding, 'UTF8');
  });

  it('round-trips ·: • ’ from the database, through the API, to the pastor', async () => {
    // A receptionist records a sub-session and a tithe (which issues a receipt),
    // then sends the batched summary: the exact path the daily summary travels.
    const created = await suite.api('POST', '/api/users', adminToken, {
      name: 'Encoding Desk', email: 'encoding.desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    assert.equal(created.status, 201, created.text);

    const login = await suite.api('POST', '/api/auth/login', null, { email: 'encoding.desk@test.local', password: 'DeskPass_123!' });
    assert.equal(login.status, 200, login.text);
    receptionistToken = login.json.token;

    const { json: types } = await suite.api('GET', '/api/service-types', receptionistToken);
    const sunday = types.serviceTypes.find((s) => s.key === 'sunday_1');
    const subSession = sunday.subSessions.find((s) => s.name === 'Sunday School');

    const { json: time } = await suite.api('GET', '/api/time', receptionistToken);
    const today = time.date;

    const attendance = await suite.api('POST', '/api/attendance', receptionistToken, {
      serviceTypeId: sunday.id, date: today, subSessionId: subSession.id, count: 12,
    });
    assert.equal(attendance.status, 201, attendance.text);

    // 'zaka' requires an offerer and issues a receipt, so the digest carries the
    // "receipt N" clause and a free-text reason. The reason is the em dash's
    // carrier: no product copy uses one any more, but a character somebody typed
    // into a note has to survive the same pipeline.
    const reasonWithDash = `brought by her brother ${EM_DASH} she was travelling`;
    const offering = await suite.api('POST', '/api/offerings', receptionistToken, {
      serviceTypeId: sunday.id, date: today, category: 'zaka', amount: 20000, currency: 'TZS', offererName: 'Neema Joseph', reason: reasonWithDash,
    });
    assert.equal(offering.status, 201, offering.text);
    assert.ok(offering.json.receiptNumber, 'a tithe must issue a receipt number');

    const summary = await suite.api('POST', '/api/notifications/send-summary', receptionistToken);
    assert.equal(summary.status, 200, summary.text);
    assert.equal(summary.json.sent, true, summary.text);

    const pastorLogin = await suite.api('POST', '/api/auth/login', null, PASTOR);
    assert.equal(pastorLogin.status, 200, pastorLogin.text);
    pastorToken = pastorLogin.json.token;

    const { status, json } = await suite.api('GET', '/api/messages', pastorToken);
    assert.equal(status, 200, json && json.error);
    const digest = json.conversations.broadcasts[0];
    assert.ok(digest, 'the pastor must receive the summary as a message');

    // The label is built as `${type} · ${subSession}` in two places (the digest
    // and the client's empty-state copy). It must arrive as two code points, not four.
    const session = digest.payload.attendance.find((a) => a.subSession === 'Sunday School');
    assert.ok(session, 'the recorded sub-session must be in the payload');
    assert.equal(session.label, `1st Sunday Service ${MIDDLE_DOT} Sunday School`);
    assert.equal([...session.label].filter((c) => c === MIDDLE_DOT).length, 1, 'exactly one middle dot, not a mojibake pair');

    const gift = digest.payload.offerings[0];
    assert.equal(gift.category, 'Zaka (Tithe)');
    assert.equal(gift.giver, 'Neema Joseph');

    // The human-readable body carries three of them: the apostrophe in
    // "Today’s", the bullet before each line and the middle dot in the labels.
    assert.ok(digest.body.includes(`Today${APOSTROPHE}s parish report`), digest.body.slice(0, 80));
    assert.ok(digest.body.includes(`${BULLET} 1st Sunday Service ${MIDDLE_DOT} Sunday School: 12`), digest.body);
    assert.ok(digest.body.includes(`, receipt ${offering.json.receiptNumber}`), digest.body);

    // And the fourth, the em dash a person typed, rides the payload untouched.
    assert.equal(digest.payload.offerings[0].reason, reasonWithDash);

    // And nothing anywhere in the payload is a mojibake sequence.
    const serialized = JSON.stringify(digest);
    assert.ok(!/Â|â€|âœ|\ufffd/.test(serialized), 'the digest must survive the round trip free of mojibake');
  });

  it('serves the receipt document with the same characters intact', async () => {
    // The receipt is generated as HTML/text rather than JSON, so it travels a
    // different content-type: the other place the reported symptom could live.
    const { json: offerings } = await suite.api('GET', '/api/offerings', receptionistToken);
    const tithe = offerings.offerings.find((o) => o.receipt_number);
    assert.ok(tithe, 'the tithe recorded above must be listed');

    const res = await suite.api('GET', `/api/offerings/${tithe.id}/receipt`, receptionistToken);
    assert.equal(res.status, 200, res.text);
    assert.ok(!/Â|â€|âœ|\ufffd/.test(res.text), 'the receipt must not contain mojibake');
  });
});
