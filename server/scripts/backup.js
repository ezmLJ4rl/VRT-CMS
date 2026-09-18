'use strict';
/**
 * Safe backup for the live Postgres database.
 *
 * Uses pg_dump's custom format (-Fc): a consistent online snapshot taken while
 * the API keeps running, already compressed, and restorable with pg_restore.
 * Backups land in server/db/backups/ (gitignored) and rotate automatically.
 *
 * pg_dump must match or exceed the server version. If no pg_dump is installed
 * on the host (common on Windows dev machines) we fall back to running it
 * inside the Docker container that docker-compose.yml starts.
 *
 * A dump is only written out after pg_restore can actually read it back: a
 * truncated or mangled "successful" backup is worse than no backup at all.
 *
 * Usage:
 *   npm run backup                 # keeps the last 14 backups
 *   BACKUP_KEEP=30 npm run backup  # custom retention
 *   BACKUP_DIR=/var/backups npm run backup
 *   BACKUP_CONTAINER=vrt-cms-postgres npm run backup
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'db', 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
const CONTAINER = process.env.BACKUP_CONTAINER || 'vrt-cms-postgres';
const DATABASE_URL = process.env.DATABASE_URL;

// Dumps are binary; keep them as Buffers end to end. Room for a large archive.
const MAX_BUFFER = 1024 * 1024 * 1024;
const PGDMP_MAGIC = 'PGDMP';

function timestamp() {
  // Local-time stamp; backups are a server-side operational artifact.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseUrl() {
  try {
    const u = new URL(DATABASE_URL);
    return { user: decodeURIComponent(u.username), db: u.pathname.replace(/^\//, '') };
  } catch {
    return null;
  }
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0];
}

/**
 * Runs pg_dump, preferring a local binary and falling back to the container.
 * Returns { ok, error }, never throws, so the caller can report a clean message.
 */
function runPgDump(dest) {
  // Note: no `encoding`, the custom format is binary, and decoding it as UTF-8
  // silently corrupts the archive (pg_restore then segfaults instead of
  // listing it). Outside stdout is inherited, so it streams to the file.
  const local = spawnSync('pg_dump', [DATABASE_URL, '--format=custom', '--file', dest], {
    stdio: ['ignore', 'inherit', 'pipe'],
  });

  if (!local.error) {
    if (local.status === 0) return { ok: true };
    return { ok: false, error: `pg_dump failed: ${firstLine(local.stderr)}` };
  }

  if (local.error.code !== 'ENOENT') {
    return { ok: false, error: `pg_dump failed: ${local.error.message}` };
  }

  const target = parseUrl();
  if (!target) return { ok: false, error: 'DATABASE_URL is not a valid Postgres URL.' };

  console.log(`pg_dump not found on PATH: running it inside the "${CONTAINER}" container.`);
  const viaDocker = spawnSync(
    'docker',
    ['exec', CONTAINER, 'pg_dump', '-U', target.user, '-d', target.db, '--format=custom'],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER }
  );
  if (viaDocker.error) {
    return {
      ok: false,
      error:
        `could not run pg_dump (no local binary, docker fallback failed: ${viaDocker.error.message})\n` +
        `  start the database with: docker compose up -d\n` +
        `  or install the postgresql client tools and retry`,
    };
  }
  if (viaDocker.status !== 0) {
    return { ok: false, error: `pg_dump (in container) failed: ${firstLine(viaDocker.stderr)}` };
  }
  // stdout is a Buffer here: write it verbatim.
  fs.writeFileSync(dest, viaDocker.stdout);
  return { ok: true };
}

/**
 * Proves the archive is a readable pg_dump custom-format file, using pg_restore
 * locally or inside the container. Returns { ok, warning?, error? }.
 */
function validateArchive(dest) {
  const local = spawnSync('pg_restore', ['--list', dest], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
  if (!local.error) {
    if (local.status === 0) return { ok: true };
    return { ok: false, error: `pg_restore cannot read the dump back: ${firstLine(local.stderr) || `exit ${local.status}`}` };
  }
  if (local.error.code === 'ENOENT') {
    const viaDocker = spawnSync('docker', ['exec', '-i', CONTAINER, 'pg_restore', '--list'], {
      input: fs.readFileSync(dest),
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    });
    if (!viaDocker.error) {
      if (viaDocker.status === 0) return { ok: true };
      return {
        ok: false,
        error: `pg_restore cannot read the dump back: ${firstLine(viaDocker.stderr) || `exit ${viaDocker.status}`}`,
      };
    }
  }

  // Neither pg_restore nor Docker available: fall back to the format magic, but
  // say so rather than implying the archive was verified.
  const head = Buffer.alloc(PGDMP_MAGIC.length);
  const fd = fs.openSync(dest, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('utf8') !== PGDMP_MAGIC) return { ok: false, error: 'the dump is not a Postgres archive' };
  return { ok: true, warning: 'pg_restore was unavailable, verified the file header only' };
}

function main() {
  if (!DATABASE_URL) {
    console.error('backup failed: DATABASE_URL is not set (see server/.env.example).');
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dest = path.join(BACKUP_DIR, `vrt_cms-${timestamp()}.dump`);
  const dumped = runPgDump(dest);
  if (!dumped.ok) {
    fs.rmSync(dest, { force: true });
    console.error(`backup failed: ${dumped.error}`);
    process.exit(1);
  }

  const checked = validateArchive(dest);
  if (!checked.ok) {
    // Never leave an unreadable archive behind: it would rotate out a good one.
    fs.rmSync(dest, { force: true });
    console.error(`backup failed: ${checked.error}`);
    process.exit(1);
  }
  if (checked.warning) console.warn(`warning: ${checked.warning}`);

  const size = fs.statSync(dest).size;
  console.log(`backup written: ${dest} (${(size / 1024).toFixed(1)} KiB)`);

  // Rotate: keep the newest KEEP archives.
  const backups = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^vrt_cms-\d{4}-\d{2}-\d{2}_\d{6}\.dump$/.test(f))
    .sort();
  const stale = backups.slice(0, Math.max(0, backups.length - KEEP));
  for (const f of stale) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`rotated out: ${f}`);
  }
  console.log(`done: ${backups.length - stale.length} backup(s) retained in ${BACKUP_DIR}`);
  console.log('restore with: pg_restore --clean --if-exists -d "$DATABASE_URL" <file.dump>');
}

main();
