import { useEffect, useState } from 'react';

// iOS-only banner that tells the user to install the PWA before
// reminders can fire. iOS Safari refuses Web Push from a regular
// tab — the user has to use Share → Add to Home Screen first, then
// open the installed app. There's no API to trigger this
// programmatically, so we just show the instruction.
//
// Hidden on other platforms: Chrome/Edge/Firefox show their own
// install affordance automatically, and Safari on macOS doesn't
// need a manual hint.
export function InstallPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ua = navigator.userAgent;
    const isiOS = /iPad|iPhone|iPod/.test(ua);
    const isWebkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    const isStandalone =
      (navigator as Navigator & { standalone?: boolean }).standalone ||
      window.matchMedia?.('(display-mode: standalone)').matches;
    // sessionStorage so the user only sees this banner once per
    // tab session — they may close it intentionally and shouldn't
    // have to dismiss it again every time they reopen the tab.
    const dismissed = sessionStorage.getItem('kurhona-install-dismissed') === '1';
    setShow(isiOS && isWebkit && !isStandalone && !dismissed);
  }, []);

  if (!show) return null;

  return (
    <div className="install-prompt" role="status">
      <div className="install-prompt-text">
        <strong>Get reminders on iPhone.</strong> Tap{' '}
        <span className="install-prompt-icon" aria-label="Share button">
          ⬆
        </span>{' '}
        <em>Share</em>, then <em>Add to Home Screen</em>.
      </div>
      <button
        type="button"
        className="install-prompt-dismiss"
        onClick={() => {
          sessionStorage.setItem('kurhona-install-dismissed', '1');
          setShow(false);
        }}
        aria-label="Dismiss install instructions"
      >
        ×
      </button>
    </div>
  );
}
