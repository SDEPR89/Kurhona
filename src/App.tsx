import { useCallback, useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import { LoginPage } from './components/LoginPage';
import { Dashboard } from './components/Dashboard';
import { ResetPassword } from './components/ResetPassword';
import { ConfirmingPage } from './components/ConfirmingPage';
import { ConfirmProvider } from './hooks/useConfirm';
import { useToast } from './hooks/useToast';
import './App.css';

// True when the current URL carries a Supabase recovery token. Supabase puts
// the recovery marker in the URL hash (`#type=recovery`) for implicit flows
// and in the query string (`?type=recovery`) for PKCE flows. We strip the
// marker from the URL after detecting it so a page refresh doesn't keep
// re-entering the reset view.
function detectRecoveryInUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const queryParams = new URLSearchParams(window.location.search);
  const isRecovery =
    hashParams.get('type') === 'recovery' || queryParams.get('type') === 'recovery';
  if (isRecovery) {
    // Clean the URL so reloads don't keep us in the reset view after the
    // user has finished (and so the tokens don't linger in browser history).
    const cleanUrl = window.location.pathname + window.location.search.replace(/type=recovery&?/, '').replace(/[?&]$/, '');
    window.history.replaceState({}, '', cleanUrl || '/');
  }
  return isRecovery;
}

// True when the current URL carries a Supabase signup-confirmation token.
// Same hash/query split as recovery — PKCE uses `?type=signup&...` (the
// SDK exchanges the `code` for a session), implicit uses `#type=signup`
// (tokens land directly in the hash). We strip the marker so a reload
// doesn't keep bouncing the user into the confirming view after they've
// already been signed in.
function detectSignupConfirmationInUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const queryParams = new URLSearchParams(window.location.search);
  const isSignupConfirm =
    hashParams.get('type') === 'signup' || queryParams.get('type') === 'signup';
  if (isSignupConfirm) {
    const cleanUrl =
      window.location.pathname +
      window.location.search.replace(/type=signup&?/, '').replace(/[?&]$/, '') +
      window.location.hash;
    window.history.replaceState({}, '', cleanUrl || '/');
  }
  return isSignupConfirm;
}

export default function App() {
  const [user, setUser] = useState<
    {
      id: string;
      email: string | null;
      username: string | null;
      displayUsername: string | null;
      // True when the user signed in anonymously (no email/password
      // attached). The dashboard surfaces an "Upgrade account" path
      // so they can recover their data later — anonymous sessions
      // are tied to the local auth token, so a browser data wipe
      // makes the account unrecoverable.
      isAnonymous: boolean;
    } | null
  >(null);
  const [ready, setReady] = useState(false);
  // 'reset' forces the ResetPassword screen even though a session exists,
  // so a freshly-arrived recovery link can never silently drop the user into
  // the dashboard without setting a new password first.
  // 'confirming' is the brief "Confirming your account…" view shown after
  // the user clicks the link in their signup confirmation email. The
  // Supabase SDK processes the URL token in the background; once we get
  // a SIGNED_IN event we transition to 'app'.
  const [mode, setMode] = useState<'app' | 'reset' | 'confirming'>('app');
  // True once the SDK has produced a session during the confirming flow.
  // Drives a copy swap in <ConfirmingPage> — once we know Supabase
  // accepted the token, "Verifying link…" becomes "Establishing secure
  // session…" (a hint that the hard part is over and the dashboard is
  // about to load).
  const [confirmingSessionSeen, setConfirmingSessionSeen] = useState(false);
  // True if the confirming flow runs longer than the timeout. Drives
  // the error state in <ConfirmingPage>.
  const [confirmingTimedOut, setConfirmingTimedOut] = useState(false);
  const toast = useToast();

  // Look up the username for a given auth user. We treat the username as
  // best-effort display data: if the profile row is missing (e.g. the user
  // was created before this feature shipped, or the trigger hasn't fired
  // yet), we fall back to null and the dashboard shows the email. The
  // user is still functional — they just don't get a pretty header yet.
  //
  // Returns the lowercased canonical `username` (used for sign-in
  // matching) and the case-preserving `display_username` (used in the
  // header). For accounts created before display_username existed, the
  // backfill populates it from `username`, but if the caller still sees
  // null we let the UI fall back to `username`.
  const fetchProfile = useCallback(async (userId: string): Promise<{ username: string | null; displayUsername: string | null }> => {
    const { data, error } = await supabase
      .from('profiles')
      .select('username, display_username')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      // Surface a toast so the user knows the header may show email
      // instead of username, instead of failing silently.
      toast.showError("Couldn't load your username. Some features may be limited.");
      return { username: null, displayUsername: null };
    }
    return {
      username: data?.username ?? null,
      displayUsername: data?.display_username ?? null,
    };
  }, [toast]);

  const setUserFromSession = useCallback(
    async (sess: { user: { id: string; email?: string | null; is_anonymous?: boolean } } | null) => {
      if (!sess) {
        setUser(null);
        return;
      }
      // Anonymous users don't have a profiles row (the trigger skips
      // insertion when raw_user_meta_data->>'username' is NULL).
      // Skip the profile lookup entirely — it's guaranteed to 404 —
      // and pass through is_anonymous so the dashboard can offer
      // the upgrade flow.
      if (sess.user.is_anonymous) {
        setUser({
          id: sess.user.id,
          email: null,
          username: null,
          displayUsername: null,
          isAnonymous: true,
        });
        return;
      }
      const { username, displayUsername } = await fetchProfile(sess.user.id);
      setUser({
        id: sess.user.id,
        email: sess.user.email ?? null,
        username,
        displayUsername,
        isAnonymous: false,
      });
    },
    [fetchProfile],
  );

  useEffect(() => {
    // If we landed on the page from a recovery email link, drop straight into
    // the reset view. The SDK will parse the hash and create a session for us.
    if (detectRecoveryInUrl()) setMode('reset');

    // If we landed from a signup confirmation link, show the "Confirming
    // your account…" screen while the SDK exchanges the PKCE code (or
    // accepts the implicit-flow tokens) for a session. The actual
    // transition to the dashboard happens when SIGNED_IN fires below.
    const isSignupConfirm = detectSignupConfirmationInUrl();
    if (isSignupConfirm) {
      setMode('confirming');
      setConfirmingSessionSeen(false);
      setConfirmingTimedOut(false);
    }

    // Initial session
    supabase.auth.getSession().then(async ({ data }) => {
      await setUserFromSession(data.session);
      setReady(true);
    });

    // Listen for sign-in / sign-out / token refresh.
    // Important: even though the SDK auto-refreshes the access token, if the
    // refresh token is rejected (e.g. expired, revoked, password reset) the
    // session becomes invalid and we need to drop the user — otherwise the UI
    // keeps rendering with a dead token and every query 401s.
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (event === 'SIGNED_OUT') {
        setUser(null);
        setMode('app');
        return;
      }
      if (event === 'TOKEN_REFRESHED' && !sess) {
        // Refresh attempted but no session came back — treat as signed out.
        setUser(null);
        return;
      }
      if (event === 'PASSWORD_RECOVERY') {
        // The user just clicked a recovery link — force the reset screen
        // even if the URL hash was already stripped by a router/redirect.
        setMode('reset');
        if (sess) {
          // Fire and forget: we don't have to wait on the username lookup
          // before showing the reset screen. The reset view doesn't use it.
          setUserFromSession(sess);
        }
        return;
      }
      // During the signup-confirmation flow, flag that we've seen the
      // session at least once so <ConfirmingPage> can swap its copy.
      // The transition to 'app' happens here — once a session lands,
      // there's no reason to keep the spinner up while we wait for
      // the username lookup. setUserFromSession is fire-and-forget
      // because the render branches handle `user` becoming truthy on
      // its own.
      if (isSignupConfirm && event === 'SIGNED_IN' && sess) {
        setConfirmingSessionSeen(true);
        setMode('app');
      }
      setUserFromSession(sess);
    });

    // Safety net: if the SDK never produces a session (link expired,
    // user opened it on a different device, network blocked), give up
    // after 15s and surface the error state. Without this the spinner
    // would spin forever — particularly bad on the user's first
    // account, where they might think the link is broken.
    let timeoutId: number | undefined;
    if (isSignupConfirm) {
      timeoutId = window.setTimeout(() => {
        setConfirmingTimedOut(true);
        // Drop back to 'app' so the user sees the login screen with
        // a useful affordance (the "Back to sign in" button in the
        // error state). The auth listener will continue running;
        // if the SDK eventually produces a session, the
        // SIGNED_IN branch above will still move us into the
        // dashboard.
        setMode((m) => (m === 'confirming' ? 'app' : m));
      }, 15_000);
    }

    // Cross-tab sync: if the user signs out in another tab, this tab should
    // also drop the session immediately. Supabase writes to localStorage;
    // the 'storage' event fires in *other* tabs only.
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith('sb-') && e.key.endsWith('-auth-token') && !e.newValue) {
        // Token was removed in another tab — sign out locally.
        setUser(null);
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener('storage', onStorage);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, []);

  const onSignOut = useCallback(async () => {
    try {
      // scope: 'global' revokes the refresh token across ALL tabs/devices, so
      // a refresh in another tab won't silently re-sign-in the user.
      await supabase.auth.signOut({ scope: 'global' });
    } catch {
      // The sign-out RPC itself failed (e.g. network down, Supabase
      // unreachable). The local session is still valid, so the user
      // remains logged in client-side. Tell them rather than failing
      // silently.
      toast.showError("Couldn't sign you out. Please try again.");
    }
  }, [toast]);

  // Update the cached username after a successful rename from the
  // settings modal. The profiles row has already been written by the
  // modal — we just need to keep the header in sync without a reload.
  // Both fields are updated: `username` is the canonical lowercased
  // form, `displayUsername` is what the user typed. No-op for
  // anonymous users (the settings modal hides the rename UI for
  // them, so this branch shouldn't fire — the guard is defensive).
  const handleUsernameUpdated = useCallback((displayUsername: string) => {
    setUser((prev) =>
      prev && !prev.isAnonymous
        ? { ...prev, username: displayUsername.toLowerCase(), displayUsername }
        : prev,
    );
  }, []);

  // Account deletion. The RPC already wiped auth.users; we just need to
  // drop the local session so the auth listener stops seeing a session
  // and the dashboard unmounts. `signOut` also fires SIGNED_OUT, which
  // takes us back to the LoginPage via the existing listener path.
  const handleAccountDeleted = useCallback(async () => {
    await onSignOut();
  }, [onSignOut]);

  // Anonymous upgrade: the user attached an email + password in the
  // settings modal and Supabase has re-issued a regular session. We
  // re-run the full profile lookup so the new username (set as a
  // placeholder by the upgrade flow) lands in the header, and flip
  // the local user from anonymous to a real account.
  const handleAccountUpgraded = useCallback(
    async (_newEmail: string) => {
      // Re-fetch the session so we pick up the new email + the
      // is_anonymous flag flipping to false.
      const { data } = await supabase.auth.getSession();
      const sess = data.session;
      if (!sess) return;
      // Anonymous branch is gone now — go through the regular
      // profile-lookup path so the placeholder username set by
      // the upgrade flow is reflected in the header.
      await setUserFromSession(sess);
    },
    [setUserFromSession],
  );

  // Called by ResetPassword once a new password has been accepted. The
  // session that arrived with the recovery link is now a regular session,
  // so it's safe to show the dashboard.
  const onResetComplete = useCallback(() => {
    setMode('app');
  }, []);

  // If the user cancels the reset (e.g. "Send a new reset link"), drop the
  // stale recovery session and bounce them back to the login page.
  const onResetCancel = useCallback(async () => {
    setMode('app');
    setUser(null);
    try {
      await supabase.auth.signOut({ scope: 'global' });
    } catch {
      // Same rationale as onSignOut: if this fails, the recovery
      // session is still alive. Surface it.
      toast.showError("Couldn't sign you out. Please try again.");
    }
  }, [toast]);

  // Don't flash the wrong screen while we're still figuring out the session.
  if (!ready) {
    return (
      <ConfirmProvider>
        <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: 'var(--muted)' }}>
          Loading…
        </div>
      </ConfirmProvider>
    );
  }

  // ResetPassword must be checked before the !user check: a recovery link
  // creates a session for us, so `user` is set, but we still want to demand
  // a new password before granting access to the dashboard.
  if (mode === 'reset') {
    return (
      <ConfirmProvider>
        <ResetPassword onComplete={onResetComplete} onCancel={onResetCancel} />
      </ConfirmProvider>
    );
  }

  // Confirming screen takes precedence over the !user check too:
  // during the signup-confirmation flow `user` is null until SIGNED_IN
  // fires, but we want to keep the spinner up while we wait rather
  // than flashing the login screen.
  if (mode === 'confirming') {
    return (
      <ConfirmProvider>
        <ConfirmingPage
          sessionEstablished={confirmingSessionSeen}
          timedOut={confirmingTimedOut}
          onCancel={() => {
            setMode('app');
            setConfirmingTimedOut(false);
          }}
        />
      </ConfirmProvider>
    );
  }

  if (!user) {
    return (
      <ConfirmProvider>
        <LoginPage />
      </ConfirmProvider>
    );
  }

  return (
    <ConfirmProvider>
      <Dashboard
        userId={user.id}
        userEmail={user.email}
        userUsername={user.username}
        userDisplayUsername={user.displayUsername}
        isAnonymous={user.isAnonymous}
        onSignOut={onSignOut}
        onUsernameUpdated={handleUsernameUpdated}
        onAccountDeleted={handleAccountDeleted}
        onAccountUpgraded={handleAccountUpgraded}
      />
    </ConfirmProvider>
  );
}
