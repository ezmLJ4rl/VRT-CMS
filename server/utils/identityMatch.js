'use strict';
/**
 * "Is this the same person?": the church's answer, in one place.
 *
 * These four functions used to live inside routes/members.js, where they guard
 * the member form (a repeat phone is refused, a repeat name is a question). The
 * reconciliation workflow asks the very same question of a bank statement line:
 * is the payer the member whose number this is?, and it must get the SAME
 * answer. Two implementations would drift, and the drift would be invisible: a
 * payment the member form calls a duplicate the matcher would call a stranger.
 *
 * What is deliberately NOT here: fuzzy matching. sameName compares whole names
 * (order-insensitively), never substrings, so "Neema K" never swallows "Neema
 * Joseph"; and the matcher built on top of it refuses to auto-assign a member on
 * a name alone when the money is real (see utils/paymentIntake.js).
 */

/** Digits only, so '+255 712 345 678' and '0712-345-678' compare equal. */
function phoneDigits(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

/**
 * Two phone spellings of one number: full digits match, or the last 9 digits do
 * (Tanzania's local number length), which catches '+255712345678' vs
 * '0712345678': the same phone written the two ways people actually write it.
 */
function samePhone(a, b) {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  return da.length >= 9 && db.length >= 9 && da.slice(-9) === db.slice(-9);
}

/** Case-, spacing- and punctuation-insensitive name key ('Neema  K.' -> 'neema k'). */
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 'Neema K' and 'K Neema' are the same name written two ways, so the token set
 * is compared order-insensitively, but a name that merely shares a word with
 * another ('Neema K' vs 'Neema Joseph') is a different person, not a match.
 */
function sameName(a, b) {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const ta = ka.split(' ').sort().join(' ');
  const tb = kb.split(' ').sort().join(' ');
  return ta === tb;
}

/**
 * One member number put into its canonical form: 'vrt 42', 'VRT0042', 'VRT-42'
 * and 'VRT-0042' are all the same code, and this is the only spelling the system
 * compares or stores. Returns null for anything that is not a member number.
 *
 * It exists because the code is quoted by PEOPLE, on phone keypads and bank
 * forms, in whatever spacing and case they happen to use, and because a stored
 * row may predate the format being enforced (`vrt-9`). Comparing the canonical
 * forms of both sides is what makes 'quoted it the way I write it' still match.
 */
function canonicalMemberNo(value) {
  const match = String(value || '').trim().toUpperCase().match(/^VRT[\s\-/]*(\d{1,6})$/);
  if (!match) return null;
  return `VRT-${String(Number(match[1])).padStart(4, '0')}`;
}

/**
 * The church's member number (`VRT-0042`), as it appears inside a payment
 * reference or description.
 *
 * Members quote this in a mobile-money or bank reference field, which is the
 * strongest identity a payment can carry: it is unique, it is the church's own
 * identifier, and unlike a name it cannot be shared by two people. The code is
 * looked for anywhere in the text, so 'ZAKA/VRT-0009/2026-06' and 'DEP vrt 9'
 * both resolve, and a missed match here means money nobody can attribute.
 */
function findMemberNumber(text) {
  const match = String(text || '').toUpperCase().match(/\bVRT[\s\-/]*\d{1,6}\b/);
  return match ? canonicalMemberNo(match[0]) : null;
}

module.exports = { phoneDigits, samePhone, nameKey, sameName, canonicalMemberNo, findMemberNumber };
