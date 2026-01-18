import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const USER_A_EMAIL = process.env.USER_A_EMAIL;
const USER_A_PASS = process.env.USER_A_PASS;
const USER_B_EMAIL = process.env.USER_B_EMAIL;
const USER_B_PASS = process.env.USER_B_PASS;

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

async function createTransferCode(supabase) {
  const { data, error } = await supabase.rpc("create_transfer_code");
  if (error) throw error;
  assert(data && typeof data === "object", "create_transfer_code returned no json");
  return data;
}

async function redeemTransferCode(supabase, code) {
  const { data, error } = await supabase.rpc("redeem_transfer_code", { p_code: code });
  if (error) throw error;
  assert(data && typeof data === "object", "redeem_transfer_code returned no json");
  return data;
}

async function insertInteraction(supabase, userId, eventType) {
  const { error } = await supabase.from("user_interactions").insert([{
    user_id: userId,
    event_uuid: crypto.randomUUID(),
    event_type: eventType,
    meta: {},
  }]);
  if (error) throw error;
}

async function main() {
  try {
    assert(SUPABASE_URL, "Missing SUPABASE_URL");
    assert(SUPABASE_ANON_KEY, "Missing SUPABASE_ANON_KEY");
    assert(USER_A_EMAIL && USER_A_PASS && USER_B_EMAIL && USER_B_PASS, "Missing USER_A/USER_B creds in .env");

    const { supabase: A, userId: userA } = await signIn(USER_A_EMAIL, USER_A_PASS);
    const { supabase: B, userId: userB } = await signIn(USER_B_EMAIL, USER_B_PASS);
    assert(userA !== userB, "User A and User B are the same user");
    ok("Sanity: User A uid != User B uid");

   const created = await createTransferCode(A);

assert(created.ok === true, "create_transfer_code ok !== true");
assert(typeof created.code === "string" && created.code.length >= 10, "No code returned");
ok("create_transfer_code returns ok:true + code");


    const beforeA = await countInteractions(A);
    await insertInteraction(A, userA, "merge_test_event");
    const afterA = await countInteractions(A);
    assert(afterA === beforeA + 1, "User A insert did not increase count by 1");
    ok("User A has at least 1 interaction to merge");

    const beforeB = await countInteractions(B);

    const r1 = await redeemTransferCode(B, created.code);
assert(r1.ok === true, "First redeem should succeed (ok:true)");
    ok("redeem once succeeds");

    const afterB = await countInteractions(B);
    assert(afterB >= beforeB, "B count decreased unexpectedly");
    ok("B interactions not decreased after merge");

    const r2 = await redeemTransferCode(B, created.code);
    assert(r2.ok === false, "Second redeem should be ok:false");
    ok("second redeem fails generically (ok:false)");

    const r3 = await redeemTransferCode(B, "this_is_not_a_real_code_123");
    assert(r3.ok === false, "Invalid code should be ok:false");
    ok("invalid code fails generically (ok:false)");

    console.log("\nDONE: Day 2 smoke suite finished. All checks passed.");
  } catch (e) {
    fail("Day 2 smoke suite crashed", e);
  }
}

main();
