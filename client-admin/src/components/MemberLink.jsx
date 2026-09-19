import { Link, useInRouterContext } from 'react-router-dom';

/**
 * Use wherever a server response includes a real member id. Free-text names
 * deliberately remain plain text because they do not identify a member record.
 */
export default function MemberLink({ memberId, children, className = '' }) {
  const inRouter = useInRouterContext();
  if (memberId == null || memberId === '') return <span className={className}>{children}</span>;

  const linkClass = `font-medium text-brand-800 underline-offset-2 hover:underline focus-visible:underline ${className}`;
  if (!inRouter) return <a href={`/members/${memberId}`} className={linkClass}>{children}</a>;

  return (
    <Link
      to={`/members/${memberId}`}
      onClick={(event) => event.stopPropagation()}
      className={linkClass}
    >
      {children}
    </Link>
  );
}
