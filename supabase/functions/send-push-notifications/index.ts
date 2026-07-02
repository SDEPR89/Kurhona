// Supabase Edge Function — Deadline push notification sender
// Deploy: supabase functions deploy send-push-notifications
// Schedule via Supabase Dashboard → Edge Functions → Schedules → "0 * * * *" (every hour)
//
// Required secrets (set via: supabase secrets set KEY=value):
//   VAPID_PUBLIC_KEY   — base64url EC public key (P-256)
//   VAPID_PRIVATE_KEY  — base64url EC private key
//   VAPID_SUBJECT      — mailto: or https: contact URL
//   SUPABASE_URL       — auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// VAPID JWT signing (Web Push protocol)
// ---------------------------------------------------------------------------

function base64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function base64urlEncode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function buildVapidJwt(
  audience: string,    // e.g. https://fcm.googleapis.com
  subject: string,     // mailto: or https:
  privateKeyB64: string,
): Promise<string> {
  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: now + 12 * 3600,
    sub: subject,
  })));

  const signingInput = `${header}.${payload}`;
  const keyBytes = base64urlDecode(privateKeyB64);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    // Wrap raw 32-byte scalar into a PKCS#8 DER structure for P-256
    buildPkcs8(keyBytes),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64urlEncode(sig)}`;
}

/** Wrap a 32-byte EC private scalar into a minimal PKCS#8 DER for P-256 */
function buildPkcs8(rawKey: Uint8Array): ArrayBuffer {
  // PKCS#8 wrapper for prime256v1 private key
  const oid = new Uint8Array([
    0x30, 0x81, 0x87,          // SEQUENCE
      0x02, 0x01, 0x00,        // version = 0
      0x30, 0x13,              // AlgorithmIdentifier SEQUENCE
        0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
      0x04, 0x6d,              // OCTET STRING
        0x30, 0x6b,            // ECPrivateKey SEQUENCE
          0x02, 0x01, 0x01,    // version = 1
          0x04, 0x20,          // OCTET STRING (32 bytes)
  ]);
  const buf = new Uint8Array(oid.length + 32);
  buf.set(oid);
  buf.set(rawKey.slice(0, 32), oid.length);
  return buf.buffer;
}

// ---------------------------------------------------------------------------
// Web Push sender
// ---------------------------------------------------------------------------

async function sendWebPush(opts: {
  endpoint: string;
  p256dh: string;
  authKey: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  payload: { title: string; body: string; icon?: string };
}): Promise<{ ok: boolean; status: number }> {
  const { endpoint, p256dh, authKey, vapidPublicKey, vapidPrivateKey, vapidSubject, payload } = opts;

  // Derive audience from endpoint origin
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;

  const jwt = await buildVapidJwt(audience, vapidSubject, vapidPrivateKey);

  // Encrypt the payload using Web Push content encryption (ECDH + AES-128-GCM)
  const encrypted = await encryptPayload(
    new TextEncoder().encode(JSON.stringify(payload)),
    base64urlDecode(p256dh),
    base64urlDecode(authKey),
  );

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${vapidPublicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
    },
    body: encrypted,
  });

  return { ok: res.ok, status: res.status };
}

/** RFC 8291 / aes128gcm content encryption */
async function encryptPayload(
  plaintext: Uint8Array,
  clientPublicKey: Uint8Array,   // 65-byte uncompressed P-256
  authSecret: Uint8Array,        // 16-byte auth
): Promise<ArrayBuffer> {
  // Generate ephemeral server key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const serverPublicKey = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    'raw', clientPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, [],
  );

  // ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey },
    serverKeyPair.privateKey,
    256,
  );

  // Key derivation (RFC 8291)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdf(authSecret, new Uint8Array(sharedSecret), buildInfo('auth', new Uint8Array(0), new Uint8Array(0)), 32);
  const cek = await hkdf(salt, prk, buildInfo('aesgcm128', new Uint8Array(serverPublicKey), clientPublicKey), 16);
  const nonce = await hkdf(salt, prk, buildInfo('nonce', new Uint8Array(serverPublicKey), clientPublicKey), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);

  // Pad plaintext
  const padLen = 2;
  const padded = new Uint8Array(padLen + plaintext.length);
  new DataView(padded.buffer).setUint16(0, 0); // 2-byte padding length = 0
  padded.set(plaintext, padLen);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded);

  // Build aes128gcm content-coding record
  const rs = 4096;
  const header = new Uint8Array(21 + serverPublicKey.byteLength);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = serverPublicKey.byteLength;
  header.set(new Uint8Array(serverPublicKey), 21);

  const result = new Uint8Array(header.length + ciphertext.byteLength);
  result.set(header);
  result.set(new Uint8Array(ciphertext), header.length);
  return result.buffer;
}

function buildInfo(type: string, serverKey: Uint8Array, clientKey: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(`Content-Encoding: ${type}\0`);
  const contextLen = 1 + 2 + serverKey.length + 2 + clientKey.length;
  const ctx = new Uint8Array(contextLen);
  let off = 0;
  ctx[off++] = 0; // P-256
  new DataView(ctx.buffer).setUint16(off, serverKey.length); off += 2;
  ctx.set(serverKey, off); off += serverKey.length;
  new DataView(ctx.buffer).setUint16(off, clientKey.length); off += 2;
  ctx.set(clientKey, off);
  const info = new Uint8Array(label.length + ctx.length);
  info.set(label); info.set(ctx, label.length);
  return info;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY')!;
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')!;
    const vapidSubject    = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@kurhona.app';

    const now = new Date();

    // Compute target windows (tasks due in ~3 days, ~1 day)
    const windows = [
      { label: '3 days',    days: 3 },
      { label: 'tomorrow',  days: 1 },
      { label: 'today',     days: 0 },
    ];

    let totalSent = 0;

    for (const win of windows) {
      const target = new Date(now);
      target.setDate(target.getDate() + win.days);
      const isoDate = target.toISOString().split('T')[0]; // YYYY-MM-DD

      // Fetch tasks due on this date that aren't complete/submitted
      const { data: tasks } = await supabase
        .from('tasks')
        .select('id, title, user_id, due_date, due_time')
        .eq('due_date', isoDate)
        .is('completed_at', null)
        .neq('status', 'submitted');

      if (!tasks?.length) continue;

      // Group task titles by user_id
      const byUser = new Map<string, string[]>();
      for (const t of tasks) {
        const list = byUser.get(t.user_id) ?? [];
        list.push(t.title);
        byUser.set(t.user_id, list);
      }

      // Fetch subscriptions for these users
      const userIds = [...byUser.keys()];
      const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('user_id, endpoint, p256dh, auth_key')
        .in('user_id', userIds);

      if (!subs?.length) continue;

      for (const sub of subs) {
        const titles = byUser.get(sub.user_id);
        if (!titles) continue;

        const body = titles.length === 1
          ? `${titles[0]} is due ${win.label}`
          : `${titles.length} tasks due ${win.label}: ${titles.slice(0, 2).join(', ')}${titles.length > 2 ? '…' : ''}`;

        const result = await sendWebPush({
          endpoint:        sub.endpoint,
          p256dh:          sub.p256dh,
          authKey:         sub.auth_key,
          vapidPublicKey,
          vapidPrivateKey,
          vapidSubject,
          payload: {
            title: '⏰ Kurhona Reminder',
            body,
            icon: '/favicon.png',
          },
        });

        if (result.ok) {
          totalSent++;
        } else if (result.status === 410 || result.status === 404) {
          // Subscription expired — clean it up
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }
    }

    return new Response(JSON.stringify({ sent: totalSent }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
