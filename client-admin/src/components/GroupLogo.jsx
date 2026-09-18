import { useEffect, useState } from 'react';
import api from '../api';

/**
 * A group's own logo.
 *
 * The bytes live on the group's row and are served under /groups/:id/logo with
 * the same auth as every other groups read, so they are fetched here as a blob
 * through the shared axios instance (token, session renewal and 401 handling
 * all come for free) and rendered from an object URL. Every list/detail payload
 * only carries `has_logo`: the bytes travel exactly once, here.
 *
 * The fallback is the group's first letters, so a logoless group still reads as
 * itself in a list of rows that mostly have images. The blob is revoked when
 * the group changes or the component unmounts; object URLs are never garbage
 * collected on their own, so skipping that would leak one URL per render.
 */
export default function GroupLogo({ groupId, name, size = 40, has, round = false, className = '' }) {
  // The state carries WHICH group it describes, so a render for any other group
  // simply doesn't read it: nothing needs resetting synchronously when the
  // group changes, and the effect below only touches state from its callbacks.
  const [loaded, setLoaded] = useState({ groupId: null, url: null, missing: false });

  useEffect(() => {
    // `has` comes straight from the payload (`has_logo`): a row known to have
    // no logo must not fetch one just to be told 404: a list of twenty groups
    // would otherwise fire twenty doomed requests on every render.
    if (has === false) return undefined;
    let alive = true;
    let objectUrl = null;
    api
      .get(`/groups/${groupId}/logo`, { responseType: 'blob' })
      .then(({ data }) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(data);
        setLoaded({ groupId, url: objectUrl, missing: false });
      })
      .catch(() => {
        if (alive) setLoaded({ groupId, url: null, missing: true });
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [groupId, has]);

  const initials = String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  const box = { width: size, height: size };
  const current = loaded.groupId === groupId ? loaded : null;

  // `round` turns the square tile into a circle: the shape a logo takes
  // inside a pill-shaped chip, where a square would fight the container's own
  // rounding.
  const shape = round ? 'rounded-full' : 'rounded-lg';

  if (has === false || current?.missing) {
    return (
      <span
        aria-hidden="true"
        style={box}
        className={`inline-flex shrink-0 items-center justify-center ${shape} bg-brand-100 font-display text-xs font-semibold text-brand-800 ${className}`}
      >
        {initials || '?'}
      </span>
    );
  }

  return (
    <img
      src={current?.url || undefined}
      alt={`${name} logo`}
      width={size}
      height={size}
      style={box}
      className={`inline-block shrink-0 ${shape} border border-ink-200 bg-white object-contain ${className}`}
    />
  );
}
