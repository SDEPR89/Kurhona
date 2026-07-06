// ---------------------------------------------------------------------------
// scripts/push-test/list-subs.mjs
//
// Prints all push subscriptions currently in the database, with the
// user_id, endpoint host, and a redacted endpoint for sanity-checking.
// ---------------------------------------------------------------------------

import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});

const { data, error } = await admin
  .from("push_subscriptions")
  .select("id, user_id, endpoint, user_agent, created_at")
  .order("created_at", { ascending: false });

if (error) {
  console.error("read-failed:", error.message);
  process.exit(1);
}

if (!data || data.length === 0) {
  console.log("No subscriptions registered yet.");
  console.log("(Open the app → Settings → enable Reminders to create one.)");
  process.exit(0);
}

console.log(`${data.length} subscription(s):\n`);
for (const s of data) {
  const host = new URL(s.endpoint).host;
  const ua = s.user_agent ?? "?";
  console.log(`  user:  ${s.user_id}`);
  console.log(`  host:  ${host}`);
  console.log(`  ua:    ${ua.slice(0, 80)}${ua.length > 80 ? "…" : ""}`);
  console.log(`  since: ${s.created_at}`);
  console.log();
}
