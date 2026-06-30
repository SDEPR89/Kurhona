import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import './ResetPassword.css';

interface Props {
  onComplete: () => void;
  onCancel: () => void;
}

export function ResetPassword({ onComplete, onCancel }: Props) {
  const [email, setEmail] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    // Show the email being reset so the user can sanity-check it before
    // committing to a new password.
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setEmail(data.user.email);
    });
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        setError(error.message);
        return;
      }
      // Password successfully changed — the recovery session is now a normal
      // session and the parent can show the dashboard.
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setLoading(false);
    }
  }

  async function onResend() {
    if (!email) {
      setError('Enter your email below to receive a new reset link.');
      return;
    }
    setError(null);
    setResending(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) setError(error.message);
      else {
        // Drop the now-stale recovery session and bounce back to login.
        await supabase.auth.signOut();
        onCancel();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setResending(false);
    }
  }

  return (
    <main className="reset-page">
      <div className="card">
        <div className="brand">
          <div className="brand-mark">A</div>
          <span>Kurhona</span>
        </div>

        <h1>Set a new password</h1>
        <p className="subtitle">
          {email ? (
            <>
              Choose a new password for <span className="reset-email">{email}</span>.
            </>
          ) : (
            'Choose a new password to finish resetting your account.'
          )}
        </p>

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <div className="password-field">
              <input
                className="input"
                type={showPassword ? 'text' : 'password'}
                id="new-password"
                name="new-password"
                autoComplete="new-password"
                autoFocus
                required
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setError(null);
                }}
                disabled={loading}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                aria-controls="new-password"
                disabled={loading}
              >
                {showPassword ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a19.86 19.86 0 0 1 4.22-5.36" />
                    <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a19.5 19.5 0 0 1-3.17 4.19" />
                    <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
                    <line x1="2" y1="2" x2="22" y2="22" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="confirm-password">Confirm new password</label>
            <input
              className="input"
              type={showPassword ? 'text' : 'password'}
              id="confirm-password"
              name="confirm-password"
              autoComplete="new-password"
              required
              placeholder="••••••••"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setError(null);
              }}
              disabled={loading}
            />
          </div>

          {error && (
            <p className="form-error" role="alert" aria-live="polite">
              {error}
            </p>
          )}

          <button className="btn-primary" type="submit" disabled={loading} aria-busy={loading || undefined}>
            {loading && <span className="spinner" aria-hidden="true" />}
            <span>{loading ? 'Saving…' : 'Save new password'}</span>
          </button>

          <button
            type="button"
            className="forgot-link"
            onClick={onResend}
            disabled={loading || resending}
            style={{ alignSelf: 'center', marginTop: 4 }}
          >
            {resending ? 'Sending…' : 'Send a new reset link'}
          </button>
        </form>
      </div>
    </main>
  );
}