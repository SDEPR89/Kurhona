import { useState } from 'react';
import { supabase } from '../../lib/supabase';

// ---------------------------------------------------------------------------
// DeleteAccountSection — three independent checks before the button
// enables: understood checkbox, type email (real accounts only),
// type DELETE. Defense against a user reflexively tapping through.
// ---------------------------------------------------------------------------

interface Props {
  userEmail: string | null;
  onAccountDeleted: () => void;
}

export function DeleteAccountSection({ userEmail, onAccountDeleted }: Props) {
  const [understood, setUnderstood] = useState(false);
  const [emailConfirm, setEmailConfirm] = useState('');
  const [deletePhrase, setDeletePhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Anonymous accounts don't have an email on file, so the email-
  // confirmation step is meaningless for them — they confirm via
  // "DELETE" + the checkbox only. For real accounts both checks
  // are required (defense against the user accidentally typing
  // DELETE without thinking).
  const isAnonymous = !userEmail;
  const emailMatches = isAnonymous || emailConfirm.trim() === userEmail;
  const phraseMatches = deletePhrase.trim() === 'DELETE';
  const ready = understood && emailMatches && phraseMatches;

  async function handleDelete() {
    if (!ready) return;
    setError(null);
    setBusy(true);
    const { error } = await supabase.rpc('delete_own_account');
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    onAccountDeleted();
  }

  return (
    <section className="settings-section settings-danger">
      <h3>Delete account</h3>
      <p className="settings-help">
        Permanently removes your account, username, subjects, and tasks. This cannot be undone.
      </p>
      <ul className="settings-delete-checklist">
        <li>
          <label className="settings-delete-check">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              disabled={busy}
            />
            <span>I understand this permanently deletes my account and all data.</span>
          </label>
        </li>
        <li>
          {!isAnonymous && (
            <div className="field">
              <label htmlFor="settings-delete-email">Type your email to confirm</label>
              <input
                id="settings-delete-email"
                className="input"
                type="email"
                value={emailConfirm}
                onChange={(e) => setEmailConfirm(e.target.value)}
                placeholder={userEmail ?? ''}
                autoComplete="off"
                disabled={busy}
              />
            </div>
          )}
        </li>
        <li>
          <div className="field">
            <label htmlFor="settings-delete-phrase">Type the word DELETE</label>
            <input
              id="settings-delete-phrase"
              className="input"
              type="text"
              value={deletePhrase}
              onChange={(e) => setDeletePhrase(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
              disabled={busy}
            />
          </div>
        </li>
      </ul>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="settings-section-actions">
        <button
          type="button"
          className="btn-danger"
          onClick={handleDelete}
          disabled={!ready || busy}
        >
          {busy ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </section>
  );
}
