import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Ban, Check, CheckCheck, ChevronDown, ChevronRight, Copy, Eye, KeyRound, Link2, Plus,
  RefreshCw, RotateCcw, Search, ShieldCheck, Undo2, Upload, Wallet,
} from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import MemberPicker from '../components/MemberPicker';
import StatusBanner from '../components/StatusBanner';
import { PAYMENT_METHODS, paymentMethodLabel } from '../paymentMethods';
import { EMPTY_VALUE } from '../emptyValue';
import MemberLink from '../components/MemberLink';

/*
 * Incoming payments: the reconciliation screen.
 *
 *   church account -> payments that arrived -> automatic matching
 *   -> matched / unmatched -> review -> confirmed giving record -> receipt
 *
 * WHAT THIS SCREEN IS NOT: a way to type gifts in. The front desk records cash;
 * this screen explains money that arrived in the church's own bank or
 * mobile-money account and turns it into giving only when a person confirms it.
 * Every confirmed payment writes the SAME offering the front desk writes, same
 * receipt, same QR code (server: routes/paymentTransactions.js), so nothing here
 * is a parallel ledger and no report has to add two sources of money together.
 *
 * WHAT AN ADMIN CANNOT DO HERE, on purpose:
 *   - read a stored secret. A webhook secret is shown once, when it is created or
 *     rotated, and never again (server: utils/paymentAccounts.js);
 *   - confirm money the provider reported as failed or reversed: the server
 *     refuses it, and the row says why;
 *   - record the same payment twice: the offering carries the payment's id under
 *     a UNIQUE index, so a double confirmation answers with the receipt that
 *     already exists instead of issuing a second one;
 *   - see payments at all if they are not an administrator (the API refuses).
 *
 * A gift counted by hand at the desk has no account and never appears here: cash
 * is not an incoming transfer, and the reports show it as its own bucket rather
 * than pretending it arrived at a bank.
 */

const MATCH_ORDER = ['review', 'unmatched', 'matched', 'confirmed', 'ignored'];

const MATCH_STYLE = {
  review: 'border-warn-300 bg-warn-50 text-warn-800',
  unmatched: 'border-danger-300 bg-danger-50 text-danger-700',
  matched: 'border-brand-300 bg-brand-50 text-brand-800',
  confirmed: 'border-people-300 bg-people-50 text-people-700',
  ignored: 'border-ink-200 bg-ink-100 text-ink-600',
};

/** The church's own verdict on a payment, as a label. Spelled out rather than
 *  assembled from the key, so the catalog sweep (i18n/catalogCoverage.test.js)
 *  can see every label a reader may be shown. */
function matchLabel(t, status) {
  if (status === 'review') return t('reconciliation.match_review');
  if (status === 'unmatched') return t('reconciliation.match_unmatched');
  if (status === 'matched') return t('reconciliation.match_matched');
  if (status === 'confirmed') return t('reconciliation.match_confirmed');
  if (status === 'ignored') return t('reconciliation.match_ignored');
  return status;
}

/** What the PROVIDER said about the payment: a different axis from the church's
 *  own state above: a payment can be matched and still have been reversed. */
function providerStatusLabel(t, status) {
  if (status === 'successful') return t('reconciliation.status_successful');
  if (status === 'pending') return t('reconciliation.status_pending');
  if (status === 'reversed') return t('reconciliation.status_reversed');
  if (status === 'failed') return t('reconciliation.status_failed');
  return status;
}

/** The stored integration key, labelled. A connection type is an enum, so it is
 *  never printed raw (the same rule the server applies to its own messages). */
function providerLabel(t, provider) {
  if (provider === 'statement_import') return t('reconciliation.provider_statement');
  if (provider === 'webhook') return t('reconciliation.provider_webhook');
  return provider;
}

/** How a payment arrived: a file the church downloaded, or a notification the
 *  provider posted. Shown because an admin reconciling a discrepancy needs to
 *  know which of the two delivered the row. */
function sourceLabel(t, source) {
  if (source === 'statement') return t('reconciliation.source_statement');
  if (source === 'webhook') return t('reconciliation.source_webhook');
  if (source === 'demo') return t('reconciliation.source_demo');
  return source;
}

/** Why the statement reader skipped a line. The server sends a catalog key, so
 *  the reason an admin reads is in their own language; anything unrecognised is
 *  shown as it came rather than guessed at. */
function rejectLabel(t, reason) {
  if (typeof reason !== 'string' || !reason.startsWith('payment.reject_')) return reason;
  const known = t(reason);
  return known === reason ? reason : known;
}

function moneyFor(total, currency) {
  try {
    return new Intl.NumberFormat('en-TZ', { style: 'currency', currency: currency || 'TZS', maximumFractionDigits: 0 }).format(total);
  } catch {
    return `${total} ${currency || 'TZS'}`;
  }
}

function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export default function Reconciliation() {
  const { t } = useTranslation();

  const [accounts, setAccounts] = useState([]);
  const [providers, setProviders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [banner, setBanner] = useState(null);

  const [accountFilter, setAccountFilter] = useState('');
  const [matchFilter, setMatchFilter] = useState('review,unmatched,matched');
  const [from, setFrom] = useState(() => daysAgoISO(60));
  const [to, setTo] = useState(todayISO);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [openId, setOpenId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [issuedSecret, setIssuedSecret] = useState(null);
  const [pendingIgnoreId, setPendingIgnoreId] = useState(null);
  const [ignoreReason, setIgnoreReason] = useState('');
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [accountDraft, setAccountDraft] = useState({ name: '', provider: 'statement_import', method: 'bank', accountRef: '', currency: 'TZS' });
  const [statementText, setStatementText] = useState('');
  const [statementFileName, setStatementFileName] = useState('');
  const [statementAccountId, setStatementAccountId] = useState('');
  const [syncResult, setSyncResult] = useState(null);
  const [syncTarget, setSyncTarget] = useState('');

  const [serviceTypes, setServiceTypes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [pick, setPick] = useState({});            // transaction id -> member pick
  const [draftOverrides, setDraftOverrides] = useState({}); // transaction id -> confirm form edits

  const loadAccounts = useCallback(
    () =>
      api
        .get('/payment-accounts')
        .then(({ data }) => {
          setAccounts(data.accounts || []);
          setProviders(data.providers || []);
        })
        .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) })),
    []
  );

  const loadTransactions = useCallback(() => {
    if (!from || !to || from > to) return undefined;
    return api
      .get('/payment-transactions', {
        params: { from, to, accountId: accountFilter || undefined, matchStatus: matchFilter || undefined, q: search.trim() || undefined },
      })
      .then(({ data }) => setTransactions(data.transactions || []))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }))
      .finally(() => setLoaded(true));
  }, [from, to, accountFilter, matchFilter, search]);

  const loadSummary = useCallback(
    () =>
      api
        .get('/payment-transactions/summary', { params: { accountId: accountFilter || undefined, from, to } })
        .then(({ data }) => setSummary(data))
        .catch(() => setSummary(null)),
    [accountFilter, from, to]
  );

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadTransactions(); loadSummary(); }, [loadTransactions, loadSummary]);

  // The search box is settled before it is sent: a slip number is a dozen
  // characters, and one request per keystroke would be eleven wasted ones. The
  // search itself is done by the SERVER, not over the loaded rows, because the
  // reason to search is usually an old payment that is not in the current window.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    // The confirm form needs the church's own vocabulary: the categories it
    // records gifts under, and the sessions they are filed against.
    Promise.all([api.get('/service-types'), api.get('/offerings/categories')])
      .then(([st, c]) => {
        setServiceTypes((st.data.serviceTypes || []).filter((s) => s.kind !== 'rehearsal' && s.is_active !== 0));
        setCategories(c.data.categories || []);
      })
      .catch(() => { /* the form stays empty; nothing else on the page needs it */ });
  }, []);

  function refresh() {
    loadTransactions();
    loadAccounts();
    loadSummary();
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setBanner({ type: 'success', message: t('reconciliation.copied') });
    } catch {
      // A browser that blocks the clipboard still shows the value to copy.
      setBanner({ type: 'info', message: text });
    }
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  async function createAccount(e) {
    e.preventDefault();
    setBanner(null);
    try {
      const { data } = await api.post('/payment-accounts', {
        name: accountDraft.name.trim(),
        provider: accountDraft.provider,
        method: accountDraft.method,
        accountRef: accountDraft.accountRef.trim() || undefined,
        currency: accountDraft.currency.trim() || 'TZS',
      });
      setShowAccountForm(false);
      setAccountDraft({ name: '', provider: 'statement_import', method: 'bank', accountRef: '', currency: 'TZS' });
      // The secret is shown HERE and nowhere else, ever: this response is the one
      // moment it exists outside the encrypted column.
      if (data.issuedCredentials?.webhook_secret) setIssuedSecret({ account: data.account, secret: data.issuedCredentials.webhook_secret });
      setBanner({ type: 'success', message: t('reconciliation.accountAdded', { name: data.account.name }) });
      refresh();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    }
  }

  async function patchAccount(account, patch, successKey) {
    setBanner(null);
    try {
      const { data } = await api.patch(`/payment-accounts/${account.id}`, patch);
      if (data.issuedCredentials?.webhook_secret) setIssuedSecret({ account: data.account, secret: data.issuedCredentials.webhook_secret });
      setBanner({ type: 'success', message: t(successKey, { name: data.account.name }) });
      refresh();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    }
  }

  async function disconnect(account) {
    setBanner(null);
    try {
      await api.delete(`/payment-accounts/${account.id}`);
      setBanner({ type: 'success', message: t('reconciliation.accountDisconnected', { name: account.name }) });
      refresh();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    }
  }

  function readStatementFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatementFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setStatementText(String(reader.result || ''));
    reader.readAsText(file);
  }

  async function syncStatement(account) {
    setSyncTarget(account.id);
    setSyncResult(null);
    setBanner(null);
    try {
      const { data } = await api.post(`/payment-accounts/${account.id}/sync`, {
        statement: statementText,
        fileName: statementFileName || undefined,
      });
      setSyncResult({ accountId: account.id, ...data });
      setStatementText('');
      setStatementFileName('');
      setBanner({ type: 'success', message: t('reconciliation.importDone', { inserted: data.inserted, duplicates: data.duplicates }) });
      refresh();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSyncTarget('');
    }
  }

  // -------------------------------------------------------------------------
  // One payment
  // -------------------------------------------------------------------------

  async function postAction(action, id, body) {
    setBusyId(id);
    setBanner(null);
    try {
      const { data } = await api.post(`/payment-transactions/${id}/${action}`, body);
      refresh();
      return data;
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
      return null;
    } finally {
      setBusyId(null);
    }
  }

  async function match(transaction) {
    const chosen = pick[transaction.id]?.[0];
    if (!chosen?.memberId) {
      setBanner({ type: 'error', message: t('reconciliation.chooseMember') });
      return;
    }
    const data = await postAction('match', transaction.id, { memberId: chosen.memberId });
    if (data) setBanner({ type: 'success', message: t('reconciliation.matched', { name: chosen.name }) });
  }

  async function unmatch(transaction) {
    const data = await postAction('unmatch', transaction.id, {});
    if (data) setBanner({ type: 'success', message: t('reconciliation.unmatchedBanner') });
  }

  async function ignore(transaction) {
    const data = await postAction('ignore', transaction.id, { reason: ignoreReason.trim() || undefined });
    if (data) {
      setPendingIgnoreId(null);
      setIgnoreReason('');
      setBanner({ type: 'success', message: t('reconciliation.ignoredBanner') });
    }
  }

  async function reopen(transaction) {
    const data = await postAction('reopen', transaction.id, {});
    if (data) setBanner({ type: 'success', message: t('reconciliation.reopenedBanner') });
  }

  async function confirm(transaction) {
    const draft = effectiveDraft(transaction);
    if (!draft.category) {
      setBanner({ type: 'error', message: t('reconciliation.chooseCategory') });
      return;
    }
    if (!draft.serviceTypeId) {
      setBanner({ type: 'error', message: t('reconciliation.chooseService') });
      return;
    }
    const data = await postAction('confirm', transaction.id, {
      category: draft.category,
      serviceTypeId: Number(draft.serviceTypeId),
      date: draft.date,
    });
    if (data) {
      setOpenId(null);
      setBanner({ type: 'success', message: t('reconciliation.confirmed', { receipt: data.receiptNumber || EMPTY_VALUE }) });
    }
  }

  /**
   * The confirm form's current values for a row: what the admin has edited, over
   * the defaults the row suggests (the category that issues a receipt, the first
   * active service type, and the day the money actually moved).
   */
  function effectiveDraft(transaction) {
    const stored = draftOverrides[transaction.id] || {};
    const defaultCategory = (categories.find((c) => c.requires_receipt === 1) || categories[0])?.key || '';
    const defaultService = serviceTypes[0]?.id ? String(serviceTypes[0].id) : '';
    return {
      category: stored.category ?? defaultCategory,
      serviceTypeId: stored.serviceTypeId ?? defaultService,
      date: stored.date ?? transaction.occurredAt.slice(0, 10),
    };
  }

  function setDraft(transaction, patch) {
    setDraftOverrides((current) => ({
      ...current,
      [transaction.id]: { ...effectiveDraft(transaction), ...patch },
    }));
  }

  const counts = summary?.counts || {};
  const statementAccounts = accounts.filter((a) => a.capabilities?.statement);
  const accountRows = useMemo(() => accounts, [accounts]);

  const columns = [
    {
      key: 'date',
      header: t('reconciliation.colDate'),
      width: 12,
      render: (r) => <span className="text-ink-600">{r.occurredAt.slice(0, 10)}</span>,
    },
    {
      key: 'payer',
      header: t('reconciliation.colPayer'),
      render: (r) => (
        <span className="block">
          <span className="font-medium text-ink-900">{r.payerName || t('reconciliation.noPayerName')}</span>
          <span className="block truncate text-xs text-ink-400">
            {r.matchedMemberName
              ? <MemberLink memberId={r.matchedMemberId}>&rarr; {r.matchedMemberName} {r.matchedMemberNo || ''}</MemberLink>
              : r.suggestedMemberName
                ? t('reconciliation.suggestedTo', { name: r.suggestedMemberName })
                : r.payerPhone || r.accountName}
          </span>
        </span>
      ),
    },
    {
      key: 'amount',
      header: t('reconciliation.colAmount'),
      width: 15,
      align: 'right',
      cardValue: true,
      render: (r) => <span className="tabular-nums text-ink-900">{moneyFor(r.amount, r.currency)}</span>,
    },
    {
      key: 'reference',
      header: t('reconciliation.colReference'),
      width: 16,
      render: (r) => <span className="font-mono text-xs text-ink-600">{r.providerReference || r.providerTransactionId}</span>,
    },
    {
      key: 'state',
      header: t('reconciliation.colState'),
      width: 20,
      render: (r) => (
        <span className="flex flex-wrap gap-1">
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${MATCH_STYLE[r.matchStatus]}`}>
            {r.matchStatus === 'confirmed' && <CheckCheck size={12} />}
            {r.matchStatus === 'ignored' && <Ban size={12} />}
            {matchLabel(t, r.matchStatus)}
          </span>
          {r.status !== 'successful' && (
            <span className="inline-flex items-center gap-1 rounded-full border border-danger-300 bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-700">
              <AlertTriangle size={12} /> {providerStatusLabel(t, r.status)}
            </span>
          )}
          {r.possibleDuplicateOf && (
            <span className="inline-flex items-center rounded-full border border-warn-300 bg-warn-50 px-2 py-0.5 text-xs font-medium text-warn-800">
              {t('reconciliation.possibleDuplicate', { id: r.possibleDuplicateOf })}
            </span>
          )}
          {r.matchNote === 'code_vs_payer_name' && (
            <span className="inline-flex items-center gap-1 rounded-full border border-warn-300 bg-warn-50 px-2 py-0.5 text-xs font-medium text-warn-800">
              <AlertTriangle size={12} /> {t('reconciliation.conflictChip')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 10,
      align: 'right',
      render: (r) => (
        <button
          type="button"
          onClick={() => {
            setOpenId(openId === r.id ? null : r.id);
            setPendingIgnoreId(null);
          }}
          aria-expanded={openId === r.id}
          className="inline-flex items-center gap-1 rounded-md border border-ink-200 px-2 py-1 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800"
        >
          {openId === r.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t('reconciliation.review')}
        </button>
      ),
    },
  ];

  function detailsPanel(transaction) {
    const draft = effectiveDraft(transaction);
    const busy = busyId === transaction.id;
    const notConfirmable = transaction.status === 'failed' || transaction.status === 'reversed';
    const field = (label, value) => (
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</span>
        <span className="min-w-0 break-words text-right text-sm text-ink-800">{value}</span>
      </span>
    );

    return (
      <div className="space-y-2 py-1">
        {field(t('reconciliation.providerReference'), <span className="font-mono">{transaction.providerReference || EMPTY_VALUE}</span>)}
        {field(t('reconciliation.providerTransaction'), <span className="font-mono">{transaction.providerTransactionId}</span>)}
        {field(t('reconciliation.account'), `${transaction.accountName} · ${paymentMethodLabel(t, transaction.method)}`)}
        {field(t('reconciliation.arrivedBy'), sourceLabel(t, transaction.source))}
        {field(t('reconciliation.payerPhone'), transaction.payerPhone || t('reconciliation.notRecorded'))}
        {field(t('reconciliation.description'), transaction.description || t('reconciliation.notRecorded'))}
        {field(
          t('reconciliation.imported'),
          `${transaction.importedAt}${transaction.importNote ? ` · ${transaction.importNote}` : ''}`
        )}
        {transaction.reconciledAt && field(t('reconciliation.reconciledAt'), transaction.reconciledAt)}
        {transaction.ignoredReason && field(t('reconciliation.ignoredReason'), transaction.ignoredReason)}

        {transaction.matchStatus === 'confirmed' ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-people-200 bg-people-50 p-3">
            <ShieldCheck size={14} className="text-people-700" />
            <span className="text-sm text-people-800">{t('reconciliation.recordedAs', { receipt: transaction.receiptNumber || EMPTY_VALUE })}</span>
            {transaction.verificationUrl && (
              <button type="button" onClick={() => copy(transaction.verificationUrl)} className="btn btn-secondary px-3 py-1.5 text-xs">
                <Copy size={13} /> {t('reconciliation.copyLink')}
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 space-y-3 rounded-lg border border-ink-200 bg-paper p-3">
            {notConfirmable && (
              <StatusBanner type="error" message={t('reconciliation.notConfirmable', { status: providerStatusLabel(t, transaction.status) })} />
            )}

            {/* Two steps, in the order the workflow has them: say WHO it is, then
                say WHAT it is. Merging them into one button would make it easy to
                record a gift for the wrong person without noticing. */}
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('reconciliation.stepMatch')}</p>
              {transaction.matchStatus === 'review' && transaction.suggestedMemberName && (
                <p className="text-xs text-ink-600">{t('reconciliation.suggestionNote', { name: transaction.suggestedMemberName })}</p>
              )}
              {transaction.matchNote === 'code_vs_payer_name' && transaction.suggestedMemberName && (
                <p className="rounded border border-warn-300 bg-warn-50 p-2 text-xs text-warn-800">
                  {t('reconciliation.conflictNote', { suggested: transaction.suggestedMemberName })}
                </p>
              )}
              <MemberPicker
                single
                tone="offering"
                allowFreetext={false}
                placeholder={t('reconciliation.searchMember')}
                selected={
                  pick[transaction.id]
                  || (transaction.matchedMemberId ? [{ memberId: transaction.matchedMemberId, name: transaction.matchedMemberName }] : [])
                }
                onChange={(next) => setPick((current) => ({ ...current, [transaction.id]: next }))}
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => match(transaction)} className="btn btn-secondary px-3 py-1.5 text-xs">
                  <Link2 size={13} /> {t('reconciliation.matchAction')}
                </button>
                {transaction.matchedMemberId && (
                  <button type="button" disabled={busy} onClick={() => unmatch(transaction)} className="btn btn-secondary px-3 py-1.5 text-xs">
                    <Undo2 size={13} /> {t('reconciliation.unmatchAction')}
                  </button>
                )}
                {transaction.matchStatus === 'ignored' ? (
                  <button type="button" disabled={busy} onClick={() => reopen(transaction)} className="btn btn-secondary px-3 py-1.5 text-xs">
                    <RotateCcw size={13} /> {t('reconciliation.reopenAction')}
                  </button>
                ) : pendingIgnoreId !== transaction.id ? (
                  <button type="button" disabled={busy} onClick={() => setPendingIgnoreId(transaction.id)} className="btn btn-secondary px-3 py-1.5 text-xs">
                    <Ban size={13} /> {t('reconciliation.ignoreAction')}
                  </button>
                ) : null}
              </div>

              {/* Setting a payment aside is a decision about money, so it is
                  confirmed with a reason the admin writes, rather than one click
                  (and the reason is what the next person reads). */}
              {pendingIgnoreId === transaction.id && (
                <div className="rounded-md border border-ink-200 bg-ink-50/60 p-3">
                  <p className="text-xs font-medium text-ink-800">{t('reconciliation.ignoreConfirm')}</p>
                  <input
                    value={ignoreReason}
                    onChange={(e) => setIgnoreReason(e.target.value)}
                    placeholder={t('reconciliation.ignoreReasonPlaceholder')}
                    aria-label={t('reconciliation.ignoreReason')}
                    className="mt-2 w-full rounded-md border border-ink-200 px-3 py-1.5 text-xs focus-visible:border-brand-600"
                  />
                  <div className="mt-2 flex gap-2">
                    <button type="button" disabled={busy} onClick={() => ignore(transaction)} className="btn btn-danger px-3 py-1.5 text-xs">
                      {busy ? t('common.saving') : t('reconciliation.ignoreYes')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setPendingIgnoreId(null); setIgnoreReason(''); }}
                      className="btn btn-secondary px-3 py-1.5 text-xs"
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-ink-100 pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('reconciliation.stepConfirm')}</p>
              <p className="text-xs text-ink-500">{t('reconciliation.confirmNote')}</p>
              <div className="flex flex-wrap gap-2">
                <label className="text-xs">
                  <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.category')}</span>
                  <select
                    value={draft.category}
                    onChange={(e) => setDraft(transaction, { category: e.target.value })}
                    className="rounded-md border border-ink-200 px-2 py-1.5 text-sm focus-visible:border-brand-600"
                  >
                    {categories.map((c) => (
                      <option key={c.key} value={c.key}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs">
                  <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.service')}</span>
                  <select
                    value={draft.serviceTypeId}
                    onChange={(e) => setDraft(transaction, { serviceTypeId: e.target.value })}
                    className="rounded-md border border-ink-200 px-2 py-1.5 text-sm focus-visible:border-brand-600"
                  >
                    {serviceTypes.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs">
                  <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.date')}</span>
                  <input
                    type="date"
                    value={draft.date}
                    onChange={(e) => setDraft(transaction, { date: e.target.value })}
                    className="rounded-md border border-ink-200 px-2 py-1.5 text-sm focus-visible:border-brand-600"
                  />
                </label>
              </div>
              <p className="text-xs text-ink-400">{t('reconciliation.dateNote', { date: transaction.occurredAt.slice(0, 10) })}</p>
              <button type="button" disabled={busy || notConfirmable} onClick={() => confirm(transaction)} className="btn btn-primary px-3 py-1.5 text-xs">
                <Check size={13} /> {busy ? t('common.saving') : t('reconciliation.confirmAction')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-semibold">{t('reconciliation.title')}</h1>
      <p className="mb-5 max-w-3xl text-sm text-ink-500">{t('reconciliation.intro')}</p>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {/* A secret is displayed once (on creation or rotation) and is never
          readable again, so it gets the most prominent place on the page. */}
      {issuedSecret && (
        <section className="mb-5 rounded-xl border border-warn-300 bg-warn-50 p-4 shadow-sm">
          <h2 className="flex items-center gap-1.5 font-display font-semibold text-warn-800">
            <KeyRound size={16} /> {t('reconciliation.secretTitle', { name: issuedSecret.account.name })}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-warn-800">{t('reconciliation.secretNote')}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-md border border-warn-300 bg-paper px-2 py-1 font-mono text-xs">{issuedSecret.secret}</code>
            <button type="button" onClick={() => copy(issuedSecret.secret)} className="btn btn-secondary px-3 py-1.5 text-xs">
              <Copy size={13} /> {t('reconciliation.copy')}
            </button>
            <button type="button" onClick={() => setIssuedSecret(null)} className="btn btn-secondary px-3 py-1.5 text-xs">
              {t('reconciliation.secretDismiss')}
            </button>
          </div>
          {issuedSecret.account.webhookUrl && (
            <p className="mt-2 break-all font-mono text-xs text-warn-800">
              {t('reconciliation.webhookUrl')}: {issuedSecret.account.webhookUrl}
            </p>
          )}
        </section>
      )}

      <section className="mb-6 rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 font-display text-lg font-semibold">
              <Wallet size={17} className="text-ink-600" /> {t('reconciliation.accountsTitle')}
            </h2>
            <p className="max-w-3xl text-sm text-ink-500">{t('reconciliation.accountsNote')}</p>
          </div>
          <button type="button" onClick={() => setShowAccountForm((v) => !v)} className="btn btn-ink">
            <Plus size={15} /> {t('reconciliation.addAccount')}
          </button>
        </div>

        <DataTable
          columns={[
            {
              key: 'name',
              header: t('reconciliation.colAccount'),
              render: (a) => (
                <span className="block">
                  <span className="font-medium text-ink-900">{a.name}</span>
                  <span className="block truncate text-xs text-ink-400">
                    {providerLabel(t, a.provider)} · {paymentMethodLabel(t, a.method)} {a.accountRefMasked ? `· ${a.accountRefMasked}` : ''}
                  </span>
                </span>
              ),
            },
            {
              key: 'status',
              header: t('reconciliation.colAccountStatus'),
              width: 14,
              render: (a) => (
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${a.status === 'active' ? 'border-people-300 bg-people-50 text-people-700' : 'border-ink-200 bg-ink-100 text-ink-600'}`}>
                  {a.status === 'active' ? t('reconciliation.accountActive') : t('reconciliation.accountDisabled')}
                </span>
              ),
            },
            {
              key: 'awaiting',
              header: t('reconciliation.colAwaiting'),
              width: 20,
              cardValue: true,
              render: (a) => (
                <span className="text-sm text-ink-700">
                  {a.pending.awaiting > 0
                    ? t('reconciliation.awaitingCount', { count: a.pending.awaiting, amount: moneyFor(a.pending.awaitingAmount, a.currency) })
                    : t('reconciliation.nothingAwaiting')}
                </span>
              ),
            },
            {
              key: 'synced',
              header: t('reconciliation.colSynced'),
              width: 20,
              render: (a) => (
                <span className="text-xs text-ink-500">
                  {a.lastSyncedAt || t('reconciliation.neverSynced')}
                  {a.lastSyncSummary && (
                    <span className="block">
                      {t('reconciliation.syncSummary', {
                        inserted: a.lastSyncSummary.inserted,
                        duplicates: a.lastSyncSummary.duplicates,
                        rejected: a.lastSyncSummary.rejected,
                      })}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'accountActions',
              header: '',
              width: 18,
              align: 'right',
              render: (a) => (
                <span className="flex flex-wrap justify-end gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      patchAccount(
                        a,
                        { status: a.status === 'active' ? 'disabled' : 'active' },
                        a.status === 'active' ? 'reconciliation.accountSwitchedOff' : 'reconciliation.accountSwitchedOn'
                      )
                    }
                    className="btn btn-secondary px-2 py-1 text-xs"
                  >
                    {a.status === 'active' ? t('reconciliation.switchOff') : t('reconciliation.switchOn')}
                  </button>
                  {a.credentialFields?.includes('webhook_secret') && (
                    <button
                      type="button"
                      onClick={() => patchAccount(a, { rotateWebhookSecret: true }, 'reconciliation.secretRotated')}
                      className="btn btn-secondary px-2 py-1 text-xs"
                    >
                      <RefreshCw size={12} /> {t('reconciliation.rotateSecret')}
                    </button>
                  )}
                  {!a.lastSyncedAt && a.pending?.awaiting === 0 && (
                    <button type="button" onClick={() => disconnect(a)} className="btn btn-secondary px-2 py-1 text-xs">
                      {t('reconciliation.disconnect')}
                    </button>
                  )}
                </span>
              ),
            },
          ]}
          rows={accountRows}
          keyOf={(a) => a.id}
          empty={<p className="py-4 text-sm text-ink-400">{t('reconciliation.noAccounts')}</p>}
        />

        {showAccountForm && (
          <form onSubmit={createAccount} className="mt-4 space-y-3 rounded-lg border border-ink-200 bg-ink-50/60 p-4">
            <p className="max-w-3xl text-xs text-ink-500">{t('reconciliation.credentialsNote')}</p>
            <div className="flex flex-wrap gap-3">
              <label className="text-xs">
                <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.accountName')}</span>
                <input
                  value={accountDraft.name}
                  onChange={(e) => setAccountDraft({ ...accountDraft, name: e.target.value })}
                  required
                  placeholder={t('reconciliation.accountNamePlaceholder')}
                  className="w-64 rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                />
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.provider')}</span>
                <select
                  value={accountDraft.provider}
                  onChange={(e) => setAccountDraft({ ...accountDraft, provider: e.target.value })}
                  className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                >
                  {providers.map((p) => (
                    <option key={p.key} value={p.key}>{providerLabel(t, p.key)}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.method')}</span>
                <select
                  value={accountDraft.method}
                  onChange={(e) => setAccountDraft({ ...accountDraft, method: e.target.value })}
                  className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>{paymentMethodLabel(t, m)}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.accountRef')}</span>
                <input
                  value={accountDraft.accountRef}
                  onChange={(e) => setAccountDraft({ ...accountDraft, accountRef: e.target.value })}
                  placeholder={t('reconciliation.accountRefPlaceholder')}
                  className="w-48 rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                />
              </label>
            </div>
            {providers.find((p) => p.key === accountDraft.provider)?.helpKey && (
              <p className="max-w-3xl text-xs text-ink-600">{t(providers.find((p) => p.key === accountDraft.provider).helpKey)}</p>
            )}
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary">{t('reconciliation.connect')}</button>
              <button type="button" onClick={() => setShowAccountForm(false)} className="btn btn-secondary">{t('common.cancel')}</button>
            </div>
          </form>
        )}

        {/* Statement upload. The file is read in the BROWSER and posted as text,
            so the export never has to be stored anywhere and the operator can see
            exactly what was sent before sending it. */}
        {statementAccounts.length > 0 && (
          <div className="mt-4 space-y-2 rounded-lg border border-ink-200 p-4">
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink-800">
              <Upload size={14} /> {t('reconciliation.uploadTitle')}
            </p>
            <p className="max-w-3xl text-xs text-ink-500">{t('reconciliation.uploadNote')}</p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs">
                <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.uploadAccount')}</span>
                <select
                  value={statementAccountId || String(statementAccounts[0].id)}
                  onChange={(e) => setStatementAccountId(e.target.value)}
                  className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                >
                  {statementAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block font-medium text-ink-500">{t('reconciliation.uploadFile')}</span>
                <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={readStatementFile} className="block text-xs" />
              </label>
            </div>
            <textarea
              value={statementText}
              onChange={(e) => setStatementText(e.target.value)}
              rows={4}
              placeholder={t('reconciliation.uploadPlaceholder')}
              aria-label={t('reconciliation.uploadPlaceholder')}
              className="w-full rounded-md border border-ink-200 px-3 py-2 font-mono text-xs focus-visible:border-brand-600"
            />
            <div className="flex flex-wrap gap-2">
              {statementAccounts
                .filter((a) => String(a.id) === (statementAccountId || String(statementAccounts[0].id)))
                .map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={!statementText.trim() || syncTarget === a.id}
                    onClick={() => syncStatement(a)}
                    className="btn btn-primary px-3 py-1.5 text-xs"
                  >
                    <Upload size={13} /> {syncTarget === a.id ? t('common.saving') : t('reconciliation.importInto', { name: a.name })}
                  </button>
                ))}
            </div>

            {syncResult && (
              <div className="space-y-2 rounded-md border border-ink-200 bg-paper p-3 text-xs">
                <p className="font-medium text-ink-800">
                  {t('reconciliation.resultLine', {
                    inserted: syncResult.inserted,
                    duplicates: syncResult.duplicates,
                    matched: syncResult.matched,
                    review: syncResult.review,
                    unmatched: syncResult.unmatched,
                  })}
                </p>
                {syncResult.rejected?.length > 0 && (
                  <div>
                    <p className="font-medium text-ink-700">{t('reconciliation.rejectedTitle')}</p>
                    <ul className="mt-1 space-y-0.5 text-ink-600">
                      {syncResult.rejected.map((r, i) => (
                        <li key={`${r.line}-${i}`}>{t('reconciliation.rejectedRow', { line: r.line ?? EMPTY_VALUE, reason: rejectLabel(t, r.reason) })}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {syncResult.columns?.length > 0 && (
                  <p className="text-ink-400">{t('reconciliation.columnsRead', { columns: syncResult.columns.join(', ') })}</p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
        <h2 className="mb-1 flex items-center gap-1.5 font-display text-lg font-semibold">
          <Eye size={17} className="text-ink-600" /> {t('reconciliation.paymentsTitle')}
        </h2>
        <p className="mb-4 max-w-3xl text-sm text-ink-500">{t('reconciliation.paymentsNote')}</p>

        {summary && (
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMatchFilter('review,unmatched')}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${matchFilter === 'review,unmatched' ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-ink-200 text-ink-600 hover:border-ink-300'}`}
            >
              {t('reconciliation.chipAwaiting', { count: summary.awaiting, amount: moneyFor(summary.awaitingAmount, 'TZS') })}
            </button>
            {MATCH_ORDER.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setMatchFilter(status)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${matchFilter === status ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-ink-200 text-ink-600 hover:border-ink-300'}`}
              >
                {matchLabel(t, status)}{counts[status] != null ? ` (${counts[status]})` : ''}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setMatchFilter('')}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${matchFilter === '' ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-ink-200 text-ink-600 hover:border-ink-300'}`}
            >
              {t('reconciliation.chipAll')}
            </button>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">{t('reconciliation.from')}</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">{t('reconciliation.to')}</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">{t('reconciliation.account')}</span>
            <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600">
              <option value="">{t('reconciliation.allAccounts')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className="min-w-[12rem] flex-1 text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">{t('reconciliation.search')}</span>
            <span className="relative block">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden="true" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t('reconciliation.searchPlaceholder')}
                className="w-full rounded-md border border-ink-200 py-2 pl-8 pr-3 text-sm focus-visible:border-brand-600"
              />
            </span>
          </label>
        </div>

        {!loaded ? (
          <p className="py-6 text-center text-sm text-ink-400">{t('common.loading')}</p>
        ) : (
          <DataTable
            columns={columns}
            rows={transactions}
            keyOf={(r) => r.id}
            expandedRow={(r) => (openId === r.id ? detailsPanel(r) : null)}
            empty={<p className="py-6 text-center text-sm text-ink-400">{t('reconciliation.empty')}</p>}
          />
        )}
      </section>
    </AppShell>
  );
}
