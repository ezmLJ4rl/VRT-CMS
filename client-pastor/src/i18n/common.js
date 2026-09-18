// Content that is identical regardless of the interface language: the church's
// legal name/address, currency defaults, and other locale-independent constants.
// Keep this file free of any user-facing sentence that needs translating:
// those belong in en.json / sw.json instead.
export const CHURCH_NAME = 'Victory Revival Temple';
export const CHURCH_ADDRESS = 'Mbezi Juu, Dar es Salaam, Tanzania';
export const CHURCH_LOCATION = 'Mbezi Juu, Dar es Salaam';
export const DEFAULT_CURRENCY = 'TZS';
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'sw', label: 'Kiswahili' },
];
export const OFFERING_TYPES = ['tithe', 'thanksgiving', 'service', 'special'];
export const OFFERING_REQUIRES_OFFERER = { tithe: true, thanksgiving: true, service: false, special: false };
