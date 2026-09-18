/*
 * The unread/open count pill.
 *
 * Shared deliberately: it is pinned to a nav icon in both nav presentations and
 * to the bell in the Home notifications tile, so those are the *same* badge
 * rather than three that merely resemble each other. It is absolutely
 * positioned, so the caller must wrap it in a `relative` container.
 */
const TONES = { danger: 'bg-danger-600', brand: 'bg-brand-600' };

export default function CountBadge({ count, tone, className = '' }) {
  if (!count) return null;
  const fill = TONES[tone] || TONES.brand;
  return (
    <span
      className={`absolute -right-1.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums text-white ${fill} ${className}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
