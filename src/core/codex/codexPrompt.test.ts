import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexPrompt,
  buildPlanExecutionPrompt,
  buildPlanningPrompt,
  detectHollowResponse,
  isClearlySafeGeneratedCleanupRequest,
  promptHasWriteIntent,
  resolveExecutionMode,
} from "./codexPrompt.js";

const readOnlyPolicy = {
  approvalPolicy: "untrusted",
  sandboxMode: "read-only",
} as const;

const writePolicy = {
  approvalPolicy: "on-request",
  sandboxMode: "workspace-write",
} as const;

test("detects write intent for build requests", () => {
  assert.equal(promptHasWriteIntent("Create a weather app script with tests"), true);
});

test("does not force write mode for general questions", () => {
  assert.equal(promptHasWriteIntent("Explain how array sorting works"), false);
});

test("detects write intent for generated cleanup requests", () => {
  assert.equal(promptHasWriteIntent("Delete only clearly safe generated files and folders"), true);
});

test("detects narrow generated cleanup requests", () => {
  assert.equal(isClearlySafeGeneratedCleanupRequest("Delete only clearly safe generated files and folders"), true);
  assert.equal(isClearlySafeGeneratedCleanupRequest("Prune build artifacts and caches"), true);
});

test("does not fast-path broad destructive cleanup requests", () => {
  assert.equal(isClearlySafeGeneratedCleanupRequest("delete everything"), false);
  assert.equal(isClearlySafeGeneratedCleanupRequest("remove all files"), false);
  assert.equal(isClearlySafeGeneratedCleanupRequest("wipe the workspace"), false);
});

test("auto-upgrades suggest mode for editing prompts", () => {
  assert.deepEqual(resolveExecutionMode("suggest", "Create a new CLI script and tests"), {
    mode: "auto-edit",
    autoUpgraded: true,
  });
});

test("auto-upgrades suggest mode for generated cleanup prompts", () => {
  assert.deepEqual(resolveExecutionMode("suggest", "Delete only clearly safe generated files and folders"), {
    mode: "auto-edit",
    autoUpgraded: true,
  });
});

test("keeps explicit full-auto mode unchanged", () => {
  assert.deepEqual(resolveExecutionMode("full-auto", "Create a new CLI script and tests"), {
    mode: "full-auto",
    autoUpgraded: false,
  });
});

test("read-only runtime policy overrides write-capable modes", () => {
  const prompt = buildCodexPrompt("Create a weather app script with tests", "auto-edit", readOnlyPolicy);
  assert.match(prompt, /runtime permissions are read-only/i);
  assert.doesNotMatch(prompt, /write access/i);
  assert.doesNotMatch(prompt, /create or update files directly/i);
});

test("suggest mode stays advisory even with write-capable permissions", () => {
  const prompt = buildCodexPrompt("Explain this code", "suggest", writePolicy);
  assert.match(prompt, /permissions allow workspace edits/i);
  assert.match(prompt, /still in suggest mode/i);
  assert.match(prompt, /without making file changes/i);
});

test("plan mode injects plan-first instructions without changing suggest semantics", () => {
  const prompt = buildCodexPrompt("Explain this code", "suggest", {
    ...writePolicy,
    planMode: true,
  });
  assert.match(prompt, /Planning mode is enabled for this session/i);
  assert.match(prompt, /Start by giving a concise, repo-aware plan/i);
  assert.match(prompt, /continue the task normally under the current mode and runtime permissions/i);
  assert.match(prompt, /still in suggest mode/i);
  assert.match(prompt, /without making file changes/i);
});

test("builds a write-enabled codex prompt for auto-edit when permissions allow it", () => {
  const prompt = buildCodexPrompt("Create a weather app script with tests", "auto-edit", writePolicy);
  assert.match(prompt, /write access/i);
  assert.match(prompt, /create or update files directly/i);
  assert.match(prompt, /best-effort continuation/i);
  assert.match(prompt, /make the most reasonable assumption/i);
  assert.match(prompt, /\[QUESTION\]:/i);
  assert.match(prompt, /do not reply with generic readiness/i);
  assert.match(prompt, /Task:/i);
});

test("codex prompts include terminal-native final answer guidance", () => {
  const prompt = buildCodexPrompt("Explain this repo", "suggest", writePolicy);

  assert.match(prompt, /Final answer style for this terminal UI/i);
  assert.match(prompt, /short relative paths such as src\/App\.tsx/i);
  assert.match(prompt, /Do not include absolute local paths like C:\/Users/i);
  assert.match(prompt, /avoid web-style local Markdown links/i);
  assert.match(prompt, /Answer simple questions simply/i);
});

test("injects project instructions before the task", () => {
  const prompt = buildCodexPrompt("Explain this repo", "suggest", writePolicy, {
    projectInstructions: {
      path: "/workspace/AGENTS.md",
      content: "Prefer small, focused changes.",
    },
  });

  assert.match(prompt, /Project instructions:/i);
  assert.match(prompt, /Loaded from: \/workspace\/AGENTS\.md/i);
  assert.match(prompt, /Prefer small, focused changes\./i);
  assert.ok(prompt.indexOf("Project instructions:") < prompt.indexOf("Task:"));
});

test("adds fast generated cleanup safety instructions for write-enabled cleanup prompts", () => {
  const prompt = buildCodexPrompt("Delete only clearly safe generated files and folders", "auto-edit", writePolicy);
  assert.match(prompt, /Fast generated-file cleanup guidance/i);
  assert.match(prompt, /shallow workspace inspection/i);
  assert.match(prompt, /generated artifacts/i);
  assert.match(prompt, /Attempt each safe cleanup target once/i);
  assert.match(prompt, /stop immediately and report the blocked path and cause/i);
  assert.match(prompt, /Do not retry, force-delete/i);
  assert.match(prompt, /Do not do branch, bootstrap, package install, or repo setup/i);
});

test("plan mode keeps write-enabled prompts actionable", () => {
  const prompt = buildCodexPrompt("Create a weather app script with tests", "auto-edit", {
    ...writePolicy,
    planMode: true,
  });
  assert.match(prompt, /Planning mode is enabled for this session/i);
  assert.match(prompt, /continue the task normally under the current mode and runtime permissions/i);
  assert.match(prompt, /write access/i);
  assert.match(prompt, /create or update files directly/i);
});

test("plan mode does not override read-only runtime guidance", () => {
  const prompt = buildCodexPrompt("Create a weather app script with tests", "full-auto", {
    ...readOnlyPolicy,
    planMode: true,
  });
  assert.match(prompt, /Planning mode is enabled for this session/i);
  assert.match(prompt, /runtime permissions are read-only/i);
  assert.doesNotMatch(prompt, /write access/i);
});

test("builds a planning prompt that stays plan-only and includes constraints", () => {
  const prompt = buildPlanningPrompt({
    task: "Delete everything in hello.py and replace it with a starter hello_world.py script.",
    constraints: ["Keep the change scoped to the current workspace."],
  });

  assert.match(prompt, /plan-only turn/i);
  assert.match(prompt, /Do not implement the task/i);
  assert.match(prompt, /Files, Steps, Assumptions, Risks/i);
  assert.match(prompt, /Active constraints:/i);
  assert.match(prompt, /Task:/i);
});

test("planning prompt asks for a final message that contains only the plan", () => {
  const prompt = buildPlanningPrompt({ task: "Add a --json flag." });

  assert.match(prompt, /final message must contain only the plan/i);
  assert.match(prompt, /before your last tool call/i);
});

test("builds an approved-plan execution prompt that tells ubume to implement now", () => {
  const prompt = buildPlanExecutionPrompt({
    task: "Delete everything in hello.py and replace it with a starter hello_world.py script.",
    approvedPlan: "## Files\n- hello.py\n- hello_world.py",
    constraints: ["Keep it minimal."],
  });

  assert.match(prompt, /approved the following plan/i);
  assert.match(prompt, /implement it now/i);
  assert.match(prompt, /Do the work in the workspace instead of re-planning/i);
  assert.match(prompt, /Approved plan:/i);
  assert.match(prompt, /Additional constraints:/i);
});

// --- detectHollowResponse tests ---

test("detects greetings as hollow with kind=greeting", () => {
  for (const greeting of ["Hello.", "Hi!", "Hey", "Sure.", "Okay", "Sounds good"]) {
    const result = detectHollowResponse("create a file", greeting);
    assert.equal(result.isHollow, true, `Expected "${greeting}" to be hollow`);
    assert.equal(result.kind, "greeting");
  }
});

test("detects filler acknowledgments as hollow with kind=filler", () => {
  for (const filler of ["Thanks.", "Thank you!", "No problem", "Will do", "Noted"]) {
    const result = detectHollowResponse("create a file", filler);
    assert.equal(result.isHollow, true, `Expected "${filler}" to be hollow`);
    assert.equal(result.kind, "filler");
  }
});

test("detects clarification questions as hollow with kind=clarification", () => {
  for (const question of ["Can you clarify?", "Could you specify the path?", "What do you mean?"]) {
    const result = detectHollowResponse("create a file", question);
    assert.equal(result.isHollow, true, `Expected "${question}" to be hollow`);
    assert.equal(result.kind, "clarification");
  }
});

test("detects empty/whitespace as hollow with kind=filler", () => {
  assert.equal(detectHollowResponse("create a file", "").isHollow, true);
  assert.equal(detectHollowResponse("create a file", "   ").isHollow, true);
  assert.equal(detectHollowResponse("create a file", "").kind, "filler");
});

test("detects short no-action responses for write-intent prompts", () => {
  const result = detectHollowResponse("create a new script file", "Let me think about that.");
  assert.equal(result.isHollow, true);
  assert.equal(result.kind, "short-no-action");
});

test("does not flag valid short responses with action confirmation", () => {
  const result = detectHollowResponse("create a file", "Done, created the file.");
  assert.equal(result.isHollow, false);
  assert.equal(result.kind, "none");
});

test("does not flag longer task completions", () => {
  const longResponse = "I've created the file at src/utils/helper.ts with the requested utility functions. The module exports three helpers for string manipulation.";
  const result = detectHollowResponse("create a utility file", longResponse);
  assert.equal(result.isHollow, false);
});

test("does not flag responses containing code blocks", () => {
  const result = detectHollowResponse("create a script", "Here:\n```js\nconsole.log('hi');\n```");
  assert.equal(result.isHollow, false);
});

test("does not flag greetings when prompt has no write intent", () => {
  for (const prompt of ["Hello", "Hi there", "Hey", "What's up"]) {
    const result = detectHollowResponse(prompt, "Hello!");
    assert.equal(result.isHollow, false, `Prompt "${prompt}" should not trigger hollow detection`);
  }
});

test("does not flag filler when prompt is conversational", () => {
  const result = detectHollowResponse("thanks for that", "You're welcome!");
  assert.equal(result.isHollow, false);
});
