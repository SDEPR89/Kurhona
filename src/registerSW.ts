// Automatic Service Worker registration for Kurhona PWA

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        console.log('[Kurhona SW] Registered with scope:', registration.scope);
      })
      .catch((error) => {
        console.error('[Kurhona SW] Registration failed:', error);
      });
  });
}
