const ACCENTS = {
  people: 'border-l-people-600',   /* attendance / people data */
  offering: 'border-l-offering-600', /* offerings / money data */
  brand: 'border-l-brand-600',     /* brand / attention */
  amber: 'border-l-amber-500',     /* warning / pending */
  danger: 'border-l-danger-500',   /* critical / error */
  neutral: 'border-l-ink-300',
};

export default function StatCard({ label, value, sub, accent = 'neutral' }) {
  const borderColor = ACCENTS[accent] || ACCENTS.neutral;
  return (
    <div className={`rounded-lg border border-ink-200 border-l-4 ${borderColor} bg-paper p-4 shadow-sm`}>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-ink-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-400">{sub}</p>}
    </div>
  );
}