import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const USER_A_EMAIL = process.env.USER_A_EMAIL || "usera@test.local";
const USER_A_PASS = process.env.USER_A_PASS || "password123";
const USER_B_EMAIL = process.env.USER_B_EMAIL || "userb@test.local";
const USER_B_PASS = process.env.USER_B_PASS || "password123";

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
  assert(userId, "No user id returned from sign-in");
  return { supabase, userId };
}

async function gateA(supabase, label) {
  const { data, error } = await supabase.from("auth_transfer_codes").select("*").limit(1);

  if (error) {
    ok(`Gate A (${label}): auth_transfer_codes not readable (error as expected)`);
    return;
  }
  if (Array.isArray(data) && data.length === 0) {
    ok(`Gate A (${label}): auth_transfer_codes not readable (0 rows)`);
    return;
  }
  throw new Error(`Sensitive table leaked rows: ${JSON.stringify(data)}`);
}

async function rpcLog(supabase, payload) {
  const { data, error } = await supabase.rpc("log_interaction", payload);
  if (error) throw error;
  return data;
}


async function countInteractions(supabase) {
  const { count, error } = await supabase
    .from("user_interactions")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function insertSelfInteraction(supabase) {
  const res = await rpcLog(supabase, {
    p_event_uuid: crypto.randomUUID(),
    p_event_type: "swipe_right",
    p_game_id: null,
    p_meta: { surface: "smoke-day1" },
  });
  if (!res || res.ok !== true) throw new Error("RPC log_interaction did not return ok:true");
}


async function gateB_proofOfDeny(supabaseA, supabaseB) {
  const beforeA = await countInteractions(supabaseA);
  const beforeB = await countInteractions(supabaseB);

  await insertSelfInteraction(supabaseA);

  const afterA = await countInteractions(supabaseA);
  const afterB = await countInteractions(supabaseB);

  assert(afterA === beforeA + 1, `User A count did not increase by 1 (before=${beforeA}, after=${afterA})`);
  ok("Gate B (User A): can log via RPC & see own interactions (count +1)");

  assert(afterB === beforeB, `User B count changed unexpectedly (before=${beforeB}, after=${afterB})`);
  ok("Gate B (User B): cannot see User A interactions (count unchanged)");
}


async function gateC(supabaseB) {
  const { error } = await supabaseB.from("user_interactions").insert([{
    user_id: "00000000-0000-0000-0000-000000000000",
    event_uuid: crypto.randomUUID(),
    event_type: "hack_attempt",
    meta: {},
  }]);

  if (!error) throw new Error("Spoof insert unexpectedly succeeded");
  ok("Gate C (User B): spoofing blocked (insert rejected)");
}

async function main() {
  try {
    assert(SUPABASE_URL, "Missing SUPABASE_URL");
    assert(SUPABASE_ANON_KEY, "Missing SUPABASE_ANON_KEY");

    const { supabase: A, userId: userA } = await signIn(USER_A_EMAIL, USER_A_PASS);
    const { supabase: B, userId: userB } = await signIn(USER_B_EMAIL, USER_B_PASS);

    assert(userA !== userB, "User A and User B have the same UID (not actually switching users)");
    ok("Sanity: User A uid != User B uid");

    await gateA(A, "User A");
    await gateA(B, "User B");
    await gateB_proofOfDeny(A, B);
    await gateC(B);

    console.log("\nDONE: Smoke suite finished.");
    if (process.exitCode && process.exitCode !== 0) console.log("Some checks failed.");
    else console.log("All checks passed.");
  } catch (e) {
    fail("Smoke suite crashed", e);
  }
}

main();
