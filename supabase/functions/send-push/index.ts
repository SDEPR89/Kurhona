// ---------------------------------------------------------------------------
// send-push — Edge Function that fans out due-task reminders to
// browser push subscriptions.
//
// Called hourly by the `queue-due-reminders` pg_cron job via
// pg_net.http_post. The job body passes an empty JSON payload; this
// function reads unsent rows from `notification_log` and looks up
// matching `push_subscriptions` to send to.
//
// Auth: shared bearer token set as Supabase secret SHARED_CRON_SECRET.
// The same value is stored in the `app.send_push_key` GUC the cron
// reads from, so the cron never sees the secret in plaintext SQL.
//
// Uses the npm `web-push` package for VAPID signing + aes128gcm
// body encryption. Hand-rolling this is risky — the WebCrypto API
// returns DER-encoded ECDSA signatures while VAPID requires raw
// r||s, and the encryption is ~80 lines of code that has to match
// RFC 8188 byte-for-byte. The `web-push` package is the only
// well-tested reference implementation; Deno's Edge Function
// runtime provides the Node compat layer (`http2`, `crypto.create*`)
// that it needs.
// ---------------------------------------------------------------------------

// @ts-ignore — Deno resolves `npm:` specifiers at runtime.
import webpush from "npm:web-push@3.6.7";

interface LogRow {
  task_id: string;
  user_id: string;
  tier: "3d" | "1d" | "1h";
  tasks: { title: string };
}
interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("SHARED_CRON_SECRET");
  if (!secret) return new Response("server-misconfigured", { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY")!;
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY")!;
  const vapidSubject = Deno.env.get("VAPID_SUBJECT")!;

  // Configure web-push once per cold start. The subject must be
  // either `mailto:…` or `https://…` per RFC 8292; we accept a bare
  // email and prepend the prefix defensively.
  const subject = vapidSubject.startsWith("mailto:") || vapidSubject.startsWith("https://")
    ? vapidSubject
    : `mailto:${vapidSubject}`;
  webpush.setVapidDetails(subject, vapidPublic, vapidPrivate);

  // Admin client bypasses RLS. We only touch rows the cron and the
  // user's own subscription handler have written.
  const { createClient } = await import("jsr:@supabase/supabase-js@2");
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // 1. Pull unsent log rows + task titles. Bounded so a backlog
  //    doesn't OOM the function; the next hourly tick picks up
  //    anything that overflows.
  const { data: rows, error: rowsErr } = await admin
    .from("notification_log")
    .select("task_id, user_id, tier, tasks!inner(title)")
    .is("sent_at", null)
    .limit(100);
  if (rowsErr) return new Response(`log-read-failed: ${rowsErr.message}`, { status: 500 });
  if (!rows || rows.length === 0) return new Response("noop", { status: 200 });

  // 2. Fetch every subscription for the users we have rows for.
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: subs, error: subsErr } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth, user_id")
    .in("user_id", userIds);
  if (subsErr) return new Response(`sub-read-failed: ${subsErr.message}`, { status: 500 });
  if (!subs || subs.length === 0) {
    // Subscriptions haven't been registered yet (or have all been
    // deleted). Mark the log rows as sent so they don't queue forever.
    await markSent(admin, rows);
    return new Response("no-subs", { status: 200 });
  }

  // 3. Fan out. For each (row, sub) where sub.user_id === row.user_id.
  const sentKeys = new Set<string>();
  const deadSubs = new Set<string>();
  const subsByUser = new Map<string, SubRow[]>();
  for (const s of subs) {
    const list = subsByUser.get(s.user_id) ?? [];
    list.push(s);
    subsByUser.set(s.user_id, list);
  }
  for (const row of rows) {
    const userSubs = subsByUser.get(row.user_id) ?? [];
    for (const sub of userSubs) {
      const result = await sendOne(sub, row);
      if (result === "ok") sentKeys.add(`${row.task_id}|${row.tier}`);
      else if (result === "dead") deadSubs.add(sub.endpoint);
      // 'transient' → leave the log row unsent; the next hourly
      // tick will retry it. Push services rate-limit 5xx, so
      // re-queueing is the right move.
    }
  }

  // 4. Persist outcomes.
  if (sentKeys.size) {
    await markSent(admin, rows.filter((r) => sentKeys.has(`${r.task_id}|${r.tier}`)));
  }
  if (deadSubs.size) {
    const { error: delErr } = await admin
      .from("push_subscriptions")
      .delete()
      .in("endpoint", [...deadSubs]);
    if (delErr) console.error("delete-dead-subs failed", delErr);
  }
  return new Response(`ok sent=${sentKeys.size} dead=${deadSubs.size}`, { status: 200 });
});

// ---------------------------------------------------------------------------

type Result = "ok" | "dead" | "transient";

async function sendOne(
  sub: SubRow,
  row: LogRow,
): Promise<Result> {
  // Tier → human-readable prefix in the notification body.
  const prefix = row.tier === "3d"
    ? "Due in 3 days"
    : row.tier === "1d"
    ? "Due tomorrow"
    : "Due in 1 hour";
  const payload = JSON.stringify({
    title: "Kurhona",
    body: `${prefix}: ${row.tasks.title}`,
    // Tagging dedupes the system tray — if Chrome/Firefox already
    // showed this notification, the new arrival replaces the old
    // one instead of stacking.
    tag: `kurhona-${row.tier}-${row.task_id}`,
    data: { task_id: row.task_id, tier: row.tier, url: "/" },
  });

  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      payload,
      { TTL: 86400 },
    );
    return "ok";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      // The user revoked the subscription in their browser/OS.
      return "dead";
    }
    console.error("push send failed", { endpoint: sub.endpoint, status, err });
    return "transient";
  }
}

async function markSent(
  admin: ReturnType<typeof Object>,
  rows: LogRow[],
): Promise<void> {
  // Bounded by the limit above (100). 100 round-trips is fine and
  // clearer than the case-expression alternative.
  const now = new Date().toISOString();
  await Promise.all(
    rows.map((r) =>
      admin
        .from("notification_log")
        .update({ sent_at: now })
        .eq("task_id", r.task_id)
        .eq("tier", r.tier)
    ),
  );
}
