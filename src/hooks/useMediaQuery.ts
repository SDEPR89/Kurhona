import { useEffect, useState } from 'react';

// Reactive media-query hook. Returns `null` during SSR / first paint
// (when `window.matchMedia` isn't available), then the live boolean
// afterward. Subscribes to changes so a user rotating their phone or
// dragging the browser's resize handle re-renders immediately.
export function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return null;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    // Sync the initial value (in case window.matchMedia was undefined
    // during the lazy initializer — e.g. SSR / StrictMode double-init).
    setMatches(mql.matches);
    // addEventListener is the modern API. The deprecated addListener
    // fallback only matters for Safari < 14 (2020), so we skip it.
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return matches;
}