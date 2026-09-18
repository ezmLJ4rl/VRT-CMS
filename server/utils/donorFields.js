const { decryptField } = require('./crypto');

/*
 * Reading donor fields (offerer name/phone) safely.
 *
 * The column holding the name is encrypted, so "no name" and "cannot read the
 * name" are different states and must never be collapsed into one:
 *
 *   • the column is NULL/empty  -> the gift really is anonymous
 *                                  { value: null, unreadable: false }
 *   • the column holds ciphertext that will not decrypt (rotated or edited
 *     FIELD_ENCRYPTION_KEY, hand-edited row, corrupted value) -> a fault to
 *     surface, because printing "Anonymous" over it would silently hide donor
 *     data loss                         { value: null, unreadable: true }
 *
 * A fault is logged on the server (so it is visible in logs and in tests) and
 * returned as `unreadable` so the API response, the UI and the receipt can say
 * "unavailable" instead of "anonymous".
 */

function where(context = {}) {
  const parts = [];
  if (context.table) parts.push(context.table);
  if (context.id !== undefined && context.id !== null) parts.push(`#${context.id}`);
  if (context.field) parts.push(context.field);
  return parts.length ? ` (${parts.join(' ')})` : '';
}

/** Decodes one stored donor field. Never throws. */
function readDonorField(stored, context = {}) {
  if (stored === null || stored === undefined || stored === '') {
    return { value: null, unreadable: false };
  }
  try {
    const value = decryptField(stored);
    if (value === null || value === '') {
      console.error(`[donor-fields] ciphertext present but decoded empty${where(context)}`);
      return { value: null, unreadable: true };
    }
    return { value, unreadable: false };
  } catch (err) {
    console.error(
      `[donor-fields] decryption failed${where(context)}: ${err.message}. ` +
        'The stored value exists, so this is not an anonymous gift: check FIELD_ENCRYPTION_KEY.'
    );
    return { value: null, unreadable: true };
  }
}

/**
 * Who may see a donor's name/phone at all.
 *
 * admin/pastor/superadmin: the full ledger, as before. A receptionist typed the
 * name in themselves and needs it back for the receipt and their entries list,
 * but only for records they wrote: the same rule the queries already enforce
 * (own entries, today only), so `row` must be passed for them.
 */
function canViewDonorData(user, row) {
  if (!user) return false;
  if (['admin', 'pastor', 'superadmin'].includes(user.role)) return true;
  if (user.role !== 'receptionist') return false;
  return !!row && row.recorded_by === user.id;
}

module.exports = { readDonorField, canViewDonorData };
