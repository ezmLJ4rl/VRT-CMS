'use strict';
/**
 * The church's own name and address: the parts of a document, an SMS or a push
 * notification that are IDENTIFIERS, not prose. They read the same in every
 * language, so they are deliberately not catalog keys: translating a proper noun
 * would make a receipt unrecognizable to the person holding it.
 *
 * They live here, once, because they appear in three separately-generated places
 * (a receipt, an event sheet, a notification title) and a divergence between them
 * is how a document ends up disagreeing with the app it came from.
 *
 * The two clients keep their own copy in `src/i18n/common.js`: they are ES
 * modules and the server is CommonJS, so this cannot be a shared import. What
 * CAN be shared is the guarantee: the address below is the one the apps display
 * (Settings, and the admin header), and a test compares all three copies so a
 * receipt cannot quietly print a different place from the screen that issued it.
 */
const CHURCH_NAME = 'Victory Revival Temple';
const CHURCH_ADDRESS = 'Mbezi Juu, Dar es Salaam, Tanzania';

module.exports = { CHURCH_NAME, CHURCH_ADDRESS };
