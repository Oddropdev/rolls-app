import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const USER_A_EMAIL = process.env.USER_A_EMAIL;
const USER_A_PASS = process.env.USER_A_PASS;

function ok(msg) { console.log(`PASS: ${msg}`); }
function fail(msg, err) {
  console.error(`FAIL: ${msg}`);
  if (err) console.error("      ", err?.message || err);
  process.exitCode = 1;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function signIn(email, password) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const userId = data?.user?.id;
  assert(userId, "No user id from sign-in");
  return { supabase, userId };
}

async function countInteractions(supabase) {
  const { count, error } = await supabase
    .from("user_interactions")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function rpcLog(supabase, payload) {
  const { data, error } = await supabase.rpc("log_interaction", payload);
  if (error) throw error;
  return data;
}

async function main() {
  try {
    assert(SUPABASE_URL, "Missing SUPABASE_URL");
    assert(SUPABASE_ANON_KEY, "Missing SUPABASE_ANON_KEY");
    assert(USER_A_EMAIL && USER_A_PASS, "Missing USER_A creds");

    const { supabase: A } = await signIn(USER_A_EMAIL, USER_A_PASS);

    const before = await countInteractions(A);

    // Spam attempts: 200 events in a tight loop.
    // Expect: all return ok:true, but DB rows should increase only up to limit (default 60/min).
    const N = 200;
    for (let i = 0; i < N; i++) {
      const res = await rpcLog(A, {
        p_event_uuid: crypto.randomUUID(),
        p_event_type: "swipe_right",
        p_game_id: null,
        p_meta: { cadence_bucket: "0-2s", surface: "smoke-day4" },
      });
      assert(res?.ok === true, "log_interaction should return ok:true even under limit exceed");
    }
    ok("All spam attempts returned ok:true (no teaching signal)");

    const after = await countInteractions(A);
    const delta = after - before;

    // With default 60/min, delta should be <= 60 (allow a little slack if timing crosses minute boundary)
    assert(delta <= 45, `Expected delta <= ~45 (20/min, allow minute boundary), got delta=${delta}`);
    ok(`Silent discard worked (DB delta=${delta} for ${N} attempts)`);

    console.log("\nDONE: Day 4 smoke suite finished. All checks passed.");
  } catch (e) {
    fail("Day 4 smoke suite crashed", e);
  }
}

main();
