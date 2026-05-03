// Standalone tests for the numeric whitelist validator used by pre-run-brief.
// Run with: node validator.test.mjs
//
// We re-implement the validator inline here (mirroring index.ts) so tests can
// run with plain Node without the Deno/Supabase runtime. Keep this in sync
// with `findHallucinatedNumber` and the regex in index.ts.

const NUMERIC_TOKEN_RE = /\b\d{1,3}(?::\d{2}){1,2}\b|\b\d+\.\d+\b|\b\d+\b/g;

function findHallucinatedNumber(script, triggerValue, whitelist) {
  const tokens = script.match(NUMERIC_TOKEN_RE) ?? [];
  for (const tok of tokens) {
    if (whitelist.has(tok)) continue;
    if (whitelist.has(tok.replace(/\.0+$/, ""))) continue;
    if (triggerValue !== null) {
      if (tok === String(triggerValue)) continue;
      if (tok === triggerValue.toFixed(1)) continue;
    }
    return tok;
  }
  return null;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `${msg ?? "assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---- Tests ----

test("accepts script with no numbers", () => {
  const wl = new Set(["8:42", "147"]);
  const result = findHallucinatedNumber("Stay smooth and breathe.", null, wl);
  assertEqual(result, null);
});

test("accepts whitelisted pace token", () => {
  const wl = new Set(["8:42"]);
  const result = findHallucinatedNumber("Hold 8:42 pace through mile 3.", 3, wl);
  assertEqual(result, null);
});

test("rejects pace not in whitelist", () => {
  const wl = new Set(["8:42"]);
  const result = findHallucinatedNumber("Try to hit 7:30 today.", null, wl);
  assertEqual(result, "7:30");
});

test("accepts trigger_value as a bare integer", () => {
  const wl = new Set();
  const result = findHallucinatedNumber("Two miles in. Keep it light.", 2, wl);
  assertEqual(result, null);
});

test("accepts trigger_value as decimal form (5.5)", () => {
  const wl = new Set();
  const result = findHallucinatedNumber("Half mile out at 5.5.", 5.5, wl);
  assertEqual(result, null);
});

test("rejects fabricated PR time", () => {
  const wl = new Set(["23:14", "5"]); // real PR is 23:14 for 5K
  const result = findHallucinatedNumber("Your 5K PR of 24:00 is in reach.", null, wl);
  assertEqual(result, "24:00");
});

test("accepts decimal that matches whitelisted form", () => {
  const wl = new Set(["5.71"]);
  const result = findHallucinatedNumber("You've covered 5.71 miles.", null, wl);
  assertEqual(result, null);
});

test("normalizes trailing zero (2.0 -> 2)", () => {
  const wl = new Set(["2"]);
  const result = findHallucinatedNumber("At 2.0 miles, settle in.", null, wl);
  assertEqual(result, null);
});

test("rejects mid-sentence fabricated bpm", () => {
  const wl = new Set(["147"]); // real avg HR
  const result = findHallucinatedNumber("Your last run averaged 165 bpm.", null, wl);
  assertEqual(result, "165");
});

test("rejects multiple-numeric script if any is bogus", () => {
  const wl = new Set(["3", "8:42", "147"]);
  const result = findHallucinatedNumber("Mile 3 at 8:42, HR 165.", 3, wl);
  assertEqual(result, "165");
});

// ---- Run ----

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  PASS  ${t.name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${t.name}\n        ${err.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
