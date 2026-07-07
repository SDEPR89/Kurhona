import { useEffect } from 'react';
import { SessionSection } from './settings/SessionSection';
import { UsernameSection } from './settings/UsernameSection';
import { PasswordSection } from './settings/PasswordSection';
import { DeleteAccountSection } from './settings/DeleteAccountSection';
import { UpgradeAccountSection } from './settings/UpgradeAccountSection';

interface Props {
  userId: string;
  userEmail: string | null;
  currentUsername: string | null;
  currentDisplayUsername: string | null;
  isAnonymous: boolean;
  onClose: () => void;
  onUsernameUpdated: (newDisplayUsername: string) => void;
  onAccountDeleted: () => void;
  onAccountUpgraded: (newEmail: string) => void;
}

// Modal chrome (Escape-to-close, body-scroll lock, backdrop click)
// matches the pattern in TaskModal. Each section is a self-
// contained file under ./settings/.
export function SettingsModal({
  userId,
  userEmail,
  currentUsername,
  currentDisplayUsername,
  isAnonymous,
  onClose,
  onUsernameUpdated,
  onAccountDeleted,
  onAccountUpgraded,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal settings-modal">
        <header className="modal-header">
          <h2 id="settings-modal-title">Settings</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="settings-modal-body">
          {/* Session is always on top. For anonymous users the
              Username / Password / Delete sections are replaced by
              UpgradeAccountSection, which itself contains its own
              danger-tinted DeleteAccountSection. */}
          <SessionSection
            userEmail={userEmail}
            currentUsername={currentUsername}
            currentDisplayUsername={currentDisplayUsername}
            isAnonymous={isAnonymous}
          />
          {isAnonymous ? (
            <UpgradeAccountSection
              onAccountUpgraded={onAccountUpgraded}
              onAccountDeleted={onAccountDeleted}
            />
          ) : (
            <>
              <UsernameSection
                userId={userId}
                currentUsername={currentUsername}
                currentDisplayUsername={currentDisplayUsername}
                onUsernameUpdated={onUsernameUpdated}
              />
              <PasswordSection userEmail={userEmail} />
              <DeleteAccountSection
                userEmail={userEmail}
                onAccountDeleted={onAccountDeleted}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
