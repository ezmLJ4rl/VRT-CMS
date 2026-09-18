export function attendanceMetrics(row) {
  const attendees = Array.isArray(row?.attendees) ? row.attendees : [];
  const mode = row?.mode || row?.attendance_mode || 'headcount';
  const hasRecordedCount = row?.count !== null && row?.count !== undefined && row?.count !== '';
  const recorded = hasRecordedCount ? Number(row.count) : Number(row?.total ?? 0);
  const metrics = [];

  if (mode === 'headcount' || mode === 'both') {
    if (hasRecordedCount || mode === 'headcount') {
      metrics.push({ kind: 'recorded', count: Number.isFinite(recorded) ? recorded : 0 });
    }
  }
  if (mode === 'named' || mode === 'both') {
    metrics.push({ kind: 'unique', count: attendees.length || (mode === 'named' ? Math.max(0, Number(row?.count || 0)) : 0) });
  }

  return metrics;
}

export function attendanceMetricLabel(t, kind) {
  return t(kind === 'unique' ? 'records.uniqueAttendees' : 'records.recordedHeadcount');
}
