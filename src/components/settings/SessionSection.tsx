// ---------------------------------------------------------------------------
// SessionSection — sits at the top of the modal to show current identity
// and provide a Sign Out button (visible on all screen sizes).
// ---------------------------------------------------------------------------

interface Props {
  userEmail: string | null;
  currentUsername: string | null;
  // Case-preserving form of the username (what the header shows).
  currentDisplayUsername: string | null;
  isAnonymous: boolean;
  onSignOut: () => void;
}

export function SessionSection({
  userEmail,
  currentUsername,
  currentDisplayUsername,
  isAnonymous,
  onSignOut,
}: Props) {
  const identity = isAnonymous
    ? 'Guest'
    : userEmail ?? currentDisplayUsername ?? currentUsername ?? '';

  return (
    <section className="settings-section">
      <h3>Session</h3>
      <p className="settings-help">
        {isAnonymous
          ? "You're signed in as a guest. Your tasks save to this browser only. Upgrade below to sync across devices."
          : `Signed in as ${identity}.`}
      </p>
      <button
        type="button"
        className="btn-secondary"
        onClick={onSignOut}
        style={{ marginTop: '8px' }}
      >
        Sign out
      </button>
    </section>
  );
}
