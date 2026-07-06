// ---------------------------------------------------------------------------
// scripts/push-test/send-once.mjs
//
// Local Node harness that mirrors the logic of the `send-push` Edge
// Function. Used to test Web Push delivery end-to-end against the real
// FCM / Mozilla / Apple push services without needing to deploy the
// function to Supabase first.
//
// The function will run the same code path (same `web-push` package,
// same VAPID keys, same payload shape) once it's deployed, so anything
// that works here will work there.
//
// Usage:
//   # dry run: list what would be sent
//   node scripts/push-test/send-once.mjs --dry
//
//   # actually send
//   node scripts/push-test/send-once.mjs
//
// Required env (set in .env.local or pass inline):
//   SUPABASE_URL       e.g. https://your-project.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT      e.g. mailto:you@example.com
// ---------------------------------------------------------------------------

import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import WebSocket from "ws";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const vapidPublic = process.env.VAPID_PUBLIC_KEY;
const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT;

for (const [name, val] of Object.entries({
  SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  VAPID_PUBLIC_KEY: vapidPublic,
  VAPID_PRIVATE_KEY: vapidPrivate,
  VAPID_SUBJECT: vapidSubject,
})) {
  if (!val) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
}

const subject = vapidSubject.startsWith("mailto:") || vapidSubject.startsWith("https://")
  ? vapidSubject
  : `mailto:${vapidSubject}`;

webpush.setVapidDetails(subject, vapidPublic, vapidPrivate);

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});

const dry = process.argv.includes("--dry");

console.log(dry ? "DRY RUN — nothing will be sent" : "LIVE RUN — pushes will be delivered");
console.log(`Supabase: ${url}`);
console.log(`Subject:  ${subject}`);
console.log();

const { data: rows, error: rowsErr } = await admin
  .from("notification_log")
  .select("task_id, user_id, tier, tasks!inner(title)")
  .is("sent_at", null)
  .limit(100);

if (rowsErr) {
  console.error("log-read-failed:", rowsErr.message);
  process.exit(1);
}

if (!rows || rows.length === 0) {
  console.log("Nothing to send (no unsent log rows).");
  process.exit(0);
}

console.log(`Found ${rows.length} unsent log row(s):`);
for (const r of rows) {
  console.log(`  - task=${r.tasks.title} tier=${r.tier} user=${r.user_id.slice(0, 8)}…`);
}
console.log();

const userIds = [...new Set(rows.map((r) => r.user_id))];
const { data: subs, error: subsErr } = await admin
  .from("push_subscriptions")
  .select("endpoint, p256dh, auth, user_id")
  .in("user_id", userIds);

if (subsErr) {
  console.error("sub-read-failed:", subsErr.message);
  process.exit(1);
}

if (!subs || subs.length === 0) {
  console.log("No subscriptions registered for these users.");
  console.log("(Marking log rows as sent so they don't queue forever.)");
  if (!dry) await markSent(admin, rows);
  process.exit(0);
}

console.log(`Found ${subs.length} subscription(s) for ${userIds.length} user(s).`);
console.log();

const subsByUser = new Map();
for (const s of subs) {
  const list = subsByUser.get(s.user_id) ?? [];
  list.push(s);
  subsByUser.set(s.user_id, list);
}

const sentKeys = new Set();
const deadSubs = new Set();

for (const row of rows) {
  const userSubs = subsByUser.get(row.user_id) ?? [];
  if (userSubs.length === 0) {
    console.log(`  [skip] ${row.tasks.title} (${row.tier}) — no subscription for this user`);
    continue;
  }
  for (const sub of userSubs) {
    const prefix =
      row.tier === "3d" ? "Due in 3 days"
      : row.tier === "1d" ? "Due tomorrow"
      : "Due in 1 hour";
    const payload = JSON.stringify({
      title: "Kurhona",
      body: `${prefix}: ${row.tasks.title}`,
      tag: `kurhona-${row.tier}-${row.task_id}`,
      data: { task_id: row.task_id, tier: row.tier, url: "/" },
    });
    const endpoint = sub.endpoint.replace(/^https?:\/\/[^/]+\//, "…/");
    if (dry) {
      console.log(`  [dry] would send to ${endpoint}`);
      sentKeys.add(`${row.task_id}|${row.tier}`);
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 86400 },
      );
      console.log(`  [ok]   ${row.tasks.title} (${row.tier}) → ${endpoint}`);
      sentKeys.add(`${row.task_id}|${row.tier}`);
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        console.log(`  [dead] ${row.tasks.title} (${row.tier}) → ${endpoint} (${status})`);
        deadSubs.add(sub.endpoint);
      } else {
        const detail = [
          err?.message,
          status ? `status=${status}` : null,
          err?.body ? `body=${String(err.body).slice(0, 500)}` : null,
        ].filter(Boolean).join(" ");
        console.error(`  [err]  ${row.tasks.title} (${row.tier}) → ${endpoint}: ${detail || err}`);
      }
    }
  }
}

if (!dry) {
  if (sentKeys.size) {
    await markSent(
      admin,
      rows.filter((r) => sentKeys.has(`${r.task_id}|${r.tier}`)),
    );
    console.log(`\nMarked ${sentKeys.size} log row(s) as sent.`);
  }
  if (deadSubs.size) {
    await admin.from("push_subscriptions").delete().in("endpoint", [...deadSubs]);
    console.log(`Removed ${deadSubs.size} dead subscription(s).`);
  }
}

async function markSent(admin, rows) {
  const now = new Date().toISOString();
  await Promise.all(
    rows.map((r) =>
      admin
        .from("notification_log")
        .update({ sent_at: now })
        .eq("task_id", r.task_id)
        .eq("tier", r.tier),
    ),
  );
}
