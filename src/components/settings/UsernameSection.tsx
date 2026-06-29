import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { USERNAME_RE, normalizeUsername } from './shared';

// ---------------------------------------------------------------------------
// UsernameSection — saved as case-preserved `display_username` and
// lowercased canonical `username`. The citext unique constraint on
// `username` enforces case-insensitive collision; a 23505 here means
// someone else already owns this name.
// ---------------------------------------------------------------------------

interface Props {
  userId: string;
  currentUsername: string | null;
  currentDisplayUsername: string | null;
  onUsernameUpdated: (newDisplayUsername: string) => void;
}

export function UsernameSection({
  userId,
  currentUsername,
  currentDisplayUsername,
  onUsernameUpdated,
}: Props) {
  // Pre-fill with the case-preserved form. Fall back to the canonical
  // (lowercased) username so older accounts without display_username
  // still show something readable in the input.
  const initial = currentDisplayUsername ?? currentUsername ?? '';
  const [username, setUsername] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // If the parent learns the username changed elsewhere, keep the
  // input in sync — e.g. App.tsx updates after a successful save.
  useEffect(() => {
    setUsername(currentDisplayUsername ?? currentUsername ?? '');
  }, [currentUsername, currentDisplayUsername]);

  const trimmed = username.trim();
  const normalized = normalizeUsername(username);
  const isValid = USERNAME_RE.test(trimmed);
  // "Unchanged" compares both display and canonical forms so a no-op
  // edit (case-only or otherwise) doesn't trigger a round-trip.
  const isUnchanged =
    trimmed === (currentDisplayUsername ?? '') &&
    normalized === (currentUsername ?? '');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValid) {
      setError('Use 3-32 characters: letters, numbers, and underscores');
      return;
    }
    if (isUnchanged) return;
    setBusy(true);
    const { error } = await supabase
      .from('profiles')
      .update({ username: normalized, display_username: trimmed })
      .eq('user_id', userId);
    setBusy(false);
    if (error) {
      if (error.code === '23505') {
        setError('That username is taken');
      } else {
        setError(error.message);
      }
      return;
    }
    onUsernameUpdated(trimmed);
    setSavedAt(Date.now());
  }

  return (
    <section className="settings-section">
      <h3>Username</h3>
      <p className="settings-help">
        Shown in the dashboard header. 3–32 characters: letters, numbers, and underscores. The
        username itself is case-insensitive — sign-in matches any case — but the form you type here
        is what the header displays.
      </p>
      <form onSubmit={handleSave} className="settings-username-form">
        <div className="field">
          <label htmlFor="settings-username">Username</label>
          <input
            id="settings-username"
            className="input"
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setSavedAt(null);
            }}
            placeholder="e.g. Alice_42"
            autoComplete="username"
            disabled={busy}
          />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {savedAt && !error && <p className="settings-saved" role="status">Username saved.</p>}
        <div className="settings-section-actions">
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !isValid || isUnchanged}
          >
            {busy ? 'Saving…' : 'Save username'}
          </button>
        </div>
      </form>
    </section>
  );
}
