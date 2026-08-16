import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const dismissed = sessionStorage.getItem('kurhona-install-dismissed') === '1';
    if (dismissed) return;

    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    const isStandalone =
      (navigator as Navigator & { standalone?: boolean }).standalone ||
      window.matchMedia?.('(display-mode: standalone)').matches;

    if (isStandalone) return;

    if (ios) {
      setIsIos(true);
      setShow(true);
      return;
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShow(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShow(false);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    sessionStorage.setItem('kurhona-install-dismissed', '1');
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="install-prompt" role="status">
      <div className="install-prompt-text">
        {isIos ? (
          <>
            <strong>Get reminders on iPhone.</strong> Tap{' '}
            <span className="install-prompt-icon" aria-label="Share button">
              ⬆
            </span>{' '}
            <em>Share</em>, then <em>Add to Home Screen</em>.
          </>
        ) : (
          <>
            <strong>Install Kurhona App</strong> for fast access and push notifications.
          </>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {!isIos && deferredPrompt && (
          <button
            type="button"
            className="sidebar-action-btn"
            style={{ padding: '4px 12px', fontSize: '0.85rem', fontWeight: 600 }}
            onClick={handleInstallClick}
          >
            Install
          </button>
        )}
        <button
          type="button"
          className="install-prompt-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss install instructions"
        >
          ×
        </button>
      </div>
    </div>
  );
}

