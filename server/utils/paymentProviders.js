'use strict';
/**
 * How money actually gets from a church's bank or mobile-money account into this
 * system, and what is deliberately NOT here.
 *
 * THERE IS NO FAKE BANK CONNECTION. Nothing in this module pretends to hold a
 * bank login, a mobile-money PIN, or a live socket into a provider that has not
 * been integrated. Credentials that move money are never requested and never
 * stored (see the commentary on payment_accounts in db/schema.sql). What exists
 * is the two integration shapes a church can genuinely run today against the
 * providers it already has:
 *
 *   statement_import  the church downloads the statement export its bank or
 *                     provider portal already offers (CSV/TSV) and the app reads
 *                     it. Real method, real data, no credentials to leak.
 *   webhook           the provider POSTs its transaction notifications to a URL
 *                     this system exposes, signed with a per-account secret. This
 *                     is how aggregators and payment gateways deliver events, and
 *                     it needs only a secret that can be rotated.
 *
 * A provider with a documented API (a bank's open-banking endpoints, a specific
 * gateway SDK) is added by writing ONE adapter with the same three parts:
 * `capabilities`, `credentialFields`, and a `normalize*` function returning the
 * canonical transaction shape below, and registering it in PROVIDERS. Accounts,
 * deduplication, matching, confirmation, receipts, reports and the admin screen
 * all speak only the canonical shape, so none of them change when a real
 * provider is plugged in. That is the whole point of this registry.
 *
 * THE CANONICAL TRANSACTION (what every provider must produce):
 *   { provider_transaction_id?, provider_reference?, amount, currency?,
 *     occurred_at, payer_name?, payer_phone?, payer_account_ref?,
 *     description?, status? }
 * Optional fields may be absent; `amount` and a parsable `occurred_at` may not,
 * and a row that cannot produce them is reported back to the admin with a reason
 * instead of being silently dropped.
 */

const { readStatement, headerIndex } = require('./statementCsv');

/** Statuses a provider may report. Anything else is treated as unrecognised. */
const TRANSACTION_STATUSES = ['pending', 'successful', 'reversed', 'failed'];

/**
 * Why a statement row could not become a transaction. Catalog keys, because an
 * admin has to read these in their own language (i18n/en.json, i18n/sw.json),
 * and they share the `payment.` namespace with the method labels the receipt
 * already prints, rather than a near-identical second one.
 */
const REJECT = {
  noDate: 'payment.reject_noDate',
  noAmount: 'payment.reject_noAmount',
  notCredit: 'payment.reject_notCredit',
  noAccount: 'payment.reject_noAccount',
  disabledAccount: 'payment.reject_disabledAccount',
  noColumns: 'payment.reject_noColumns',
};

/**
 * Column aliases. Every bank orders and names its columns differently, and one
 * bank renames them between exports; matching by alias (never by position) is
 * what keeps next month's download from shifting every amount one column left.
 * Keys are already normalized (lowercase, alphanumerics only), so 'Txn Date',
 * 'txn_date' and 'TransactionDate' all land on the same entry: see
 * statementCsv.headerIndex.
 */
const COLUMN_ALIASES = {
  date: ['transactiondate', 'txndate', 'valuedate', 'date', 'tarehe', 'posteddate', 'bookingdate', 'datum'],
  time: ['transactiontime', 'txntime', 'time', 'saa'],
  amount: ['amount', 'credit', 'creditamount', 'amountcredited', 'deposit', 'moneyin', 'paidin', 'kiasi', 'creditin'],
  debit: ['debit', 'debitamount', 'withdrawal', 'moneyout', 'paidout', 'debitout'],
  reference: [
    'reference', 'ref', 'referenceno', 'transactionreference', 'transactionid', 'txnid', 'transactioncode',
    'receiptno', 'receiptnumber', 'mpesacode', 'code', 'kumbukumbu',
    // The reference the PAYER wrote is the one that carries a giving code, so it
    // is worth naming explicitly when an export distinguishes it from the bank's
    // own reference.
    'payerreference', 'payerref', 'customerreference',
  ],
  payer: ['payername', 'payer', 'sendername', 'sender', 'depositor', 'remitter', 'customername', 'name', 'jina', 'mwanachama'],
  phone: ['payerphone', 'phone', 'phonenumber', 'mobileno', 'mobilenumber', 'msisdn', 'simu', 'mobile'],
  payerAccount: ['payeraccount', 'fromaccount', 'senderaccount', 'accountnumber', 'sourceaccount', 'account'],
  description: ['description', 'narrative', 'details', 'particulars', 'narrative1', 'maelezo', 'purpose'],
  status: ['status', 'transactionstatus', 'state', 'hali'],
  currency: ['currency', 'ccy', 'sarafu'],
  providerId: ['providerid', 'providerreference', 'providerref', 'externalid', 'bankreference', 'unicodetransactionid'],
};

/** Resolves the alias map against an export's actual header row. */
function columnMap(cells) {
  const index = headerIndex(cells);
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      if (index.has(alias)) {
        map[field] = index.get(alias);
        break;
      }
    }
  }
  return map;
}

/**
 * A statement amount as a number, or null when it is not one.
 *
 * Handles what real exports contain: thousands separators, a currency prefix or
 * suffix ('TZS 50,000', '50,000/=', 'TZS 50,000.00'), trailing CR, and the two
 * ways money OUT is written: a leading minus, or parentheses, which is
 * reported by the caller as a debit rather than quietly becoming a gift.
 */
function parseAmount(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text.replace(/[^\d.,\-]/g, '').trim();
  if (!text || text === '-' || text === '.') return null;
  if (text.startsWith('-')) { negative = true; text = text.slice(1); }
  // '1,234,567.89' (comma thousands) or '1.234.567,89' (comma decimal): whichever
  // separator comes last is the decimal one, and the other is grouping.
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (lastComma > -1) {
    // '50,000' is grouping; '50,00' cannot be and is read as a decimal.
    const decimals = text.length - lastComma - 1;
    text = decimals === 3 ? text.replace(/,/g, '') : text.replace(',', '.');
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * A statement date as 'YYYY-MM-DD HH:MM:SS', or null.
 *
 * Day-first is the rule (dd/mm/yyyy), because that is how dates are written in
 * Tanzania: the church's own locale, and a month-first guess would turn 3 April
 * into 4 March in a report nobody would question. ISO dates are accepted as they
 * are, a time is read when the column has one, and a provider's own compact
 * stamp ('20260816093015', which is how mobile-money gateways send a timestamp)
 * is read as the date and time it obviously is.
 */
function parseStatementDate(dateRaw, timeRaw) {
  const raw = String(dateRaw ?? '').trim();
  if (!raw) return null;
  const time = String(timeRaw ?? '').trim();
  const clock = (() => {
    const m = time.match(/^(\d{1,2})[:.](\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
  })();

  let y; let mo; let d; let embedded = null;
  // YYYYMMDDHHMMSS, or YYYYMMDD with the time in its own field.
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/);
  if (compact) {
    const [, cy, cmo, cd, ch, cmi, cs] = compact;
    if (Number(cmo) >= 1 && Number(cmo) <= 12 && Number(cd) >= 1 && Number(cd) <= 31) {
      const embeddedClock = ch ? `${ch}:${cmi || '00'}:${cs || '00'}` : clock;
      return `${cy}-${cmo}-${cd} ${embeddedClock || '00:00:00'}`;
    }
  }
  let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?/);
  if (m) {
    [, y, mo, d] = m;
    embedded = m[4] || null;
  } else {
    m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?/);
    if (!m) return null;
    d = m[1];
    mo = m[2];
    y = m[3];
    embedded = m[4] || null;
    if (Number(y) < 100) y = String(2000 + Number(y));
  }
  const month = Number(mo);
  const day = Number(d);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const chosen = clock || (embedded ? (embedded.length === 5 ? `${embedded}:00` : embedded) : '00:00:00');
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${chosen}`;
}

/** A provider status as one of TRANSACTION_STATUSES. Unknown -> 'successful' is
 *  WRONG (it would make a failed payment confirmable), so unknown -> 'pending',
 *  which the admin screen shows as needing attention. */
function parseStatus(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return 'successful';
  if (TRANSACTION_STATUSES.includes(key)) return key;
  if (/(revers|refund|chargeback|return)/.test(key)) return 'reversed';
  // 'insufficient funds' and 'expired' are a provider saying the money did not
  // arrive, which must never be recorded as giving.
  if (/(fail|declin|error|reject|cancel|insufficient|no\s?funds|expired|unpaid)/.test(key)) return 'failed';
  if (/(pend|process|await|hold)/.test(key)) return 'pending';
  if (/(success|complete|paid|posted|cleared|ok)/.test(key)) return 'successful';
  return 'pending';
}

/** The webhook signing header this system accepts. */
const SIGNATURE_HEADER = 'x-vrt-signature';

/**
 * Statement import: the provider the church uses by downloading a file.
 *
 * Nothing is stored for this provider (credentialFields is empty) because there
 * is no live connection to authenticate: the admin exports the statement from
 * the portal they already log into and hands the file to the app. The signature
 * of a genuine integration is that the money data is real and complete, not that
 * a socket was opened.
 */
const statementProvider = {
  key: 'statement_import',
  labelKey: 'payment.provider_statement_import',
  helpKey: 'payment.help_statement',
  capabilities: { statement: true, webhook: false, liveSync: false },
  credentialFields: [],
  /**
   * Reads an exported statement into canonical transactions.
   * Returns `{ transactions, rejected, columns }`: `rejected` carries the line
   * number and a catalog reason key so the admin is told what was left out and
   * why, rather than being shown a smaller total with no explanation.
   */
  parseStatement(text, { account } = {}) {
    // Only an account explicitly switched OFF is refused: a caller that passes a
    // partial account row (as the seeder does) must not be mistaken for one.
    if (account && account.status === 'disabled') {
      return { transactions: [], rejected: [{ line: 0, reason: REJECT.disabledAccount }], columns: [] };
    }
    const { headers, rows } = readStatement(text);
    if (!rows.length) return { transactions: [], rejected: [{ line: 0, reason: REJECT.noColumns }], columns: [] };

    const columns = columnMap(headers);
    if (columns.amount === undefined || columns.date === undefined) {
      return { transactions: [], rejected: [{ line: 1, reason: REJECT.noColumns }], columns: Object.keys(columns) };
    }

    const transactions = [];
    const rejected = [];
    for (const row of rows) {
      const cells = headers.map((h) => row[h]);
      const amount = parseAmount(cells[columns.amount]);
      const occurredAt = parseStatementDate(cells[columns.date], columns.time !== undefined ? cells[columns.time] : '');
      const reference = columns.reference !== undefined ? cells[columns.reference] : '';
      const description = columns.description !== undefined ? cells[columns.description] : '';

      // Money OUT is not a gift, but it is not an error either: the church's own
      // payments to suppliers are simply not giving, so the row is reported as a
      // debit and left out. A blank amount column is a real error.
      const debit = columns.debit !== undefined ? parseAmount(cells[columns.debit]) : null;
      if (amount === null && debit !== null) { rejected.push({ line: row._line, reason: REJECT.notCredit }); continue; }
      if (amount === null) { rejected.push({ line: row._line, reason: REJECT.noAmount }); continue; }
      if (amount < 0) { rejected.push({ line: row._line, reason: REJECT.notCredit }); continue; }
      if (!occurredAt) { rejected.push({ line: row._line, reason: REJECT.noDate }); continue; }

      transactions.push({
        provider_transaction_id: columns.providerId !== undefined ? cells[columns.providerId] || null : null,
        provider_reference: reference || null,
        amount,
        currency: (columns.currency !== undefined && cells[columns.currency]) || account?.currency || 'TZS',
        occurred_at: occurredAt,
        payer_name: (columns.payer !== undefined && cells[columns.payer]) || null,
        payer_phone: (columns.phone !== undefined && cells[columns.phone]) || null,
        payer_account_ref: (columns.payerAccount !== undefined && cells[columns.payerAccount]) || null,
        description: description || null,
        status: columns.status !== undefined ? parseStatus(cells[columns.status]) : 'successful',
        import_line: row._line,
      });
    }
    return { transactions, rejected, columns: Object.keys(columns) };
  },
};

/** The canonical fields a webhook payload may name, and the keys they arrive under. */
const WEBHOOK_FIELD_ALIASES = {
  providerId: [
    'provider_transaction_id', 'providerTransactionId', 'transaction_id', 'transactionId', 'txnId', 'id', 'externalId',
    'providerReference', 'TransID', 'TransId', 'MpesaReceiptNumber', 'ThirdPartyTransID', 'receipt_number',
  ],
  reference: [
    'provider_reference', 'providerReference', 'reference', 'ref', 'receipt', 'receiptNumber', 'code', 'mpesaCode',
    'BillRefNumber', 'billRefNumber', 'AccountReference', 'accountNumber',
  ],
  amount: ['amount', 'value', 'credit', 'TransAmount', 'transAmount', 'transactionAmount', 'paidAmount'],
  currency: ['currency', 'ccy', 'currencyCode'],
  occurredAt: ['occurred_at', 'occurredAt', 'date', 'timestamp', 'TransTime', 'transTime', 'transactionDate', 'createdAt', 'completedAt'],
  // 'FirstName'/'LastName' are handled as a pair below, not picked from here.
  payerName: ['payer_name', 'payerName', 'payer', 'name', 'senderName', 'CustomerName', 'customerName', 'msisdn_name'],
  payerPhone: ['payer_phone', 'payerPhone', 'phone', 'phoneNumber', 'MSISDN', 'msisdn', 'mobile', 'senderPhone'],
  payerAccountRef: ['payer_account_ref', 'payerAccount', 'accountRef', 'fromAccount', 'sourceAccount', 'senderAccount'],
  description: ['description', 'narrative', 'details', 'purpose', 'narration', 'reason', 'notes'],
  status: ['status', 'transactionStatus', 'state', 'result'],
};

function pick(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

/** The transaction list out of whatever envelope a provider posts. */
function webhookRows(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  for (const key of ['transactions', 'data', 'payments', 'items', 'results', 'events']) {
    if (Array.isArray(body[key])) return body[key];
    if (body[key] && typeof body[key] === 'object') return [body[key]];
  }
  return [body];
}

function normalizeWebhookEntry(entry, account) {
  // A provider that splits the payer's name in two (M-Pesa's FirstName +
  // LastName) must be joined before the matcher sees it: half a name matches no
  // member, and "Amina" alone would look like an unmatched stranger.
  const firstName = pick(entry, ['FirstName', 'firstName']);
  const lastName = pick(entry, ['LastName', 'lastName']);
  const pickName = () => {
    if (firstName) return [firstName, lastName].filter(Boolean).join(' ');
    const whole = pick(entry, WEBHOOK_FIELD_ALIASES.payerName);
    return whole || lastName;
  };
  const amount = parseAmount(pick(entry, WEBHOOK_FIELD_ALIASES.amount));
  const occurredRaw = pick(entry, WEBHOOK_FIELD_ALIASES.occurredAt);
  const occurredAt = occurredRaw ? parseStatementDate(occurredRaw, '') || (Number.isNaN(Date.parse(occurredRaw)) ? null : new Date(occurredRaw).toISOString()) : null;
  if (amount === null || amount <= 0) return { reason: REJECT.noAmount };
  if (!occurredAt) return { reason: REJECT.noDate };
  return {
    transaction: {
      provider_transaction_id: pick(entry, WEBHOOK_FIELD_ALIASES.providerId),
      provider_reference: pick(entry, WEBHOOK_FIELD_ALIASES.reference),
      amount,
      currency: pick(entry, WEBHOOK_FIELD_ALIASES.currency) || account?.currency || 'TZS',
      occurred_at: occurredAt,
      payer_name: pickName(),
      payer_phone: pick(entry, WEBHOOK_FIELD_ALIASES.payerPhone),
      payer_account_ref: pick(entry, WEBHOOK_FIELD_ALIASES.payerAccountRef),
      description: pick(entry, WEBHOOK_FIELD_ALIASES.description),
      status: parseStatus(pick(entry, WEBHOOK_FIELD_ALIASES.status)),
    },
  };
}

/**
 * Webhook intake: signed JSON notifications.
 *
 * The provider-agnostic half of an integration. It accepts the field names the
 * common Tanzanian aggregators and gateways use (M-Pesa's `TransAmount`/
 * `Msisdn`/`TransID`, Selcom/DPO-style `reference`/`amount`, and plain
 * snake_case), and it authenticates the caller with an HMAC of the raw request
 * body using the account's own secret, so a forged POST cannot invent a gift,
 * and no reusable login is stored. A provider whose signature scheme differs
 * needs five lines here (or its own adapter) rather than a new subsystem.
 */
const webhookProvider = {
  key: 'webhook',
  labelKey: 'payment.provider_webhook',
  helpKey: 'payment.help_webhook',
  capabilities: { statement: false, webhook: true, liveSync: false },
  credentialFields: ['webhook_secret'],
  parseStatement() {
    return { transactions: [], rejected: [{ line: 0, reason: REJECT.noAmount }], columns: [] };
  },
  parseWebhook(body, { account } = {}) {
    if (account && account.status === 'disabled') {
      return { transactions: [], rejected: [{ line: 0, reason: REJECT.disabledAccount }] };
    }
    const transactions = [];
    const rejected = [];
    for (const [i, entry] of webhookRows(body).entries()) {
      const { transaction, reason } = normalizeWebhookEntry(entry || {}, account);
      if (reason) rejected.push({ line: i + 1, reason });
      else transactions.push(transaction);
    }
    return { transactions, rejected };
  },
};

const PROVIDERS = [statementProvider, webhookProvider];

/** A provider by key, or undefined. */
function getProvider(key) {
  return PROVIDERS.find((p) => p.key === key);
}

/**
 * Every provider key, as a literal list rather than derived from PROVIDERS, so
 * the enum sweep in test/generated-text-i18n.test.js can read it out of this
 * file and fail the build if a provider is added without a label in both
 * catalogs (`payment.provider_*`): a new provider that the admin screen could
 * only show as "statement_import" would be a bug shipped in advance.
 */
const PROVIDER_KEYS = ['statement_import', 'webhook'];

// A drifted list would silently blind that guard, so it is checked at load.
if (PROVIDER_KEYS.length !== PROVIDERS.length || PROVIDERS.some((p) => !PROVIDER_KEYS.includes(p.key))) {
  throw new Error('PROVIDER_KEYS must list every provider (see utils/paymentProviders.js)');
}

/** The registry as the admin app sees it: what each provider can do, and which
 *  secrets it needs an admin to supply. Never carries a secret value. */
function listProviders() {
  return PROVIDERS.map((p) => ({
    key: p.key,
    labelKey: p.labelKey,
    helpKey: p.helpKey,
    capabilities: p.capabilities,
    credentialFields: p.credentialFields,
  }));
}

module.exports = {
  PROVIDERS,
  PROVIDER_KEYS,
  TRANSACTION_STATUSES,
  REJECT,
  COLUMN_ALIASES,
  SIGNATURE_HEADER,
  getProvider,
  listProviders,
  parseAmount,
  parseStatementDate,
  parseStatus,
  columnMap,
  parseStatement: statementProvider.parseStatement,
  parseWebhook: webhookProvider.parseWebhook,
};
