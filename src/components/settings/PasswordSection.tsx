import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { PASSWORD_MIN, detectProvider, type Provider } from './shared';

// ---------------------------------------------------------------------------
// PasswordSection — re-authenticates as proof of the current password
// (Supabase has no verify-password endpoint), then updateUser. OAuth-only
// users without a password get a "send reset email" path instead.
// ---------------------------------------------------------------------------

interface Props {
  userEmail: string | null;
}

export function PasswordSection({ userEmail }: Props) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [resetSentAt, setResetSentAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    detectProvider().then((p) => {
      if (!cancelled) setProvider(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // OAuth-only users (Google/GitHub without a password set) can't
  // use the form. Surface a "send reset email" path instead — once
  // they set a password via the link, they can sign in with it AND
  // via OAuth.
  if (provider && provider !== 'email') {
    return (
      <section className="settings-section">
        <h3>Password</h3>
        <p className="settings-help">
          You signed up with {provider === 'google' ? 'Google' : 'GitHub'}, so no password is set on
          your account. Send yourself a reset email to add one.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {resetSentAt && (
          <p className="settings-saved" role="status">
            Reset email sent. Check your inbox.
          </p>
        )}
        <div className="settings-section-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !userEmail}
            onClick={async () => {
              if (!userEmail) return;
              setError(null);
              setBusy(true);
              const { error } = await supabase.auth.resetPasswordForEmail(userEmail, {
                redirectTo: window.location.origin,
              });
              setBusy(false);
              if (error) setError(error.message);
              else setResetSentAt(Date.now());
            }}
          >
            {busy ? 'Sending…' : 'Send password reset email'}
          </button>
        </div>
      </section>
    );
  }

  const newPwValid = newPw.length >= PASSWORD_MIN;
  const matches = newPw.length > 0 && newPw === confirmPw;

  async function handleChange(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userEmail) {
      setError('No email on file — cannot verify current password.');
      return;
    }
    if (!currentPw) {
      setError('Enter your current password.');
      return;
    }
    if (!newPwValid) {
      setError(`New password must be at least ${PASSWORD_MIN} characters.`);
      return;
    }
    if (!matches) {
      setError('New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    // Verify the current password first. Supabase has no "verify
    // password" method, so we re-authenticate as the proof. This
    // re-issues a fresh session — the subsequent updateUser() then
    // lands on a verified caller.
    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password: currentPw,
    });
    if (signInErr) {
      setBusy(false);
      setError('Current password is incorrect.');
      return;
    }
    const { error: updateErr } = await supabase.auth.updateUser({ password: newPw });
    setBusy(false);
    if (updateErr) {
      setError(updateErr.message);
      return;
    }
    setCurrentPw('');
    setNewPw('');
    setConfirmPw('');
    setSavedAt(Date.now());
  }

  return (
    <section className="settings-section">
      <h3>Password</h3>
      <p className="settings-help">At least {PASSWORD_MIN} characters. Changes take effect immediately.</p>
      <form onSubmit={handleChange} className="settings-password-form">
        <div className="field">
          <label htmlFor="settings-current-pw">Current password</label>
          <input
            id="settings-current-pw"
            className="input"
            type="password"
            value={currentPw}
            onChange={(e) => {
              setCurrentPw(e.target.value);
              setSavedAt(null);
            }}
            autoComplete="current-password"
            disabled={busy}
          />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="settings-new-pw">New password</label>
            <input
              id="settings-new-pw"
              className="input"
              type="password"
              value={newPw}
              onChange={(e) => {
                setNewPw(e.target.value);
                setSavedAt(null);
              }}
              autoComplete="new-password"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="settings-confirm-pw">Confirm new password</label>
            <input
              id="settings-confirm-pw"
              className="input"
              type="password"
              value={confirmPw}
              onChange={(e) => {
                setConfirmPw(e.target.value);
                setSavedAt(null);
              }}
              autoComplete="new-password"
              disabled={busy}
            />
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {savedAt && !error && <p className="settings-saved" role="status">Password updated.</p>}
        <div className="settings-section-actions">
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !currentPw || !newPwValid || !matches}
          >
            {busy ? 'Saving…' : 'Update password'}
          </button>
        </div>
      </form>
    </section>
  );
}
