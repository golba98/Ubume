import assert from "node:assert/strict";
import test from "node:test";
import {
  selectLogoVariant,
  selectLogoVariantForViewport,
  getLogoWidth,
  LOGO_LARGE,
  LOGO_MEDIUM,
  LOGO_COMPACT,
  LOGO_LARGE_MIN_COLS,
  LOGO_MEDIUM_MIN_COLS,
  LOGO_COMPACT_MIN_COLS,
  LOGO_LARGE_MIN_ROWS,
  LOGO_MEDIUM_MIN_ROWS,
  LOGO_COMPACT_MIN_ROWS,
} from "./logoVariants.js";

test("selectLogoVariant returns LOGO_LARGE at the large threshold", () => {
  assert.equal(selectLogoVariant(LOGO_LARGE_MIN_COLS), LOGO_LARGE);
  assert.equal(selectLogoVariant(LOGO_LARGE_MIN_COLS + 80), LOGO_LARGE);
});

// LOGO_LARGE_MIN_COLS = LOGO_MEDIUM_MIN_COLS = 72: LOGO_LARGE wins at this threshold.
test("selectLogoVariant returns LOGO_LARGE at the medium threshold (LOGO_LARGE_MIN_COLS = LOGO_MEDIUM_MIN_COLS)", () => {
  assert.equal(selectLogoVariant(LOGO_MEDIUM_MIN_COLS), LOGO_LARGE);
});

test("selectLogoVariant returns LOGO_COMPACT at the compact threshold", () => {
  assert.equal(selectLogoVariant(LOGO_COMPACT_MIN_COLS), LOGO_COMPACT);
});

test("selectLogoVariant returns empty array below the compact threshold", () => {
  assert.deepStrictEqual(selectLogoVariant(LOGO_COMPACT_MIN_COLS - 1), []);
  assert.deepStrictEqual(selectLogoVariant(0), []);
});

// At 71 cols (one below LOGO_LARGE_MIN_COLS = 72), LOGO_MEDIUM_MIN_COLS (72) also fails,
// so the selector skips directly to LOGO_COMPACT — no thin ASCII fallback.
test("selectLogoVariant returns LOGO_COMPACT just below the large threshold (no thin ASCII)", () => {
  assert.equal(selectLogoVariant(LOGO_LARGE_MIN_COLS - 1), LOGO_COMPACT);
});

test("selectLogoVariant returns LOGO_COMPACT just below the medium threshold", () => {
  assert.equal(selectLogoVariant(LOGO_MEDIUM_MIN_COLS - 1), LOGO_COMPACT);
});

// ─── Normal terminal width regression tests ───────────────────────────────────

test("selectLogoVariant returns LOGO_LARGE at 80 cols (normal Linux terminal default)", () => {
  assert.equal(selectLogoVariant(80), LOGO_LARGE);
});

test("selectLogoVariant returns LOGO_LARGE at 100 cols", () => {
  assert.equal(selectLogoVariant(100), LOGO_LARGE);
});

test("LOGO_MEDIUM is never auto-selected at any col ≥ 72 (LOGO_LARGE always wins)", () => {
  for (const cols of [72, 80, 100, 120, 200]) {
    assert.notEqual(selectLogoVariant(cols), LOGO_MEDIUM, `LOGO_MEDIUM must not be selected at ${cols} cols`);
  }
});

// ─── Environment overrides ────────────────────────────────────────────────────

test("UBUME_NO_ASCII_LOGO=1 or CODEXA_NO_ASCII_LOGO=1 suppresses all logo art at any width", () => {
  for (const envVar of ["UBUME_NO_ASCII_LOGO", "CODEXA_NO_ASCII_LOGO"]) {
    process.env[envVar] = "1";
    try {
      assert.deepStrictEqual(selectLogoVariant(200), []);
      assert.deepStrictEqual(selectLogoVariant(LOGO_LARGE_MIN_COLS), []);
    } finally {
      delete process.env[envVar];
    }
  }
});

test("UBUME_COMPACT_LOGO=1 or CODEXA_COMPACT_LOGO=1 forces compact logo at any width", () => {
  for (const envVar of ["UBUME_COMPACT_LOGO", "CODEXA_COMPACT_LOGO"]) {
    process.env[envVar] = "1";
    try {
      assert.equal(selectLogoVariant(200), LOGO_COMPACT);
      assert.equal(selectLogoVariant(LOGO_LARGE_MIN_COLS), LOGO_COMPACT);
    } finally {
      delete process.env[envVar];
    }
  }
});

// ─── selectLogoVariantForViewport (rows-aware degradation) ────────────────────

test("selectLogoVariantForViewport returns LOGO_LARGE when cols and rows are ample", () => {
  assert.equal(selectLogoVariantForViewport(130, 40), LOGO_LARGE);
  assert.equal(selectLogoVariantForViewport(LOGO_LARGE_MIN_COLS, LOGO_LARGE_MIN_ROWS), LOGO_LARGE);
});

test("wide-but-short terminal degrades to LOGO_MEDIUM at normal width", () => {
  assert.equal(selectLogoVariantForViewport(120, 18), LOGO_MEDIUM);
});

test("wide-but-shorter terminal degrades to LOGO_COMPACT", () => {
  assert.equal(selectLogoVariantForViewport(120, 14), LOGO_COMPACT);
});

test("selectLogoVariantForViewport returns empty only when even compact cannot fit", () => {
  assert.deepStrictEqual(selectLogoVariantForViewport(120, 10), []);
  assert.deepStrictEqual(selectLogoVariantForViewport(LOGO_COMPACT_MIN_COLS - 1, 40), []);
});

test("selectLogoVariantForViewport at medium cols uses medium then compact by row budget", () => {
  assert.equal(selectLogoVariantForViewport(LOGO_MEDIUM_MIN_COLS, LOGO_MEDIUM_MIN_ROWS), LOGO_MEDIUM);
  assert.equal(selectLogoVariantForViewport(LOGO_MEDIUM_MIN_COLS, LOGO_MEDIUM_MIN_ROWS - 1), LOGO_COMPACT);
});

test("UBUME_NO_ASCII_LOGO=1 or CODEXA_NO_ASCII_LOGO=1 suppresses logo in viewport selector at any size", () => {
  for (const envVar of ["UBUME_NO_ASCII_LOGO", "CODEXA_NO_ASCII_LOGO"]) {
    process.env[envVar] = "1";
    try {
      assert.deepStrictEqual(selectLogoVariantForViewport(200, 60), []);
    } finally {
      delete process.env[envVar];
    }
  }
});

test("UBUME_COMPACT_LOGO=1 or CODEXA_COMPACT_LOGO=1 forces compact logo in viewport selector when rows allow", () => {
  for (const envVar of ["UBUME_COMPACT_LOGO", "CODEXA_COMPACT_LOGO"]) {
    process.env[envVar] = "1";
    try {
      assert.equal(selectLogoVariantForViewport(200, 60), LOGO_COMPACT);
      // Too short for even the compact logo → empty.
      assert.deepStrictEqual(selectLogoVariantForViewport(200, LOGO_COMPACT_MIN_ROWS - 1), []);
    } finally {
      delete process.env[envVar];
    }
  }
});

// ─── Shape / width assertions ─────────────────────────────────────────────────

test("LOGO_LARGE has exactly 6 rows", () => {
  assert.equal(LOGO_LARGE.length, 6);
});

test("LOGO_MEDIUM has exactly 4 rows", () => {
  assert.equal(LOGO_MEDIUM.length, 4);
});

test("LOGO_COMPACT has exactly 1 row", () => {
  assert.equal(LOGO_COMPACT.length, 1);
});

test("getLogoWidth returns 0 for an empty logo", () => {
  assert.equal(getLogoWidth([]), 0);
});

test("getLogoWidth(LOGO_LARGE) is narrower than its minimum column threshold", () => {
  const width = getLogoWidth(LOGO_LARGE);
  assert.ok(
    width < LOGO_LARGE_MIN_COLS,
    `LOGO_LARGE width ${width} must be narrower than LOGO_LARGE_MIN_COLS (${LOGO_LARGE_MIN_COLS})`,
  );
});

test("getLogoWidth(LOGO_MEDIUM) is narrower than its minimum column threshold", () => {
  const width = getLogoWidth(LOGO_MEDIUM);
  assert.ok(
    width < LOGO_MEDIUM_MIN_COLS,
    `LOGO_MEDIUM width ${width} must be narrower than LOGO_MEDIUM_MIN_COLS (${LOGO_MEDIUM_MIN_COLS})`,
  );
});

test("getLogoWidth(LOGO_COMPACT) is narrower than its minimum column threshold", () => {
  const width = getLogoWidth(LOGO_COMPACT);
  assert.ok(
    width < LOGO_COMPACT_MIN_COLS,
    `LOGO_COMPACT width ${width} must be narrower than LOGO_COMPACT_MIN_COLS (${LOGO_COMPACT_MIN_COLS})`,
  );
});

test("no LOGO_LARGE row is empty", () => {
  for (const row of LOGO_LARGE) {
    assert.ok(row.trim().length > 0, `Found empty/whitespace-only row in LOGO_LARGE: "${row}"`);
  }
});

test("no LOGO_MEDIUM row is empty", () => {
  for (const row of LOGO_MEDIUM) {
    assert.ok(row.trim().length > 0, `Found empty/whitespace-only row in LOGO_MEDIUM: "${row}"`);
  }
});

// ─── Row-count constants cross-checks ────────────────────────────────────────

test("LOGO_LARGE_MIN_ROWS is referenced and positive", () => {
  assert.ok(LOGO_LARGE_MIN_ROWS > 0);
});

test("LOGO_MEDIUM_MIN_ROWS is referenced and positive", () => {
  assert.ok(LOGO_MEDIUM_MIN_ROWS > 0);
});

test("LOGO_COMPACT_MIN_ROWS is referenced and positive", () => {
  assert.ok(LOGO_COMPACT_MIN_ROWS > 0);
});
