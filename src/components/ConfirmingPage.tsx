import { useEffect, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';
import './ConfirmingPage.css';

interface Props {
  // Called when the user clicks the back-to-login link. Lets us exit
  // the confirming view if the SDK never produces a session (e.g. the
  // confirmation link is malformed or expired).
  onCancel: () => void;
  // True once we receive a SIGNAL that the SDK is processing the
  // confirmation (SIGNED_IN event or getSession returning a session).
  // We keep showing the spinner regardless — the visual feedback is
  // the whole point — but this lets us swap the helper copy from
  // "Establishing secure session…" to "Signing you in…" once we know
  // Supabase actually accepted the token.
  sessionEstablished: boolean;
  // Set when the SDK gives up (timeout). Drives an error state with
  // a "back to sign in" affordance.
  timedOut: boolean;
}

// Visual confirmation screen shown for the few hundred ms between
// "user clicked the email link" and "Supabase SDK produced a session".
// Without this view the app briefly flashes the login screen or a
// bare "Loading…" before the dashboard appears, which feels broken —
// the user just confirmed an account and the UI should acknowledge
// that something is happening.
//
// The page uses a static brand mark (matching LoginPage's brand) plus
// a centered spinner. Two helper lines cycle subtly so the user
// knows the app is alive even if the SDK takes a moment.
export function ConfirmingPage({ onCancel, sessionEstablished, timedOut }: Props) {
  const { theme, toggle: toggleTheme } = useTheme();
  // The helper copy oscillates between two messages every ~3s once
  // the session is established. CSS animation could do this too, but
  // a JS interval keeps the React tree honest and lets us swap the
  // exact text without contorting the stylesheet.
  const [helperIdx, setHelperIdx] = useState(0);
  useEffect(() => {
    if (!sessionEstablished) return;
    const id = setInterval(() => setHelperIdx((i) => (i + 1) % 2), 2800);
    return () => clearInterval(id);
  }, [sessionEstablished]);

  return (
    <div className="confirming-page">
      <header className="confirming-page-header">
        <div className="brand">
          <div className="brand-mark">A</div>
          <span>Kurhona</span>
        </div>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>

      <main className="confirming-page-main">
        <div className="confirming-card">
          <div
            className={`confirming-spinner${timedOut ? ' is-hidden' : ''}`}
            aria-hidden="true"
          />
          {timedOut ? (
            <svg
              className="confirming-error-icon"
              width="44"
              height="44"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          ) : null}
          <h1 className="confirming-title">
            {timedOut
              ? 'Confirmation link not working'
              : 'Confirming your account…'}
          </h1>
          <p className="confirming-helper">
            {timedOut
              ? 'The link may have expired or already been used. You can request a new confirmation email from the sign-in screen.'
              : sessionEstablished
                ? helperIdx === 0
                  ? 'Establishing secure session…'
                  : 'Almost there…'
                : 'Verifying your confirmation link…'}
          </p>

          {timedOut ? (
            <button
              type="button"
              className="btn-primary confirming-back-btn"
              onClick={onCancel}
            >
              Back to sign in
            </button>
          ) : (
            <button
              type="button"
              className="confirming-cancel-link"
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
        </div>
      </main>
    </div>
  );
}