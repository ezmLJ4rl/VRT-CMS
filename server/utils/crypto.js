const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

/**
 * Encrypts a plaintext string for storage.
 * Returns a single string: iv:authTag:ciphertext (all base64), so it fits in one TEXT column.
 */
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypts a string produced by encryptField. Returns null on empty input.
 */
function decryptField(stored) {
  if (!stored) return null;
  const key = getKey();
  const [ivB64, tagB64, dataB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encryptField, decryptField };
