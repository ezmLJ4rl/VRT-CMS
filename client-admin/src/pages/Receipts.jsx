import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Ban, ChevronDown, ChevronRight, Copy, FileText, History, Printer, QrCode, RotateCcw, Search, ShieldCheck,
} from 'lucide-react';
import api, { apiErrorMessage, API_BASE } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import StatusBanner from '../components/StatusBanner';
import { paymentMethodLabel } from '../paymentMethods';
import { EMPTY_VALUE } from '../emptyValue';

/*
 * Receipts & verification: the administrative side of the QR code printed on
 * every offering receipt.
 *
 * The page answers the questions a receipt raises after it has been handed over:
 * is this one still valid? who invalidated it, and why? what does the transaction
 * record actually say? Printing and reprinting live here too, because a
 * reprint is the commonest reason to open this screen, and a reprint keeps the
 * SAME verification identity (see POST /offerings/:id/verification/regenerate on
 * the server), so the copy a member already holds keeps working.
 *
 * The daily audit-chain panel at the bottom is deliberately a separate section
 * with its own button: it verifies a DAY's tamper-evident log, not a receipt, and
 * it is the church's own check rather than anything a member scans. Keeping the
 * two visibly apart is the point: they answer different questions about
 * different things.
 */

function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// The receipt document is rendered by the server (see utils/receipt.js), so
// printing/PDF is a link rather than a client render. The session token rides in
// the query string because opening a link in a new tab drops the Authorization
// header: the same trick the front desk's receipt buttons use.
function receiptUrlFor(row, ext) {
  const token = localStorage.getItem('vrt_token');
  return `${API_BASE}/offerings/${row.id}/receipt${ext}?token=${encodeURIComponent(token)}${ext ? '&dl=1' : ''}`;
}

/*
 * The receipt's state as a reader needs to see it. A voided offering is shown as
 * voided rather than merely "revoked", because the two mean different things to
 * an admin: voiding is a correction to the ledger, revoking is a decision about
 * the paper. (The server reports both as "revoked" to the public, see
 * utils/receiptVerification.js, but here the cause matters.)
 */
function statusOf(row) {
  if (row.voided_at) return 'voided';
  if (row.verification_status === 'revoked') return 'revoked';
  return 'active';
}

const STATUS_STYLE = {
  active: 'border-people-300 bg-people-50 text-people-700',
  revoked: 'border-danger-300 bg-danger-50 text-danger-700',
  voided: 'border-ink-200 bg-ink-100 text-ink-600',
};

// Audit actions are a closed set on the server (routes/offerings.js): each one
// gets a label rather than the raw column value.
const AUDIT_LABELS = {
  offering_recorded: 'auditOfferingRecorded',
  offering_voided: 'auditOfferingVoided',
  offering_adjusted: 'auditOfferingAdjusted',
  receipt_verification_issued: 'auditVerificationIssued',
  receipt_verification_revoked: 'auditVerificationRevoked',
  receipt_verification_restored: 'auditVerificationRestored',
};

function auditLabel(t, action) {
  const key = AUDIT_LABELS[action];
  return key ? t(`receipts.${key}`) : action;
}

function moneyFor(total, currency) {
  try {
    return new Intl.NumberFormat('en-TZ', { style: 'currency', currency, maximumFractionDigits: 0 }).format(total);
  } catch {
    return `${total} ${currency}`;
  }
}

export default function Receipts() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(() => daysAgoISO(30));
  const [to, setTo] = useState(todayISO);
  const [includeVoided, setIncludeVoided] = useState(false);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  // `loaded` rather than a `loading` flag flipped at the top of the fetch: the
  // effect below must not set state synchronously (it would schedule a second
  // render before the request is even sent), so "we have an answer" is derived
  // from the response itself.
  const [loaded, setLoaded] = useState(false);
  const [banner, setBanner] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [history, setHistory] = useState({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [auditDate, setAuditDate] = useState(todayISO);
  const [auditResult, setAuditResult] = useState(null);
  const [auditError, setAuditError] = useState('');

  const load = useCallback(() => {
    if (!from || !to || from > to) return undefined;
    return api
      .get('/offerings', { params: { from, to, includeVoided: includeVoided ? 1 : undefined } })
      .then(({ data }) => {
        setBanner(null);
        // Only receipted gifts: this screen manages receipts, and an offering
        // recorded without one has no verification identity to manage.
        setRows((data.offerings || []).filter((o) => o.receipt_number));
      })
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }))
      .finally(() => setLoaded(true));
  }, [from, to, includeVoided]);

  useEffect(() => { load(); }, [load]);

  // Whatever a receipt's state just became is what the table shows, so the
  // action rebuilds the row from the server's own derived status rather than
  // guessing it locally.
  function applyReceiptPatch(id, patch) {
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function revoke(row) {
    setBusyId(row.id);
    setBanner(null);
    try {
      const { data } = await api.patch(`/offerings/${row.id}/verification/revoke`, { reason: revokeReason.trim() || undefined });
      applyReceiptPatch(row.id, {
        verification_status: data.status,
        verification_revocation_reason: data.reason ?? null,
        verification_revoked_at: data.revokedAt ?? null,
      });
      setPendingRevokeId(null);
      setRevokeReason('');
      setBanner({ type: 'success', message: t('receipts.revokedBanner', { receipt: row.receipt_number }) });
      // The revocation is in this receipt's history now; re-read it if it is open.
      if (openId === row.id) loadHistory(row.id);
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function restore(row) {
    setBusyId(row.id);
    setBanner(null);
    try {
      const { data } = await api.patch(`/offerings/${row.id}/verification/restore`);
      applyReceiptPatch(row.id, { verification_status: data.status, verification_revoked_at: null, verification_revocation_reason: null });
      setBanner({ type: 'success', message: t('receipts.restoredBanner', { receipt: row.receipt_number }) });
      if (openId === row.id) loadHistory(row.id);
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Issues the verification code for a receipt that has none: a record created
   * before QR verification existed and missed by the boot backfill. It never
   * replaces a code a receipt already has: a new credential would invalidate
   * every copy of that receipt already handed out (the server enforces the same
   * rule: POST /offerings/:id/verification/regenerate returns the existing one).
   */
  async function issueCode(row) {
    setBusyId(row.id);
    setBanner(null);
    try {
      const { data } = await api.post(`/offerings/${row.id}/verification/regenerate`);
      applyReceiptPatch(row.id, {
        verification_token: data.verificationToken,
        verification_url: data.verificationUrl,
        verification_status: data.status,
      });
      setBanner({ type: 'success', message: t('receipts.codeIssuedBanner', { receipt: row.receipt_number }) });
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function copyLink(row) {
    if (!row.verification_url) return;
    try {
      await navigator.clipboard.writeText(row.verification_url);
      setBanner({ type: 'success', message: t('receipts.linkCopied') });
    } catch {
      // A browser that blocks the clipboard still gets the value to copy by hand.
      setBanner({ type: 'info', message: row.verification_url });
    }
  }

  function loadHistory(id) {
    setHistoryLoading(true);
    api
      .get(`/offerings/${id}/audit`)
      .then(({ data }) => setHistory((h) => ({ ...h, [id]: data.entries || [] })))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }))
      .finally(() => setHistoryLoading(false));
  }

  function toggleDetails(row) {
    if (openId === row.id) {
      setOpenId(null);
      return;
    }
    setOpenId(row.id);
    setPendingRevokeId(null);
    if (!history[row.id]) loadHistory(row.id);
  }

  async function verifyDay(e) {
    e.preventDefault();
    setAuditError('');
    setAuditResult(null);
    try {
      const { data } = await api.get('/reports/audit/verify', { params: { date: auditDate } });
      setAuditResult(data);
    } catch (err) {
      setAuditError(apiErrorMessage(err));
    }
  }

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    // The payment reference is searchable on purpose: the commonest reason to
    // look a receipt up by hand is a member holding a mobile-money confirmation
    // code, which is not the receipt number and not in any other column here.
    return rows.filter((r) =>
      [r.receipt_number, r.offererName, r.category_name, r.category_key, r.service_name, r.payment_reference]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    );
  }, [rows, search]);

  function detailsPanel(row) {
    const entries = history[row.id];
    const status = statusOf(row);
    return (
      <div className="space-y-3 py-1">
        <div className="flex flex-wrap items-center gap-2">
          <a href={receiptUrlFor(row, '')} target="_blank" rel="noreferrer" className="btn btn-secondary px-3 py-1.5 text-xs">
            <Printer size={13} /> {t('receipts.print')}
          </a>
          <a href={receiptUrlFor(row, '.pdf')} target="_blank" rel="noreferrer" className="btn btn-secondary px-3 py-1.5 text-xs">
            <FileText size={13} /> {t('receipts.downloadPdf')}
          </a>
          {row.verification_url ? (
            <button type="button" onClick={() => copyLink(row)} className="btn btn-secondary px-3 py-1.5 text-xs">
              <Copy size={13} /> {t('receipts.copyLink')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => issueCode(row)}
              disabled={busyId === row.id}
              className="btn btn-secondary px-3 py-1.5 text-xs"
            >
              <QrCode size={13} /> {t('receipts.generateCode')}
            </button>
          )}
          {status === 'active' && pendingRevokeId !== row.id && (
            <button type="button" onClick={() => setPendingRevokeId(row.id)} className="btn btn-secondary px-3 py-1.5 text-xs">
              <Ban size={13} /> {t('receipts.revoke')}
            </button>
          )}
          {status === 'revoked' && (
            <button
              type="button"
              onClick={() => restore(row)}
              disabled={busyId === row.id}
              className="btn btn-secondary px-3 py-1.5 text-xs"
            >
              <RotateCcw size={13} /> {t('receipts.restore')}
            </button>
          )}
          {status === 'voided' && (
            <span className="text-xs text-ink-500">{t('receipts.voidedNote')}</span>
          )}
        </div>

        {row.verification_url ? (
          <p className="break-all font-mono text-xs text-ink-500">{row.verification_url}</p>
        ) : (
          <p className="text-xs text-ink-500">{t('receipts.noCodeNote')}</p>
        )}

        {/* How the gift was paid, as the receipt and the member's verification
            page both report it: the receipt is what an admin is really reading
            this panel for. Older receipts have neither, and say so rather than
            showing an empty field. */}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-600">
          <span>
            {t('receipts.paymentMethod')}:{' '}
            <span className="font-medium text-ink-800">
              {row.payment_method ? paymentMethodLabel(t, row.payment_method) : t('receipts.notRecorded')}
            </span>
          </span>
          <span>
            {t('receipts.paymentReference')}:{' '}
            <span className="font-mono font-medium text-ink-800">{row.payment_reference || t('receipts.notRecorded')}</span>
          </span>
        </p>

        {pendingRevokeId === row.id && (
          <div className="rounded-lg border border-ink-200 bg-paper p-3">
            <p className="text-xs font-medium text-ink-800">{t('receipts.revokeConfirm', { receipt: row.receipt_number })}</p>
            <p className="mt-1 text-xs text-ink-500">{t('receipts.revokeNote')}</p>
            <input
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder={t('receipts.revokeReasonPlaceholder')}
              aria-label={t('receipts.revokeReason')}
              className="mt-2 w-full rounded-md border border-ink-200 px-3 py-1.5 text-xs focus-visible:border-brand-600"
            />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => revoke(row)} disabled={busyId === row.id} className="btn btn-danger px-3 py-1.5 text-xs">
                {busyId === row.id ? t('common.saving') : t('receipts.revokeYes')}
              </button>
              <button
                type="button"
                onClick={() => { setPendingRevokeId(null); setRevokeReason(''); }}
                disabled={busyId === row.id}
                className="btn btn-secondary px-3 py-1.5 text-xs"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-ink-100 bg-paper p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
            <History size={13} /> {t('receipts.history')}
          </p>
          {historyLoading && !entries ? (
            <p className="text-xs text-ink-400">{t('common.loading')}</p>
          ) : !entries || entries.length === 0 ? (
            <p className="text-xs text-ink-400">{t('receipts.historyEmpty')}</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry) => (
                <li key={entry.id} className="border-b border-ink-100 pb-2 text-xs last:border-0 last:pb-0">
                  <p className="font-medium text-ink-800">{auditLabel(t, entry.action)}</p>
                  <p className="text-ink-500">
                    {entry.timestamp}
                    {entry.recordedBy ? ` · ${t('receipts.historyBy', { name: entry.recordedBy })}` : ''}
                  </p>
                  {entry.details?.reason && <p className="text-ink-600">{t('receipts.historyReason', { reason: entry.details.reason })}</p>}
                  {entry.details?.amount !== undefined && (
                    <p className="text-ink-600">{t('receipts.historyAmount', { amount: entry.details.amount, currency: entry.details.currency || 'TZS' })}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const columns = [
    {
      key: 'receipt',
      header: t('receipts.colReceipt'),
      render: (r) => (
        <span className="font-mono text-xs font-medium text-ink-900">{r.receipt_number}</span>
      ),
    },
    { key: 'date', header: t('receipts.colDate'), width: 13, render: (r) => <span className="text-ink-600">{r.service_date}</span> },
    { key: 'giver', header: t('receipts.colGiver'), width: 18, render: (r) => <span className="text-ink-600">{r.offererName || t('common.anonymous')}</span> },
    { key: 'category', header: t('receipts.colCategory'), width: 16, render: (r) => <span className="text-ink-600">{r.category_name || r.category_key || EMPTY_VALUE}</span> },
    {
      key: 'amount',
      header: t('receipts.colAmount'),
      width: 14,
      align: 'right',
      cardValue: true,
      render: (r) => <span className="tabular-nums text-ink-900">{moneyFor(r.amount, r.currency)}</span>,
    },
    {
      key: 'status',
      header: t('receipts.colStatus'),
      width: 16,
      render: (r) => {
        const status = statusOf(r);
        // Spelled out rather than keyed dynamically, so every label a reader can
        // see is a literal the catalog sweep checks.
        const label = status === 'active'
          ? t('receipts.status_active')
          : status === 'revoked'
            ? t('receipts.status_revoked')
            : t('receipts.status_voided');
        return (
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
            {status === 'active' ? <ShieldCheck size={12} /> : <Ban size={12} />}
            {label}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      width: 10,
      align: 'right',
      render: (r) => (
        <button
          type="button"
          onClick={() => toggleDetails(r)}
          aria-expanded={openId === r.id}
          className="inline-flex items-center gap-1 rounded-md border border-ink-200 px-2 py-1 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800"
        >
          {openId === r.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t('receipts.details')}
        </button>
      ),
    },
  ];

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-semibold">{t('receipts.title')}</h1>
      <p className="mb-5 max-w-3xl text-sm text-ink-500">{t('receipts.intro')}</p>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">{t('receipts.filtersFrom')}</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">{t('receipts.filtersTo')}</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-700">
            <input type="checkbox" checked={includeVoided} onChange={(e) => setIncludeVoided(e.target.checked)} />
            {t('receipts.filtersIncludeVoided')}
          </label>
          <label className="min-w-[12rem] flex-1 text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">{t('receipts.filtersSearch')}</span>
            <span className="relative block">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden="true" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('receipts.searchPlaceholder')}
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
            rows={visible}
            keyOf={(r) => r.id}
            expandedRow={(r) => (openId === r.id ? detailsPanel(r) : null)}
            empty={<p className="py-6 text-center text-sm text-ink-400">{t('receipts.empty')}</p>}
          />
        )}
      </section>

      {/* The church's own audit check: a day, not a receipt. */}
      <section className="mt-6 rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
        <h2 className="mb-1 flex items-center gap-1.5 font-display text-lg font-semibold">
          <ShieldCheck size={16} className="text-ink-600" /> {t('receipts.dailyTitle')}
        </h2>
        <p className="mb-4 max-w-3xl text-sm text-ink-500">{t('receipts.dailyHint')}</p>
        <form onSubmit={verifyDay} className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-400">{t('receipts.dailyDate')}</span>
            <input type="date" value={auditDate} onChange={(e) => setAuditDate(e.target.value)} required className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
          </label>
          <button type="submit" className="btn btn-primary">{t('receipts.dailyVerify')}</button>
        </form>

        {auditError && <div className="mt-4"><StatusBanner type="error" message={auditError} /></div>}

        {auditResult && !auditError && (
          <div className="mt-4 space-y-3">
            <StatusBanner
              type={auditResult.valid ? 'success' : 'error'}
              message={
                auditResult.entries === 0
                  ? t('receipts.dailyEmpty')
                  : auditResult.valid
                    ? t('receipts.dailyValid', { entries: auditResult.entries })
                    : t('receipts.dailyBroken', { id: auditResult.brokenAtId })
              }
            />
            {auditResult.entries > 0 && !auditResult.linkedToNext && (
              <StatusBanner type="error" message={t('receipts.dailyNotLinked')} />
            )}
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-ink-100 p-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{t('receipts.dailyEntries')}</dt>
                <dd className="text-lg font-semibold tabular-nums text-ink-900">{auditResult.entries}</dd>
              </div>
              <div className="rounded-lg border border-ink-100 p-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{t('receipts.dailyOfferings')}</dt>
                <dd className="text-sm text-ink-800">
                  {auditResult.offerings.byCurrency.length === 0
                    ? EMPTY_VALUE
                    : auditResult.offerings.byCurrency
                        .map((g) => `${moneyFor(g.total, g.currency)} (${g.count})`)
                        .join(' · ')}
                </dd>
              </div>
              <div className="rounded-lg border border-ink-100 p-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{t('receipts.dailyVoided')}</dt>
                <dd className="text-lg font-semibold tabular-nums text-ink-900">{auditResult.offerings.voided}</dd>
              </div>
            </dl>
          </div>
        )}
      </section>
    </AppShell>
  );
}
