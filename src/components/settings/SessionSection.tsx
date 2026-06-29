import { useState } from 'react';

// ---------------------------------------------------------------------------
// SessionSection — sits at the top of the modal because sign-out is
// a frequent, non-destructive action users want one tap from. We
// contrast it with Delete account (in a danger-tinted card at the
// bottom) so the two destructive-feeling actions don't read as
// equivalent. For anonymous users, signing out also works — it
// clears the anonymous session; their tasks/subjects survive in
// the DB, but they'll need to "Continue as guest" again from a
// fresh browser session to see them.
// ---------------------------------------------------------------------------

interface Props {
  userEmail: string | null;
  currentUsername: string | null;
  // Case-preserving form of the username (what the header shows).
  currentDisplayUsername: string | null;
  isAnonymous: boolean;
  onClose: () => void;
  onSignOut: () => void;
}

export function SessionSection({
  userEmail,
  currentUsername,
  currentDisplayUsername,
  isAnonymous,
  onClose,
  onSignOut,
}: Props) {
  // Local busy state so we can disable + re-label the button while
  // the sign-out round-trip is in flight. Dashboard already tracks
  // the same `signingOut` flag; we mirror it here for the button's
  // own UI affordance without coupling the two components.
  const [busy, setBusy] = useState(false);

  // For real accounts, show the email (the unique identifier). For
  // anonymous users show "Guest" — there's no other identity to
  // surface and the upgrade CTA below explains how to convert
  // this session.
  const identity = isAnonymous
    ? 'Guest'
    : userEmail ?? currentDisplayUsername ?? currentUsername ?? '';

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    try {
      // Close the modal first so the user doesn't see the modal
      // fade against a now-signed-out dashboard during the
      // in-flight round-trip. Dashboard's onSignOut handles
      // editing/settings state cleanup; App.tsx flips the local
      // user back to LoginPage once SIGNED_OUT fires.
      onClose();
      await onSignOut();
    } finally {
      // Defensive: if the parent unmounts cleanly there's nothing
      // left to reset, but if a parent swallows the error and we
      // stay mounted, leave the button re-enabled so the user can
      // retry.
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>Session</h3>
      <p className="settings-help">
        {isAnonymous
          ? 'You’re signed in as a guest. Sign out to end this browser session — your data is kept and you can sign back in as a guest from this device, or upgrade below to use this account on any device.'
          : `Signed in as ${identity}.`}
      </p>
      <div className="settings-section-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={handleSignOut}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </section>
  );
}
