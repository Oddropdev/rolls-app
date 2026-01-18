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

async function countInteractions(supabase) {
  const { count, error } = await supabase
    .from("user_interactions")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function insertSelfInteraction(supabase, userId) {
  const { error } = await supabase.from("user_interactions").insert([{
    user_id: userId,
    event_uuid: crypto.randomUUID(),
    event_type: "test",
    meta: {},
  }]);
  if (error) throw error;
}

async function gateB(supabaseA, userAId, supabaseB) {
  const beforeA = await countInteractions(supabaseA);
  await insertSelfInteraction(supabaseA, userAId);
  const afterA = await countInteractions(supabaseA);
  assert(afterA === beforeA + 1, `User A count did not increase by 1 (before=${beforeA}, after=${afterA})`);
  ok("Gate B (User A): can insert & see own interactions (count +1)");

  const countB = await countInteractions(supabaseB);
  if (countB === 0) {
    ok("Gate B (User B): cannot see User A interactions (count=0)");
    return;
  }
  throw new Error(`User B count=${countB}. On a fresh DB, expect 0. If not fresh, reset or adjust test.`);
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
    await gateB(A, userA, B);
    await gateC(B);

    console.log("\nDONE: Smoke suite finished.");
    if (process.exitCode && process.exitCode !== 0) console.log("Some checks failed.");
    else console.log("All checks passed.");
  } catch (e) {
    fail("Smoke suite crashed", e);
  }
}

main();
