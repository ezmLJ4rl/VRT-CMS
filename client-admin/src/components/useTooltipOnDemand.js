import { useEffect, useState } from 'react';

/**
 * A chart tooltip is a response to pointing at something.
 *
 * Recharts keeps a tooltip active for as long as the pointer is inside the plot
 * area, and it only learns that the pointer has left from a pointer event. A page
 * scroll moves the chart out from under a stationary pointer without firing one,
 * so the tooltip, and the grey band it paints over the hovered bar to mark it:
 * stayed stuck on the chart as the page scrolled past. That is the "tooltip is
 * permanently visible over the bar" symptom; it is not a default-on tooltip.
 *
 * So the tooltip is switched off on scroll/touch-drag and switched back on by the
 * next pointer movement over the chart. Nothing else changes: hovering still shows
 * it, leaving still hides it. Returns the value to pass as the tooltip's `active`
 * prop (undefined = let Recharts own it, false = force it hidden).
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
