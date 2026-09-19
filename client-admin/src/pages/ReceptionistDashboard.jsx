import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, ChevronDown, ChevronRight, CalendarDays, MapPin, HandCoins, Printer, FileDown, Send, CheckCircle2, Clock, Pencil, X } from 'lucide-react';
import api, { apiErrorMessage, API_BASE } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import PrintMasthead from '../components/PrintMasthead';
import GroupLogo from '../components/GroupLogo';
import StatusBanner from '../components/StatusBanner';
import MemberPicker from '../components/MemberPicker';
import { useAuth } from '../context/AuthContext';
import { formatDate } from '../format';
import { PAYMENT_METHODS, PAYMENT_REFERENCE_MAX, methodHasReference, paymentMethodLabel } from '../paymentMethods';

const CATEGORY_TONES = { zaka: 'category-offering', general: 'category-offering', thanksgiving: 'category-offering-deep', special: 'category-offering-deep' };

/*
 * What to print in a giver column.
 *
 * Three cases, kept apart on purpose (see server/utils/donorFields.js): a named
 * gift shows the name; a gift that genuinely has none shows "Anonymous"; a name
 * the server could not decrypt is flagged in the warning tone, because showing
 * it as anonymous would quietly hide donor data loss.
 */
function giverText(o, t) {
  if (o.offererName) return { text: o.offererName, warn: false };
  if (o.offererNameUnavailable) return { text: t('common.nameUnavailable'), warn: true };
  return { text: t('common.anonymous'), warn: false };
}

function GiverName({ o, t }) {
  const { text, warn } = giverText(o, t);
  if (warn) return <span className="font-medium text-amber-700">{text}</span>;
  return <span>{text}</span>;
}

// Print/PDF act on the receipt in a new tab and are icon-only, so each gets a
// 40x40 target (Fitts's Law: a 12px glyph is not a tap target) plus a title so
// the function is never icon-guesswork on a phone.
const RECEIPT_LINK = 'no-print inline-flex h-10 w-10 items-center justify-center rounded-md';

function ReceiptLinks({ o, t, tone }) {
  return (
    <span className="inline-flex items-center gap-1">
      <a
        href={receiptUrlFor(o, '')}
        target="_blank"
        rel="noreferrer"
        title={t('receptionist.printReceipt')}
        aria-label={t('receptionist.printReceipt')}
        className={`${RECEIPT_LINK} ${tone}`}
      >
        <Printer size={16} />
      </a>
      <a
        href={receiptUrlFor(o, '.pdf')}
        target="_blank"
        rel="noreferrer"
        title={t('receptionist.downloadPdf')}
        aria-label={t('receptionist.downloadPdf')}
        className={`${RECEIPT_LINK} ${tone}`}
      >
        <FileDown size={16} />
      </a>
    </span>
  );
}

// Receipt links carry the token in the query string because a new tab drops the
// Authorization header (the API accepts ?token= on these two routes only).
function receiptUrlFor(o, ext) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('vrt_token') : '';
  return `${API_BASE}/offerings/${o.id}/receipt${ext}?token=${encodeURIComponent(token)}${ext ? '&dl=1' : ''}`;
}

export default function ReceptionistDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [serverDate, setServerDate] = useState('');
  const [types, setTypes] = useState([]);
  const [groups, setGroups] = useState([]);
  const [centers, setCenters] = useState([]);
  const [categories, setCategories] = useState([]);
  const [projects, setProjects] = useState([]);
  const [entries, setEntries] = useState([]);
  const [offerings, setOfferings] = useState([]);
  const [banner, setBanner] = useState(null);
  const [loadError, setLoadError] = useState('');

  // attendance form
  const [serviceTypeId, setServiceTypeId] = useState('');
  const [subSessionId, setSubSessionId] = useState('');
  const [attendees, setAttendees] = useState([]);
  const [count, setCount] = useState('');
  const [groupId, setGroupId] = useState('');
  const [centerId, setCenterId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // offering form
  const [offType, setOffType] = useState('');
  const [offServiceTypeId, setOffServiceTypeId] = useState('');
  const [giver, setGiver] = useState([]);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('TZS');
  // How the gift was paid, and the number that came with it. Deliberately NOT
  // defaulted to cash: the method is printed on the receipt a donor takes home,
  // so it is one explicit tap at the desk rather than a guess the church later
  // reports on (see server/utils/payments.js).
  const [projectName, setProjectName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [offSubmitting, setOffSubmitting] = useState(false);
  const [summarySending, setSummarySending] = useState(false);
  const [summaryResult, setSummaryResult] = useState(null);
  const [openRow, setOpenRow] = useState(null);
  const [editId, setEditId] = useState(null);
  // The row the desk just created, tinted for a moment in the list it landed in
  // (see DataTable's flashIds): the id comes back from the write itself, so it
  // is that record being pointed at and not whatever else arrived at the same
  // time. Held until the next write: a refresh re-renders the same key, and a
  // keyframes animation does not replay for a row that is already on screen.
  const [flashId, setFlashId] = useState(null);


  const batchPending =
    entries.some((e) => !e.notified_at) || offerings.some((o) => !o.notified_at);

  const pendingEntries = entries.filter((e) => !e.notified_at);
  const pendingOfferings = offerings.filter((o) => !o.notified_at);

  /**
   * Re-reads every list the front desk picks from. These are all administrable
   * (service types especially), so they are treated as live state rather than as
   * something fetched once at sign-in: a service type renamed, added or disabled
   * in the Service Types screen must be what this screen shows next: no reload,
   * no redeploy, no cache clearing (the API also answers with no-store, so a
   * cached list can never be served either).
   *
   * A selection that no longer exists is cleared rather than left dangling: if
   * the type the receptionist had chosen is deactivated while this screen is
   * open, the picker must not keep pointing at it: recording attendance against
   * a retired service type is exactly the mistake this prevents.
   */
  const refreshReferenceData = useCallback(async () => {
    const [st, g, rc, cats, projs] = await Promise.all([
      api.get('/service-types').then(({ data }) => data.serviceTypes.filter((x) => x.is_active)).catch((err) => { setLoadError(apiErrorMessage(err)); return null; }),
      api.get('/groups').then(({ data }) => data.groups).catch(() => null),
      api.get('/revival-centers').then(({ data }) => data.revivalCenters).catch(() => null),
      api.get('/offerings/categories').then(({ data }) => data.categories).catch(() => null),
      api.get('/projects').then(({ data }) => data.projects.filter((p) => p.status === 'active')).catch(() => null),
    ]);
    if (g) setGroups(g);
    if (rc) setCenters(rc);
    if (cats) setCategories(cats);
    if (projs) setProjects(projs);
    if (!st) return;
    setTypes(st);
    const servicesOnly = st.filter((x) => x.kind !== 'rehearsal');
    setServiceTypeId((prev) => (prev && !st.some((x) => String(x.id) === String(prev)) ? '' : prev));
    // Sub-session ids are unique across types, so it is enough that the chosen
    // one still exists and is active: checked against the fresh list directly
    // rather than against the type it was chosen under.
    setSubSessionId((prev) =>
      prev && st.some((x) => (x.subSessions || []).some((s) => s.is_active && String(s.id) === String(prev))) ? prev : ''
    );
    setOffServiceTypeId((prev) =>
      prev && servicesOnly.some((x) => String(x.id) === String(prev)) ? prev : String(servicesOnly[0]?.id ?? '')
    );
  }, []);

  useEffect(() => {
    // The day's date, every pickable list, and today's entries: loaded once when
    // the desk is opened, then kept fresh by the focus handler below.
    function loadDesk() {
      api.get('/time').then(({ data }) => setServerDate(data.date)).catch(() => {});
      refreshReferenceData();
      loadToday();
    }
    loadDesk();
  }, [refreshReferenceData]);

  // Coming back to the tab re-reads those lists: the desk sits open all day (a
  // second monitor at the front desk), and an admin changing a service type in
  // another tab or on another machine has to be reflected the moment the desk is
  // looked at again.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') refreshReferenceData();
    }
    function onFocus() {
      refreshReferenceData();
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshReferenceData]);

  function loadToday() {
    api.get('/attendance').then(({ data }) => setEntries(data.attendance)).catch(() => {});
    api.get('/offerings').then(({ data }) => setOfferings(data.offerings)).catch(() => {});
  }

  const selectedType = useMemo(() => types.find((x) => x.id === Number(serviceTypeId)), [types, serviceTypeId]);
  const activeSubSessions = useMemo(() => (selectedType?.subSessions || []).filter((s) => s.is_active), [selectedType]);
  const selectedCenter = useMemo(() => centers.find((c) => c.id === Number(centerId)), [centers, centerId]);
  const isNamed = selectedType?.attendance_mode === 'named';
  const supportsNamed = selectedType?.attendance_mode === 'named' || selectedType?.attendance_mode === 'both';
  // Rehearsals are practice sessions, not services: they record attendance only
  // (a headcount plus names, handwritten or recalled from the member list) and
  // are kept apart from services everywhere, including in this picker.
  const isRehearsal = selectedType?.kind === 'rehearsal';
  const serviceKinds = useMemo(() => types.filter((x) => x.kind !== 'rehearsal'), [types]);
  const rehearsalKinds = useMemo(() => types.filter((x) => x.kind === 'rehearsal'), [types]);

  const selectedProject = useMemo(() => projects.find((p) => String(p.id) === String(projectId)), [projects, projectId]);
  const selectedOffCat = categories.find((c) => c.key === offType);
  const needsGiver = selectedOffCat?.requires_receipt === 1 || ['zaka', 'thanksgiving'].includes(offType);

  function handleTypeChange(id) {
    setServiceTypeId(id);
    setSubSessionId('');
    setAttendees([]);
    setCount('');
  }

  async function handleAttendanceSubmit(e) {
    e.preventDefault();
    setBanner(null);
    setSubmitting(true);
    try {
      const body = {
        serviceTypeId: Number(serviceTypeId),
        date: serverDate,
        subSessionId: subSessionId ? Number(subSessionId) : undefined,
        groupId: groupId ? Number(groupId) : undefined,
        centerId: centerId ? Number(centerId) : undefined,
        zoneId: zoneId ? Number(zoneId) : undefined,
        attendees: attendees.map((a) => ({ memberId: a.memberId ?? undefined, name: a.name })),
        count: count !== '' ? Number(count) : undefined,
      };
      const { data } = editId
        ? await api.put(`/attendance/${editId}`, {
            attendees: attendees.map((a) => ({ memberId: a.memberId ?? undefined, name: a.name })),
            count: count !== '' ? Number(count) : undefined,
            groupId: groupId ? Number(groupId) : undefined,
            centerId: centerId ? Number(centerId) : undefined,
            zoneId: zoneId ? Number(zoneId) : undefined,
          })
        : await api.post('/attendance', body);
      setBanner({
        type: 'success',
        message: editId
          ? t('receptionist.updateSaved')
          : isNamed || attendees.length ? `${data.count} ${t('receptionist.namedSaved')}` : t('receptionist.recordedSuccess'),
      });
      if (editId) {
        cancelEdit();
      } else if (data?.id) {
        setFlashId(data.id);
      } else {
        setAttendees([]);
        setCount('');
        setGroupId('');
        setCenterId('');
        setZoneId('');
      }
      loadToday();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(r) {
    setEditId(r.id);
    setServiceTypeId(String(r.service_type_id));
    setSubSessionId(r.sub_session_id ? String(r.sub_session_id) : '');
    setAttendees((r.attendees || []).map((n) => ({ name: n })));
    setCount(r.mode === 'headcount' && r.total != null ? String(r.total) : '');
    setGroupId(r.group_id ? String(r.group_id) : '');
    setCenterId(r.revival_center_id ? String(r.revival_center_id) : '');
    setZoneId(r.zone_id ? String(r.zone_id) : '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    setEditId(null);
    setAttendees([]);
    setCount('');
    setGroupId('');
    setCenterId('');
    setZoneId('');
  }

  async function handleOfferingSubmit(e) {
    e.preventDefault();
    setBanner(null);
    setOffSubmitting(true);
    try {
      const body = {
        serviceTypeId: Number(offServiceTypeId),
        date: serverDate,
        category: offType,
        amount: Number(amount),
        currency,
        paymentMethod,
        paymentReference: methodHasReference(paymentMethod) ? (paymentReference.trim() || undefined) : undefined,
        offererName: giver[0]?.name,
        memberId: giver[0]?.memberId ?? undefined,
        projectId: projectId && projectId !== 'other' ? Number(projectId) : undefined,
        projectName: projectName || undefined,
        reason: reason || undefined,
        notes: notes || undefined,
      };
      const { data } = await api.post('/offerings', body);
      if (data?.id) setFlashId(data.id);
      setBanner({
        type: 'success',
        message: `${data.receiptNumber ? `${t('receptionist.receiptIssued')} ${data.receiptNumber}. ` : ''}${t('receptionist.recordedSuccess')}`,
      });
      setAmount('');
      // The method stays selected (like the category chip) for a run of gifts
      // paid the same way, but the reference never does: it belongs to the gift
      // that was just recorded, and re-sending it would put one confirmation
      // code on two receipts.
      setPaymentReference('');
      setGiver([]);
      setProjectName('');
      setReason('');
      setNotes('');
      loadToday();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setOffSubmitting(false);
    }
  }

  async function handleSendSummary() {
    setBanner(null);
    setSummarySending(true);
    try {
      const { data } = await api.post('/notifications/send-summary');
      setSummaryResult(data);
      if (data.sent) setBanner({ type: 'success', message: t('receptionist.summarySent') });
      else setBanner({ type: 'info', message: t('receptionist.summaryEmpty') });
      loadToday();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSummarySending(false);
    }
  }

  function formatServerDate(d) { return formatDate(d, user?.language_pref); }

  const grouped = useMemo(() => {
    const g = {};
    for (const e of entries) (g[e.service_type_name] = g[e.service_type_name] || []).push(e);
    return Object.entries(g);
  }, [entries]);

  const entriesTotal = entries.reduce((s, e) => s + (e.total || 0), 0);
  const offeringsTotal = useMemo(() => {
    const map = new Map();
    for (const o of offerings) {
      const c = o.currency || 'TZS';
      map.set(c, (map.get(c) || 0) + (Number(o.amount) || 0));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [offerings]);

  return (
    <AppShell>
      {/* The printed sheet opens with the church letterhead: name,
          address, the day, and the totals the tables add up to. Hidden
          on screen by .print-only; styled in the print block of
          index.css. */}
      <PrintMasthead
        date={serverDate}
        lang={user?.language_pref}
        people={entries.length}
        offeringsTotal={offeringsTotal}
        t={t}
      />
      <div className="mb-5 no-print flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="mb-1 font-display text-2xl font-semibold">{t('receptionist.title')}</h1>
          <p className="text-sm text-ink-400">{t('common.welcomeBack', { name: user?.name })}</p>
        </div>
        <div className="no-print flex items-center gap-3">
          {/* Ctrl+P already works, but discoverability wins: the print
              stylesheet in index.css makes the tables print as fixed,
              chrome-free day records. */}
          <button
            type="button"
            onClick={() => window.print()}
            className="btn btn-secondary"
          >
            <Printer size={15} /> {t('receptionist.printDayRecord')}
          </button>
          <div className="flex items-center gap-2 rounded-full bg-people-50 px-3 py-1.5 text-sm font-medium text-people-700">
            <CalendarDays size={15} /> {serverDate ? formatServerDate(serverDate) : t('common.loading')}
          </div>
        </div>
      </div>

      {banner && (
        <div className="mb-5 no-print">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}
      {loadError && !banner && (
        <div className="mb-5 no-print">
          <StatusBanner type="error" message={loadError} />
        </div>
      )}

      <div className="grid gap-4 day-grid lg:grid-cols-5">
        {/* Left column: attendance + offerings entry, the forms are
            how the record gets IN; only the record itself prints. */}
        <div className="space-y-4 no-print lg:col-span-2">
          {/* Attendance */}
          <section className="category-people tile border-l-4 border-l-people-600 p-5">
            <div className="mb-4 flex items-center gap-2">
              <Users size={18} className="text-people-600" />
              <h2 className="font-display text-lg font-semibold">{t('receptionist.attendanceTitle')}</h2>
            </div>
            <form onSubmit={handleAttendanceSubmit} className="space-y-4">
              {editId && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-people-300 bg-people-50 px-3 py-2 text-sm font-medium text-people-800">
                  <span className="flex items-center gap-1.5"><Pencil size={13} /> {t('receptionist.editingAttendance')}</span>
                  <button type="button" onClick={cancelEdit} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-people-800 hover:bg-people-100">
                    <X size={12} /> {t('receptionist.cancelEdit')}
                  </button>
                </div>
              )}
              <div>
                <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="svcType">{t('receptionist.chooseService')}</label>
                <select
                  id="svcType"
                  value={serviceTypeId}
                  onChange={(e) => handleTypeChange(e.target.value)}
                  disabled={!!editId}
                  required
                  className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600 disabled:bg-ink-50 disabled:text-ink-400"
                >
                  <option value="">{t('common.select')}</option>
                  {serviceKinds.length > 0 && (
                    <optgroup label={t('receptionist.servicesGroup')}>
                      {serviceKinds.map((x) => (
                        <option key={x.id} value={x.id}>{x.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {rehearsalKinds.length > 0 && (
                    <optgroup label={t('receptionist.rehearsalsGroup')}>
                      {rehearsalKinds.map((x) => (
                        <option key={x.id} value={x.id}>{x.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {isRehearsal && (
                <p className="rounded-md bg-people-50 px-3 py-2 text-sm text-people-800">
                  {t('receptionist.rehearsalAttendanceOnly')}
                </p>
              )}

              {activeSubSessions.length > 0 && (
                <div>
                  <span className="mb-1 block text-sm font-medium text-ink-700">{t('receptionist.subsession')}</span>
                  <div className="flex flex-wrap gap-2">
                    {activeSubSessions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSubSessionId(String(s.id))}
                        className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                          subSessionId === String(s.id) ? 'bg-people-600 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                        }`}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {supportsNamed && (
                <div>
                  <span className="mb-1 block text-sm font-medium text-ink-700">{t('receptionist.attendees')}</span>
                  <MemberPicker selected={attendees} onChange={setAttendees} />
                </div>
              )}

              {(selectedType?.attendance_mode === 'headcount' || selectedType?.attendance_mode === 'both') && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="attCount">{t('receptionist.attendanceCount')}</label>
                  <input
                    id="attCount"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={count}
                    onChange={(e) => setCount(e.target.value)}
                    placeholder={supportsNamed ? t('receptionist.countOptional') : ''}
                    className="w-full rounded-md border border-ink-200 px-4 py-4 text-2xl font-semibold focus-visible:border-brand-600"
                  />
                </div>
              )}

              <details className="rounded-lg border border-ink-100 bg-ink-50/50 p-3 text-sm">
                <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-ink-700">
                  <MapPin size={14} /> {t('receptionist.attachGroup')} <ChevronDown size={13} className="ml-1" />
                </summary>
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-400" htmlFor="attGroup">{t('receptionist.groupLabel')}</label>
                    {/* A native <option> cannot render an image, so the chosen
                        group's logo rides beside the select: same pattern as
                        the Members screen's pickers. */}
                    <span className="flex items-center gap-2">
                      {groupId && (() => {
                        const sel = groups.find((g) => String(g.id) === String(groupId));
                        return <GroupLogo groupId={groupId} name={sel?.name} has={sel?.has_logo} round size={22} />;
                      })()}
                      <select id="attGroup" value={groupId} onChange={(e) => setGroupId(e.target.value)} className="min-w-0 flex-1 rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600">
                        <option value="">{t('common.none')}</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-ink-400" htmlFor="attCenter">{t('receptionist.centerLabel')}</label>
                      <select id="attCenter" value={centerId} onChange={(e) => { setCenterId(e.target.value); setZoneId(''); }} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600">
                        <option value="">{t('common.none')}</option>
                        {centers.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-ink-400" htmlFor="attZone">{t('receptionist.zoneLabel')}</label>
                      <select id="attZone" value={zoneId} onChange={(e) => setZoneId(e.target.value)} disabled={!centerId} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600 disabled:bg-ink-50 disabled:text-ink-400">
                        <option value="">{t('common.none')}</option>
                        {(selectedCenter?.zones || []).map((z) => (
                          <option key={z.id} value={z.id}>{z.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </details>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={submitting || !serviceTypeId}
                  className="btn btn-people btn-lg w-full"
                >
                  {submitting ? t('common.saving') : editId ? t('receptionist.saveChanges') : t('receptionist.recordAttendance')}
                </button>
              </div>
            </form>
          </section>

          {/* Offerings */}
          <section className="category-offering tile border-l-4 border-l-offering-600 p-5">
            <div className="mb-4 flex items-center gap-2">
              <HandCoins size={18} className="text-offering-600" />
              <h2 className="font-display text-lg font-semibold">{t('receptionist.offeringsTitle')}</h2>
            </div>
            <form onSubmit={handleOfferingSubmit} className="space-y-4">
              <div>
                <span className="mb-1 block text-sm font-medium text-ink-700">{t('receptionist.offeringType')}</span>
                <div className="flex flex-wrap gap-2">
                  {categories.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => { setOffType(c.key); setGiver([]); }}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                        offType === c.key ? `${CATEGORY_TONES[c.key]} cat-chip !px-4 !py-2 !text-sm` : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 xs:grid-cols-3">
                <div className="xs:col-span-2">
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="offAmount">{t('receptionist.amount')}</label>
                  <input
                    id="offAmount"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-lg font-semibold focus-visible:border-brand-600"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="offCur">{t('receptionist.currency')}</label>
                  <select id="offCur" value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600">
                    <option value="TZS">TZS</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>

              {/* How the money came in. Asked before the giver and the project,
                  because it is about the payment itself, and it is required,
                  so every receipt can say how the gift was paid. */}
              <div>
                <span className="mb-1 block text-sm font-medium text-ink-700">{t('receptionist.paymentMethod')}</span>
                <div className="flex flex-wrap gap-2">
                  {PAYMENT_METHODS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => { setPaymentMethod(m); if (!methodHasReference(m)) setPaymentReference(''); }}
                      aria-pressed={paymentMethod === m}
                      className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                        paymentMethod === m ? 'bg-offering-600 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'
                      }`}
                    >
                      {paymentMethodLabel(t, m)}
                    </button>
                  ))}
                </div>
                {methodHasReference(paymentMethod) && (
                  <div className="mt-2">
                    <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="offPaymentRef">
                      {t('receptionist.paymentReference')}
                    </label>
                    <input
                      id="offPaymentRef"
                      value={paymentReference}
                      onChange={(e) => setPaymentReference(e.target.value)}
                      maxLength={PAYMENT_REFERENCE_MAX}
                      placeholder={t('receptionist.paymentReferencePlaceholder')}
                      className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="offSvc">{t('receptionist.chooseService')}</label>
                  <select id="offSvc" value={offServiceTypeId} onChange={(e) => setOffServiceTypeId(e.target.value)} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600">
                    {serviceKinds.map((x) => (
                      <option key={x.id} value={x.id}>{x.name}</option>
                    ))}
                  </select>
                </div>
                {needsGiver && (
                  <div className="col-span-2">
                    <label className="mb-1 block text-sm font-medium text-ink-700">{t('receptionist.offererName')}</label>
                    {/* One giver per offering, so this is a single select in the
                        offerings colour, not the multi-select attendee picker. */}
                    <MemberPicker
                      single
                      tone="offering"
                      selected={giver}
                      onChange={setGiver}
                      placeholder={t('receptionist.giverPlaceholder')}
                      freetextKey="receptionist.giverFreetext"
                    />
                  </div>
                )}
                {offType === 'special' && (
                  <div className="col-span-2">
                    <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="offProject">{t('receptionist.projectName')}</label>
                    {/* Filing against a project record is what puts the gift on
                        that project's page; free text stays available for a gift
                        that doesn't belong to one (and for a church with none). */}
                    {projects.length > 0 ? (
                      <select
                        id="offProject"
                        value={projectId}
                        onChange={(e) => setProjectId(e.target.value)}
                        className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600"
                      >
                        <option value="">{t('common.none')}</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                        <option value="other">{t('projects.projectOther')}</option>
                      </select>
                    ) : null}
                    {(projects.length === 0 || projectId === 'other') && (
                      <input
                        id="offProject"
                        value={projectName}
                        onChange={(e) => setProjectName(e.target.value)}
                        className="mt-2 w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600"
                      />
                    )}
                    {selectedProject && (
                      <p className="mt-1.5 text-xs text-ink-500">
                        {t('receptionist.projectProgress', {
                          raised: Number(selectedProject.raised).toLocaleString(),
                          currency: selectedProject.currency,
                          pct: selectedProject.fundedPct === null ? t('projects.noGoal') : `${selectedProject.fundedPct}%`,
                        })}
                      </p>
                    )}
                  </div>
                )}
                {offType === 'thanksgiving' && (
                  <div className="col-span-2">
                    <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="offReason">{t('receptionist.reason')}</label>
                    <input id="offReason" value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
                  </div>
                )}
                {offType === 'special' && (
                  <div className="col-span-2">
                    <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="offNotes">{t('receptionist.notes')}</label>
                    <input id="offNotes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={offSubmitting || !offType || !amount || !paymentMethod}
                className="btn btn-offering btn-lg w-full"
              >
                {offSubmitting ? t('common.saving') : t('receptionist.recordOffering')}
              </button>
            </form>
          </section>
        </div>

        {/* Right column: today's entries, the wider half, because the
            five-column offerings table lives here and a table the app
            guarantees will not scroll needs the room (3/2 the other way
            squeezed it to a third of the grid). */}
        <div className="space-y-4 lg:col-span-3">
          {/* Send summary */}
          <section className="tile p-4 sm:p-5 no-print">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="flex items-center gap-1.5 font-display text-lg font-semibold"><Users size={16} className="text-people-600" /> {t('receptionist.todayEntries')}</h2>
              <span className="text-sm font-semibold text-people-700">{entriesTotal.toLocaleString()} {t('receptionist.people')}</span>
            </div>
            {summaryResult?.sent ? (
              <div className="mb-3 rounded-lg border border-people-200 bg-people-50 p-3 text-sm text-people-800">
                <CheckCircle2 className="mb-1 inline h-4 w-4 align-middle text-people-700" /> {t('receptionist.summaryDone', { att: summaryResult.attendanceCount, off: summaryResult.offeringsCount })}
                <p className="mt-1 text-xs text-people-700/80">{summaryResult.people} {t('receptionist.people')} · {Number(summaryResult.total).toLocaleString()} {summaryResult.currency || 'TZS'}</p>
              </div>
            ) : batchPending ? (
              <div className="mb-3 space-y-3">
                {pendingEntries.length > 0 && (
                  <div className="rounded-lg border border-ink-100 bg-ink-50/50 p-3 text-sm">
                    <p className="mb-1 font-medium text-ink-700"><Clock size={13} className="mr-1 inline text-people-600" /> {pendingEntries.length} {pendingEntries.length === 1 ? 'session' : 'sessions'} {t('receptionist.pending')}</p>
                    <ul className="space-y-1">
                      {pendingEntries.map((e) => (
                        <li key={e.id} className="flex items-center justify-between gap-2 text-xs text-ink-600">
                          <span>{e.sub_session_name ? `${e.service_type_name} · ${e.sub_session_name}` : e.service_type_name}</span>
                          <span className="shrink-0 whitespace-nowrap font-medium tabular-nums text-people-700">{(e.total || 0).toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {pendingOfferings.length > 0 && (
                  <div className="rounded-lg border border-ink-100 bg-ink-50/50 p-3 text-sm">
                    <p className="mb-1 font-medium text-ink-700"><Clock size={13} className="mr-1 inline text-offering-600" /> {pendingOfferings.length} {pendingOfferings.length === 1 ? 'offering' : 'offerings'} {t('receptionist.pending')}</p>
                    <ul className="space-y-1">
                      {pendingOfferings.map((o) => (
                        <li key={o.id} className="flex items-center justify-between gap-2 text-xs text-ink-600">
                          <span>{o.category_name}</span>
                          <span className="shrink-0 whitespace-nowrap font-medium tabular-nums text-offering-700">{Number(o.amount).toLocaleString()} {o.currency}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleSendSummary}
                  disabled={summarySending}
                  className="btn btn-secondary w-full"
                >
                  <Send size={15} /> {summarySending ? t('common.sending') : t('receptionist.sendSummary')}
                </button>
              </div>
            ) : null}
          </section>

          {/* Today's attendance table */}
          <section className="tile p-5">
            <h3 className="mb-3 font-display text-base font-semibold">{t('receptionist.attendanceTitle')}</h3>
            {grouped.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-400">{t('common.empty')}</p>
            ) : (
              // The one shared table pattern (components/DataTable): fixed
              // percentage columns that cannot drift under their headers, a
              // sticky header, identical row spacing, and below `sm`, the same
              // data reflowed as cards rather than a horizontal scrollbar.
              // The named-count control sits in the SAME slot every row uses
              // for its value, so a named-attendance row differs from a
              // headcount row only in its data, never in row anatomy.
              <DataTable
                columns={[
                  {
                    key: 'session',
                    header: t('receptionist.colSession'),
                    render: (r) => (
                      <span className="font-medium text-ink-900">
                        {r.service_type_name}
                        {r.sub_session_name && <span className="text-ink-400"> · {r.sub_session_name}</span>}
                      </span>
                    ),
                  },
                  {
                    key: 'count',
                    header: t('receptionist.colCount'),
                    width: 18,
                    align: 'right',
                    render: (r) =>
                      r.attendees?.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setOpenRow(openRow === r.id ? null : r.id)}
                          aria-expanded={openRow === r.id}
                          aria-label={t('receptionist.namedCountLabel', { count: r.attendees.length })}
                          title={t('receptionist.namedCountLabel', { count: r.attendees.length })}
                          className="cat-chip category-ink no-print"
                        >
                          <Users size={11} />
                          {t('receptionist.namedCount', { count: r.attendees.length })}
                          {openRow === r.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </button>
                      ) : (
                        // A figure is never truncated or wrapped mid-number.
                        <span className="font-semibold tabular-nums text-people-700">{(r.total || 0).toLocaleString()}</span>
                      ),
                  },
                  {
                    key: 'status',
                    header: t('receptionist.colStatus'),
                    width: 16,
                    align: 'right',
                    render: (r) =>
                      r.notified_at ? (
                        <span className="cat-chip category-success">✓ {t('receptionist.sent')}</span>
                      ) : (
                        <span className="cat-chip category-ink">• {t('receptionist.pending')}</span>
                      ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    width: 10,
                    render: (r) =>
                      user?.role !== 'receptionist' || !r.notified_at ? (
                        <button
                          type="button"
                          onClick={() => startEdit(r)}
                          title={t('receptionist.editAttendance')}
                          aria-label={t('receptionist.editAttendance')}
                          className="no-print inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-500 hover:bg-people-50 hover:text-people-700"
                        >
                          <Pencil size={15} />
                        </button>
                      ) : null,
                  },
                ]}
                rows={grouped.flatMap(([, rs]) => rs)}
                keyOf={(r) => r.id}
                flashIds={flashId ? [flashId] : null}
                empty={null}
                expandedRow={(r) =>
                  openRow === r.id && r.attendees?.length > 0 ? (
                    <>
                      <p className="mb-1 text-xs font-medium text-ink-500">{t('receptionist.attendees')}</p>
                      <div className="flex flex-wrap gap-1">
                        {r.attendees.map((n, i) => (
                          <span key={i} className="rounded-full bg-white px-2 py-0.5 text-xs text-ink-700 ring-1 ring-ink-200">
                            {n}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : null
                }
              />

            )}
          </section>

          {/* Offerings table */}
          <section className="tile p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="font-display text-base font-semibold">{t('receptionist.recentEntries')}</h3>
              <span className="text-sm font-semibold text-offering-700">{offeringsTotal.map(([c, t]) => `${t.toLocaleString()} ${c}`).join(' · ')}</span>
            </div>
            {offerings.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-400">{t('common.empty')}</p>
            ) : (
              // The same shared pattern as the attendance table above: one
              // column system, one card fallback. Column order is the app-wide
              // standard for offerings: Category, Giver, Service, Amount,
              // Status/Actions.
              <DataTable
                columns={[
                  {
                    key: 'category',
                    header: t('receptionist.colCategory'),
                    width: 22,
                    render: (o) => (
                      <span
                        className={`cat-chip ${CATEGORY_TONES[o.category_key] || 'category-offering'}`}
                        title={o.category_name}
                      >
                        {o.category_name}
                      </span>
                    ),
                  },
                  {
                    key: 'giver',
                    header: t('receptionist.colGiver'),
                    width: 18,
                    render: (o) => <GiverName o={o} t={t} />,
                  },
                  {
                    key: 'service',
                    header: t('receptionist.colService'),
                    width: 20,
                    render: (o) => <span className="text-xs text-ink-500">{o.service_type_name}{o.projectName ? ` · ${o.projectName}` : ''}</span>,
                  },
                  {
                    key: 'amount',
                    header: t('receptionist.colAmount'),
                    width: 18,
                    align: 'right',
                    cardValue: true,
                    // The point of the row: it never wraps or truncates.
                    render: (o) => (
                      <span className="whitespace-nowrap font-semibold tabular-nums text-offering-700">
                        {Number(o.amount).toLocaleString()} {o.currency}
                      </span>
                    ),
                  },
                  {
                    key: 'status',
                    header: t('receptionist.colStatus'),
                    width: 22,
                    align: 'right',
                    // The cluster wraps between its members instead of pushing
                    // the table wider: a two-line cell beats a scrollbar.
                    render: (o) => (
                      <span className="today-offering-status">
                        {o.notified_at && <span className="today-sent-status"><span aria-hidden="true">✓</span> {t('receptionist.sent')}</span>}
                        {o.receipt_number && (
                          <span className="today-receipt-group">
                            <span className="today-receipt-number" title={o.receipt_number}>{o.receipt_number}</span>
                            <ReceiptLinks o={o} t={t} tone="text-brand-800 hover:bg-brand-50" />
                          </span>
                        )}
                      </span>
                    ),
                  },
                ]}
                rows={offerings}
                keyOf={(o) => o.id}
                flashIds={flashId ? [flashId] : null}
                className="today-offerings-table"
                empty={null}
              />
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}