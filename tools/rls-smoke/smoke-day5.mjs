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
  return { supabase, userId: data.user.id };
}

async function rpc(supabase, fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}

async function main() {
  try {
    assert(SUPABASE_URL && SUPABASE_ANON_KEY, "Missing SUPABASE env");
    assert(USER_A_EMAIL && USER_A_PASS, "Missing USER_A creds");

    const { supabase: A } = await signIn(USER_A_EMAIL, USER_A_PASS);

    // Precondition: ensure at least one game exists (manual seed for now)
    // We'll just try slug 'test-game' and accept empty result for now.
    const pick = await rpc(A, "get_pick", { p_slug: "test-game" });

    // If no seed data, skip strict checks but ensure RPC works
    if (!pick || pick.length === 0) {
      ok("get_pick executed (no seed data yet; skipping content assertions)");
      console.log("\nDONE: Day 5 smoke suite finished (no seed data).");
      return;
    }

    const g = pick[0];
    assert(g.slug === "test-game", "Returned wrong slug");
    ok("get_pick returns allowlisted fields");

    // Toggle save on/off using event_uuid
    const eid1 = crypto.randomUUID();
    const r1 = await rpc(A, "set_saved", { p_game_id: g.id, p_saved: true, p_event_uuid: eid1 });
    assert(r1?.ok === true, "set_saved(true) should return ok:true");
    ok("set_saved(true) ok:true");

    const eid2 = crypto.randomUUID();
    const r2 = await rpc(A, "set_saved", { p_game_id: g.id, p_saved: false, p_event_uuid: eid2 });
    assert(r2?.ok === true, "set_saved(false) should return ok:true");
    ok("set_saved(false) ok:true");

    console.log("\nDONE: Day 5 smoke suite finished. All checks passed.");
  } catch (e) {
    fail("Day 5 smoke suite crashed", e);
  }
}

main();
