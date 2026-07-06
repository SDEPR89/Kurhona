// ---------------------------------------------------------------------------
// scripts/push-test/load-env.mjs
//
// Tiny dotenv loader for the test harness. Reads .env.test from the
// project root if it exists, then merges over process.env (env vars
// always win). Imported as the first line of every push-test script.
//
// We don't pull in a dotenv dep for this — the .env.test format is
// the same flat KEY=VALUE the Supabase JS client uses, so we just
// hand-parse.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");

for (const path of [".env.test", ".env"]) {
  try {
    const text = readFileSync(resolve(projectRoot, path), "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // file missing is fine
  }
}
