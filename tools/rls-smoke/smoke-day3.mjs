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

    // Gate 1: direct insert should be blocked (INSERT revoked)
    const direct = await A.from("user_interactions").insert([{
      user_id: "00000000-0000-0000-0000-000000000000",
      event_uuid: crypto.randomUUID(),
      event_type: "test",
      meta: {}
    }]);

    assert(direct.error, "Direct insert unexpectedly succeeded");
    ok("Direct insert blocked (client must use RPC)");

    // Gate 2: idempotent RPC (same event_uuid 10x -> count +1)
    const before = await countInteractions(A);
    const eid = crypto.randomUUID();

    for (let i = 0; i < 10; i++) {
      const res = await rpcLog(A, {
        p_event_uuid: eid,
        p_event_type: "swipe_right",
        p_game_id: null,
        p_meta: { cadence_bucket: "2-5s", ttfa_bucket: "0-2s", surface: "test" },
      });
      assert(res?.ok === true, "RPC log_interaction did not return ok:true");
    }
    const after = await countInteractions(A);
    assert(after === before + 1, `Idempotency failed: before=${before}, after=${after}`);
    ok("RPC is idempotent (10x same event_uuid => +1 row)");

    // Gate 3: allowlist enforcement is generic fail (no reason leak)
    const bad = await rpcLog(A, {
      p_event_uuid: crypto.randomUUID(),
      p_event_type: "definitely_not_allowed",
      p_game_id: null,
      p_meta: { whatever: "x" },
    });
    assert(bad?.ok === false, "Bad event_type should be ok:false");
    ok("Allowlist rejects invalid event_type with generic ok:false");

    console.log("\nDONE: Day 3 smoke suite finished. All checks passed.");
  } catch (e) {
    fail("Day 3 smoke suite crashed", e);
  }
}

main();
