import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useTheme } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';
import './LoginPage.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Accepts uppercase too — we normalize via normalizeUsername() before
// sending. The server side stores usernames in a `citext` column (case-
// insensitive) and the trigger / RPC use lower() too, so "Alice_42"
// collides with "alice_42" either way. Allowing uppercase input just
// means users don't have to think about casing while typing.
const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;

// Use the same generic error Supabase returns for wrong passwords so we
// don't leak which usernames exist. (Without this, "user not found" and
// "wrong password" become two different errors and let an attacker
// enumerate accounts.)
const GENERIC_AUTH_ERROR = 'Username or password is incorrect.';

// "Stay signed in" preference storage. A small key (not namespaced under
// the Supabase prefix) so it never collides with auth tokens we may
// need to delete on sign-out / session-only sign-in. The value is the
// string "1" or "0"; localStorage only stores strings.
const STAY_SIGNED_IN_KEY = 'acme:staySignedIn';

// Supabase encodes its auth tokens in localStorage as
// `sb-<project-ref>-auth-token` (and similar). We match this prefix/
// suffix to wipe the auth tokens we just wrote when the user opts out
// of "Stay signed in". The suffix `auth-token` matches what the SDK
// writes today; the prefix `sb-` is the SDK convention. This is the
// same pattern App.tsx uses for cross-tab sign-out detection.
function clearSupabaseAuthTokensFromStorage() {
  if (typeof window === 'undefined') return;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // localStorage can be unavailable (private mode, quota). Safe to
    // ignore — the worst case is the session keeps its persistent
    // form, which is the conservative default.
  }
}

function readStaySignedInPreference(): boolean {
  // Default to true (current behavior). Read from localStorage so the
  // user's last choice feels remembered across visits — a small UX
  // win that matches what every other "remember me" toggle does.
  if (typeof window === 'undefined') return true;
  try {
    const v = window.localStorage.getItem(STAY_SIGNED_IN_KEY);
    if (v === '0') return false;
    return true;
  } catch {
    return true;
  }
}

function writeStaySignedInPreference(value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STAY_SIGNED_IN_KEY, value ? '1' : '0');
  } catch {
    // localStorage unavailable — silently ignore (matches useTheme.ts).
  }
}

function looksLikeEmail(s: string) {
  return EMAIL_RE.test(s.trim());
}

function normalizeUsername(s: string) {
  return s.trim().toLowerCase();
}

interface ResolvedIdentifier {
  email: string;
  // True when the user typed an email directly. False when we resolved a
  // username via the RPC — kept around so error paths can be honest
  // without leaking which path was taken.
  viaRpc: boolean;
}

async function resolveIdentifier(raw: string): Promise<ResolvedIdentifier | null> {
  const trimmed = raw.trim();
  if (looksLikeEmail(trimmed)) {
    return { email: trimmed, viaRpc: false };
  }
  if (!USERNAME_RE.test(normalizeUsername(trimmed))) return null;
  const { data, error } = await supabase.rpc('email_for_username', {
    p_username: normalizeUsername(trimmed),
  });
  if (error) return null;
  if (!data) return null;
  return { email: data as string, viaRpc: true };
}

export function LoginPage() {
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const { theme, toggle: toggleTheme } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [resetting, setResetting] = useState(false);
  // True while the anonymous sign-in round-trip is in flight. Shown
  // on the "Continue as guest" button so the user gets feedback. Kept
  // separate from `loading` so the email/password form stays enabled
  // (or not) according to its own rules.
  const [guestLoading, setGuestLoading] = useState(false);
  // "Stay signed in" preference. Seeded from localStorage so the user's
  // last choice feels remembered; default true preserves the current
  // persistent-session behavior on first visit.
  const [staySignedIn, setStaySignedIn] = useState<boolean>(() => readStaySignedInPreference());

  function clearAlerts() {
    setError(null);
    setMessage(null);
  }

  // Reset to true on mode flip so a stale unchecked state doesn't
  // carry across into signup (which has no checkbox and no cleanup
  // path to worry about). The user's persistent preference is still
  // remembered in localStorage for next sign-in.
  const toggleMode = () => {
    const next = mode === 'signin' ? 'signup' : 'signin';
    setMode(next);
    setStaySignedIn(true);
    writeStaySignedInPreference(true);
    clearAlerts();
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    clearAlerts();
    // Reset the preference back to "stay signed in" on every submit so
    // an unchecked state doesn't silently carry across sign-in
    // attempts (e.g. a wrong password followed by a correct one). The
    // user's persistent preference lives in localStorage and will be
    // re-read on the next page load.
    setStaySignedIn(true);
    writeStaySignedInPreference(true);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    // Signup: validate the username up front and reject taken names before
    // we even create an auth.users row. Without this, the trigger would
    // still copy the username into profiles, but the conflict error from
    // there is opaque ("duplicate key") and confusing to a new user.
    if (mode === 'signup') {
      const u = normalizeUsername(username);
      if (!USERNAME_RE.test(u)) {
        setError('Username must be 3–32 characters, lowercase letters, digits, or underscore.');
        return;
      }
      if (!looksLikeEmail(identifier)) {
        setError('Please enter a valid email address.');
        return;
      }
      setLoading(true);
      try {
        const { data: taken, error: takenErr } = await supabase
          .from('profiles')
          .select('user_id')
          .eq('username', u)
          .maybeSingle();
        if (takenErr) {
          setError(takenErr.message);
          return;
        }
        if (taken) {
          setError('That username is taken.');
          return;
        }
        const { error: signUpErr } = await supabase.auth.signUp({
          email: identifier.trim(),
          password,
          // The username rides along in user_metadata and is copied into
          // the profiles table by the handle_new_user trigger.
          options: { data: { username: u }, emailRedirectTo: window.location.origin },
        });
        if (signUpErr) setError(signUpErr.message);
        else setMessage('Check your email to confirm your account.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unexpected error');
      } finally {
        setLoading(false);
      }
      return;
    }

    // Sign-in: resolve "alice" -> "alice@example.com" before calling
    // signInWithPassword, which only accepts an email.
    const resolved = await resolveIdentifier(identifier);
    if (!resolved) {
      setError(GENERIC_AUTH_ERROR);
      return;
    }
    setLoading(true);
    try {
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: resolved.email,
        password,
      });
      if (signInErr) {
        setError(GENERIC_AUTH_ERROR);
      } else if (!staySignedIn) {
        // "Stay signed in" is off — make the session tab-scoped. The
        // SDK has already fired SIGNED_IN and App.tsx has rendered the
        // dashboard; the in-memory session keeps the tab alive. We
        // clear the localStorage entry now so refresh, tab close, and
        // new tabs all see no session. Done after sign-in succeeds so
        // there's no race with the auth listener's SIGNED_IN handler.
        clearSupabaseAuthTokensFromStorage();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setLoading(false);
    }
  }

  async function onForgotPassword() {
    clearAlerts();
    const raw = identifier.trim();
    if (!raw) {
      setError('Enter your email or username above, then click "Forgot password?" again.');
      return;
    }
    // Same resolution as sign-in: if it's a username, look up the email.
    const resolved = await resolveIdentifier(raw);
    if (!resolved) {
      setError('Enter your email or username above, then click "Forgot password?" again.');
      return;
    }
    setResetting(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(resolved.email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) setError(error.message);
      else setMessage(`Check ${resolved.email} for a reset link.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setResetting(false);
    }
  }

  // Anonymous sign-in. Creates a Supabase auth.users row with no
  // email/password — the SDK persists the resulting session like any
  // other, so refresh / cross-tab work normally. Anonymous accounts
  // have no credentials, so a user who clears localStorage loses
  // access to their data permanently. The settings modal offers an
  // "Upgrade account" path that attaches an email + password via
  // supabase.auth.updateUser(), turning the anonymous session into
  // a regular one without losing tasks / subjects.
  async function onContinueAsGuest() {
    clearAlerts();
    setGuestLoading(true);
    try {
      const { error } = await supabase.auth.signInAnonymously();
      // We don't get a session on success — onAuthStateChange fires
      // SIGNED_IN and App.tsx renders the dashboard. On failure
      // surface the message; common cause is Supabase project not
      // having the anonymous provider enabled (Authentication ->
      // Providers -> Anonymous).
      if (error) setError(error.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setGuestLoading(false);
    }
  }

  const busy = loading || resetting;

  return (
    <main className="login-page">
      {/* Brand pinned top-right */}
      <div className="login-brand-top">
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
        <div className="brand-mark">A</div>
        <span>Acme</span>
      </div>

      {/* Centered glass card */}
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-avatar" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
          </svg>
        </div>

        <h1 id="login-title">{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
        <p className="subtitle">
          {mode === 'signin'
            ? 'Welcome back. Please enter your details.'
            : 'Sign up to get started.'}
        </p>

        <form onSubmit={onSubmit} noValidate>
          {mode === 'signup' && (
            <div className="field">
              <label htmlFor="username">Username</label>
              <input
                className="input"
                type="text"
                id="username"
                name="username"
                autoComplete="username"
                autoFocus
                required
                placeholder="e.g. alice"
                pattern="[a-z0-9_]{3,32}"
                title="3–32 lowercase letters, digits, or underscore"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  clearAlerts();
                }}
                disabled={busy}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="identifier">{mode === 'signin' ? 'Email or username' : 'Email'}</label>
            <input
              className="input"
              type={mode === 'signup' ? 'email' : 'text'}
              id="identifier"
              name="identifier"
              autoComplete={mode === 'signin' ? 'username' : 'email'}
              autoFocus={mode === 'signin'}
              required
              placeholder={mode === 'signin' ? 'you@example.com or alice' : 'you@example.com'}
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                clearAlerts();
              }}
              disabled={busy}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input
                className="input"
                type={showPassword ? 'text' : 'password'}
                id="password"
                name="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearAlerts();
                }}
                disabled={busy}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                aria-controls="password"
                disabled={busy}
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
            {mode === 'signin' && (
              <button
                type="button"
                className="forgot-link"
                onClick={onForgotPassword}
                disabled={busy}
              >
                {resetting ? 'Sending…' : 'Forgot password?'}
              </button>
            )}
          </div>

          {error && (
            <p className="form-error" role="alert" aria-live="polite">
              {error}
            </p>
          )}
          {message && (
            <p className="form-success" role="status" aria-live="polite">
              {message}
            </p>
          )}

          {mode === 'signin' && (
            // "Remember me" — when off, the session is cleared from
            // localStorage on successful sign-in so refresh / tab close
            // / new tabs all see no session. Defaulted on for the common
            // case; the user's choice is remembered across visits via
            // STAY_SIGNED_IN_KEY.
            <label className="stay-signed-in">
              <input
                type="checkbox"
                checked={staySignedIn}
                onChange={(e) => {
                  const next = e.target.checked;
                  setStaySignedIn(next);
                  writeStaySignedInPreference(next);
                }}
                disabled={busy}
              />
              <span className="stay-signed-in-label">Stay signed in</span>
            </label>
          )}

          <button className="btn-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
            {loading && <span className="spinner" aria-hidden="true" />}
            <span>{loading ? (mode === 'signin' ? 'Signing in' : 'Creating account') : mode === 'signin' ? 'Sign in' : 'Create account'}</span>
          </button>
        </form>

        {mode === 'signin' && (
          // Guest sign-in is offered alongside the regular flow rather
          // than mixed into the form so it never confuses a user who
          // already has an account. The dashed divider signals
          // "another way in" without competing visually with the
          // primary button above.
          <>
            <div className="auth-divider" role="separator" aria-label="Or">
              <span>or</span>
            </div>
            <button
              type="button"
              className="btn-secondary btn-guest"
              onClick={onContinueAsGuest}
              disabled={guestLoading || busy}
              aria-busy={guestLoading || undefined}
            >
              {guestLoading && <span className="spinner" aria-hidden="true" />}
              <span>{guestLoading ? 'Continuing…' : 'Continue as guest'}</span>
            </button>
            <p className="guest-disclaimer">
              Try the app without an account. Your tasks save to this browser only —{' '}
              <button
                type="button"
                className="inline-link"
                onClick={() => {
                  setMode('signup');
                  // Signup doesn't show the "Stay signed in" toggle; reset
                  // to the safe default so the unchecked state from a
                  // forgotten sign-in mode doesn't haunt us.
                  setStaySignedIn(true);
                  writeStaySignedInPreference(true);
                  clearAlerts();
                }}
              >
                sign up
              </button>{' '}
              to keep them across devices.
            </p>
          </>
        )}

        <p className="footer">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              toggleMode();
            }}
          >
            {mode === 'signin' ? 'Sign up' : 'Sign in'}
          </a>
        </p>
      </section>
    </main>
  );
}
