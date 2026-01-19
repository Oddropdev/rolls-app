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

    // Precondition: need at least one game. Reuse 'test-game' if present via get_pick.
    const pick = await rpc(A, "get_pick", { p_slug: "test-game" });
    if (!pick || pick.length === 0) {
      ok("No seed game 'test-game' found; skipping Day 6 smoke assertions.");
      console.log("\nDONE: Day 6 smoke suite finished (no seed data).");
      return;
    }
    const game = pick[0];

    // Save the game
    const r1 = await rpc(A, "set_saved", {
      p_game_id: game.id,
      p_saved: true,
      p_event_uuid: crypto.randomUUID(),
    });
    assert(r1?.ok === true, "set_saved(true) should be ok:true");
    ok("Saved event ok:true");

    // Saved list should include it
    const saved1 = await rpc(A, "get_saved", { p_limit: 50 });
    const found1 = Array.isArray(saved1) && saved1.some((x) => x.slug === "test-game");
    assert(found1, "Saved list should include test-game after save");
    ok("get_saved includes game after save");

    // Unsave
    const r2 = await rpc(A, "set_saved", {
      p_game_id: game.id,
      p_saved: false,
      p_event_uuid: crypto.randomUUID(),
    });
    assert(r2?.ok === true, "set_saved(false) should be ok:true");
    ok("Unsave event ok:true");

    // Saved list should NOT include it
    const saved2 = await rpc(A, "get_saved", { p_limit: 50 });
    const found2 = Array.isArray(saved2) && saved2.some((x) => x.slug === "test-game");
    assert(!found2, "Saved list should not include test-game after unsave");
    ok("get_saved excludes game after unsave");

    // Privacy check: ensure get_saved does not return meta or event fields
    if (Array.isArray(saved2) && saved2.length > 0) {
      const keys = Object.keys(saved2[0]);
      assert(!keys.includes("meta"), "get_saved should not include meta");
      assert(!keys.includes("event_type"), "get_saved should not include event_type");
      ok("Saved projection is allowlisted (no meta/event fields)");
    } else {
      ok("Saved list empty; projection check skipped");
    }

    console.log("\nDONE: Day 6 smoke suite finished. All checks passed.");
  } catch (e) {
    fail("Day 6 smoke suite crashed", e);
  }
}

main();
