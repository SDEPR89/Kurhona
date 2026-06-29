import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { DeleteAccountSection } from './DeleteAccountSection';
import {
  EMAIL_RE,
  PASSWORD_MIN,
  USERNAME_RE,
} from './shared';

// ---------------------------------------------------------------------------
// UpgradeAccountSection — replaces the regular Username / Password /
// Delete sections for anonymous guests. The flow attaches credentials
// to the existing anonymous session (auth.updateUser), so all tasks /
// subjects created during the guest session survive the upgrade.
// ---------------------------------------------------------------------------

interface Props {
  onAccountUpgraded: (newEmail: string) => void;
  onAccountDeleted: () => void;
}

export function UpgradeAccountSection({
  onAccountUpgraded,
  onAccountDeleted,
}: Props) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Username goes through the same regex as signup (kept in sync
  // via shared.ts). Case-insensitive collision is enforced
  // server-side by the citext column.
  const normalizedUsername = username.trim().toLowerCase();
  const usernameValid = USERNAME_RE.test(username.trim());
  const emailValid = EMAIL_RE.test(email.trim());
  const passwordValid = password.length >= PASSWORD_MIN;
  const ready = usernameValid && emailValid && passwordValid;

  async function handleUpgrade(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!ready) return;
    setBusy(true);
    // 1) Probe for username collision BEFORE the auth update. We
    //    use `maybeSingle` + a manual error-mapping instead of an
    //    RPC because the citext unique constraint is a 23505
    //    SQLSTATE we can rely on — the client just needs to
    //    translate that into the user-facing message. Doing the
    //    probe before auth.updateUser means a taken username
    //    doesn't strand the user with credentials they can't use
    //    to claim a name.
    const { data: taken } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('username', normalizedUsername)
      .maybeSingle();
    if (taken) {
      setBusy(false);
      setError('That username is taken.');
      return;
    }
    // 2) Attach credentials to the existing anonymous session.
    //    updateUser is for "I already own this session, add
    //    credentials" — no confirmation email is sent.
    const { data, error: updErr } = await supabase.auth.updateUser({
      email: email.trim(),
      password,
    });
    if (updErr) {
      setBusy(false);
      setError(updErr.message);
      return;
    }
    const newEmail = data.user?.email ?? email.trim();
    // 3) Create the profile row. We do this directly rather than
    //    going through the handle_new_user trigger (which only
    //    fires on auth.users INSERT — updateUser doesn't fire it)
    //    so the race window between the uniqueness probe above
    //    and the insert is small but non-zero: a second
    //    concurrent signup could claim the username between
    //    probe and insert. The citext UNIQUE constraint catches
    //    that — we treat 23505 as "taken" and roll back the auth
    //    update by signing the user out so they can retry with a
    //    different name.
    const { error: profErr } = await supabase
      .from('profiles')
      .insert({
        user_id: data.user?.id,
        username: normalizedUsername,
        display_username: username.trim(),
      });
    if (profErr) {
      // 23505 = unique_violation in Postgres. Surface as the same
      // user-facing message regardless of whether the probe missed
      // or the constraint caught a race. The probe at the top of
      // this function ran BEFORE auth.updateUser attached an email
      // and password to this session, so a 23505 here means the
      // session is now stranded: credentials are attached, but the
      // username row was claimed by another signup before we could
      // insert. The user would otherwise be unable to recover —
      // signing in with the new email+password works, but the
      // username lookup that resolves to a user_id won't find them,
      // and the next "Continue as guest" would create a *second*
      // anonymous account. Sign out so they land on the login screen
      // and can pick a different name.
      setBusy(false);
      if (profErr.code === '23505') {
        try {
          await supabase.auth.signOut({ scope: 'global' });
        } catch {
          // Sign-out itself failed (network down). The local session
          // is still attached with the unclaimed credentials; call
          // onAccountDeleted so the parent flips the UI back to
          // LoginPage even if the server round-trip didn't land.
        }
        setError('That username was just taken. Please sign up again with a different name.');
        onAccountDeleted();
      } else {
        setError(profErr.message);
      }
      return;
    }
    setBusy(false);
    onAccountUpgraded(newEmail);
    setSavedAt(Date.now());
  }

  return (
    <>
      <section className="settings-section">
        <h3>Upgrade account</h3>
        <p className="settings-help">
          You're signed in as a guest. Choose a username and attach an email and password so you can sign back in from any device —
          your existing tasks and subjects are kept.
        </p>
        <form onSubmit={handleUpgrade} className="settings-upgrade-form">
          <div className="field">
            <label htmlFor="settings-upgrade-username">Username</label>
            <input
              id="settings-upgrade-username"
              className="input"
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setSavedAt(null);
              }}
              placeholder="e.g. alice"
              autoComplete="username"
              pattern="[A-Za-z0-9_]{3,32}"
              title="3–32 letters, digits, or underscore"
              required
              disabled={busy}
              aria-invalid={username.length > 0 && !usernameValid}
            />
            {username.length > 0 && !usernameValid && (
              <p className="field-hint" role="alert">
                3–32 letters, digits, or underscore.
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="settings-upgrade-email">Email</label>
            <input
              id="settings-upgrade-email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setSavedAt(null);
              }}
              placeholder="you@example.com"
              autoComplete="email"
              required
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="settings-upgrade-password">Password</label>
            <input
              id="settings-upgrade-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setSavedAt(null);
              }}
              placeholder={`At least ${PASSWORD_MIN} characters`}
              autoComplete="new-password"
              required
              disabled={busy}
            />
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          {savedAt && !error && (
            <p className="settings-saved" role="status">Account upgraded. You can sign back in any time.</p>
          )}
          <div className="settings-section-actions">
            <button
              type="submit"
              className="btn-primary"
              disabled={!ready || busy}
              aria-busy={busy || undefined}
            >
              {busy ? 'Upgrading…' : 'Upgrade account'}
            </button>
          </div>
        </form>
      </section>

      <DeleteAccountSection
        userEmail={null}
        onAccountDeleted={onAccountDeleted}
      />
    </>
  );
}
