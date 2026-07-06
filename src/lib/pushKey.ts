// Convert a VAPID public key from the URL-safe base64 form
// (the output of `web-push generate-vapid-keys`) into a Uint8Array
// suitable for `PushManager.subscribe({ applicationServerKey })`.
//
// The browser's Push API expects a raw byte sequence; base64url
// is the wire format RFC 8292 ships in. We add the standard
// `=` padding, swap `-_` back to `+/`, and decode.
//
// The cast at the end is to satisfy TS 5.7+'s generic
// `Uint8Array<ArrayBufferLike>` typing — `new Uint8Array(N)` infers
// `ArrayBufferLike`, but `applicationServerKey` requires
// `Uint8Array<ArrayBuffer>`. The runtime values are identical.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const normalized = base64String.trim();
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(normalized)) {
    throw new Error(
      'VITE_VAPID_PUBLIC_KEY must be only the VAPID public key, without labels, spaces, or quotes.',
    );
  }
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const base64 = (normalized + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const buf = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < rawData.length; i++) view[i] = rawData.charCodeAt(i);
  return view as Uint8Array<ArrayBuffer>;
}
