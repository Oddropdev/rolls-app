// tools/rls-smoke/seed-check-day19-clickout.mjs
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2] ?? "";
    val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(repoRoot, ".env.local"));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_KEY;

const TEST_GAME_ID = process.env.TEST_GAME_ID;          // uuid
const ALLOWLIST_HOST = process.env.CLICKOUT_ALLOW_HOST; // hostname

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("configuration missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
if (!TEST_GAME_ID || !ALLOWLIST_HOST) {
  console.error("configuration missing: TEST_GAME_ID / CLICKOUT_ALLOW_HOST");
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function hostnameOf(url) {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

(async () => {
  try {
    // Seed “proof” via RPC boundary: mint -> burn => verifies redirects + allow_hosts in one go.
    const { data: ticket, error: mintErr } = await supabase.rpc("mint_clickout_ticket", {
      p_game_id: TEST_GAME_ID,
      p_operator_id: null,
      p_slot: "main",
    });

    if (mintErr || !ticket) {
      console.error("configuration missing: mint failed");
      process.exit(1);
    }

    const { data: burnData, error: burnErr } = await supabase.rpc("burn_clickout_ticket", {
      p_ticket: ticket,
    });

    if (burnErr || !burnData?.redirect_url) {
      console.error("configuration missing: burn failed");
      process.exit(1);
    }

    const host = hostnameOf(burnData.redirect_url);
    if (host !== ALLOWLIST_HOST) {
      console.error(
        "configuration missing:",
        JSON.stringify({ expected: ALLOWLIST_HOST, got: host, redirect_url: burnData.redirect_url }, null, 2)
      );
      process.exit(1);
    }

    console.log("seed-check ok");
    process.exit(0);
  } catch (e) {
    console.error("seed-check error:", e?.message ?? e);
    process.exit(1);
  }
})();
