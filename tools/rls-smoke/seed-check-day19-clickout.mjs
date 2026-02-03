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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TEST_GAME_ID = process.env.TEST_GAME_ID;            // uuid
const ALLOWLIST_HOST = process.env.CLICKOUT_ALLOW_HOST;   // hostname only

function die(msg) {
  console.error(msg);
  process.exit(2);
}

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  die("configuration missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
}
if (!TEST_GAME_ID || !ALLOWLIST_HOST) {
  die("configuration missing: TEST_GAME_ID / CLICKOUT_ALLOW_HOST");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function mustHaveRedirectMapping() {
  const { data, error } = await supabase
    .from("clickout_redirects")
    .select("game_id, redirect_url")
    .eq("game_id", TEST_GAME_ID)
    .limit(1);

  if (error) throw error;
  return !!(data && data.length > 0);
}

async function mustHaveAllowHost() {
  const { data, error } = await supabase
    .from("clickout_allow_hosts")
    .select("host")
    .eq("host", ALLOWLIST_HOST)
    .limit(1);

  if (error) throw error;
  return !!(data && data.length > 0);
}

(async () => {
  try {
    const okRedirect = await mustHaveRedirectMapping();
    const okHost = await mustHaveAllowHost();

    if (!okRedirect || !okHost) {
      console.error(
        "configuration missing:",
        JSON.stringify(
          {
            clickout_redirects: okRedirect,
            clickout_allow_hosts: okHost,
            TEST_GAME_ID,
            CLICKOUT_ALLOW_HOST: ALLOWLIST_HOST,
          },
          null,
          2
        )
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
