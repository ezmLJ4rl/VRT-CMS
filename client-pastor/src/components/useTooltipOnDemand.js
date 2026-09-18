import { useEffect, useState } from 'react';

/**
 * A chart tooltip is a response to pointing at something.
 *
 * Recharts keeps a tooltip active for as long as the pointer is inside the plot
 * area, and it only learns that the pointer has left from a pointer event. A page
 * scroll moves the chart out from under a stationary pointer without firing one,
 * so the tooltip stayed stuck on the chart as the page scrolled past. Switching it
 * off on scroll (and back on with the next pointer movement) removes the only case
 * where a tooltip is not a response to pointing.
 *
 * Kept identical to the admin app's copy: the two apps share this component's
 * behaviour, so a fix for the pastor's phone has to be the same fix.
 */
export default function useTooltipOnDemand() {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    const hide = () => setEnabled(false);
    const show = () => setEnabled(true);
    // Capture phase: any scrollable ancestor counts, not just the page itself.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('touchmove', hide, true);
    window.addEventListener('mousemove', show);
    window.addEventListener('touchstart', show);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('touchmove', hide, true);
      window.removeEventListener('mousemove', show);
      window.removeEventListener('touchstart', show);
    };
  }, []);

  return enabled;
}
