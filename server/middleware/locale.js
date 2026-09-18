'use strict';
/**
 * Resolves the request's language and translates outgoing JSON error/message
 * keys through it (see i18n/index.js).
 *
 * This runs before every route, and wraps `res.json` rather than asking each
 * handler to translate, so localization lives in exactly one place: handlers keep
 * returning keys and never need to know who is reading the response.
 */
const { localizePayload, resolveLocale } = require('../i18n');

module.exports = function locale(req, res, next) {
  req.locale = resolveLocale(req);

  const json = res.json.bind(res);
  res.json = (payload) => json(localizePayload(payload, req.locale));

  next();
};
