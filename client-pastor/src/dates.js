// Today's date in the church's timezone-ready form (Africa/Dar_es_Salaam by default).
// Keeps the "local" date stable regardless of where the device is located.
export function todayISO() {
  const now = new Date();
  const tz = Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return tz;
}
