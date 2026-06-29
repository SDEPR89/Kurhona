import { supabase } from '../../lib/supabase';

// Kept in sync with the signup form in LoginPage.tsx. Accepts upper- and
// lowercase letters plus digits/underscores, 3-32 chars. We normalize
// (trim + lowercase) before sending so the displayed value may be
// `Alice_42` while the stored value is `alice_42`. The `citext` column
// in `profiles` makes the collision check case-insensitive on the
// server side too. Extracting to a shared util is a follow-up — for now
// the comment is the contract.
export const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN = 8;

export function normalizeUsername(s: string): string {
  return s.trim().toLowerCase();
}

export type Provider = 'email' | 'google' | 'github' | 'unknown';

// Pull from the active user object so we don't trigger a network
// round-trip. `getUser()` validates the JWT locally; cheaper than
// fetching fresh. Used by the Password section to know whether to
// render the OAuth-only reset-email path.
export async function detectProvider(): Promise<Provider> {
  const { data } = await supabase.auth.getUser();
  const provider = (data.user?.app_metadata?.provider ?? 'email') as string;
  if (provider === 'google' || provider === 'github' || provider === 'email') {
    return provider;
  }
  return 'unknown';
}
