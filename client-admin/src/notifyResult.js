/**
 * What the desk is told after pressing "Send to pastor".
 *
 * The server answers with what it SENT (`summary`) or, when nothing went out,
 * why: there is nothing new since the last update, or there is no pastor account
 * to send to. Both are ordinary outcomes of the button rather than failures: the
 * whole point of recording membership changes is that pressing it twice with
 * nothing new sends nothing, and the desk deserves to be told that instead of
 * being shown a "sent" that sent nothing.
 *
 * One helper rather than a copy per screen (the group list and the group's own
 * page both have the button), so the two can never word the same answer
 * differently.
 */
export function notifyResultMessage(t, data) {
  if (data && data.sent) return t('groups.notifySent', { summary: data.summary });
  return t(data && data.reason === 'no_pastor' ? 'groups.notifyNoPastor' : 'groups.notifyNothingNew');
}

/** Success only when something actually went out; otherwise it is information. */
export function notifyResultTone(data) {
  return data && data.sent ? 'success' : 'info';
}
