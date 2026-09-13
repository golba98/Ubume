import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import test from "node:test";
import {
  buildWorkspaceStatusMessage,
  createWorkspaceRelaunchPlan,
  guardWorkspaceRelaunch,
  resolveLaunchContext,
} from "./launchContext.js";
import { normalizeWorkspaceRoot } from "./workspaceRoot.js";

function createTempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "ubume-launch-context-"));
}

test("uses installed launcher metadata when available", () => {
  const context = resolveLaunchContext({
    workspaceRoot: "C:/target",
    packageRoot: "C:/repo",
    execPath: "C:/Program Files/nodejs/node.exe",
    env: {
      UBUME_LAUNCH_KIND: "installed-bin",
      UBUME_PACKAGE_ROOT: "C:/repo",
      UBUME_LAUNCHER_SCRIPT: "C:/repo/bin/ubume.js",
      UBUME_RELAUNCH_EXECUTABLE: "C:/Program Files/nodejs/node.exe",
      UBUME_RELAUNCH_ARGS: JSON.stringify(["C:/repo/bin/ubume.js", "--profile", "review"]),
    },
  });

  assert.equal(context.launchKind, "installed-bin");
  assert.equal(context.packageRoot, "C:\\repo");
  assert.equal(context.launcherScriptPath, "C:/repo/bin/ubume.js");
  assert.equal(context.relaunchExecutable, "C:/Program Files/nodejs/node.exe");
  assert.deepEqual(context.relaunchArgs, ["C:/repo/bin/ubume.js", "--profile", "review"]);
});

test("falls back to bun repo launch metadata when no installed launcher env exists", () => {
  const context = resolveLaunchContext({
    workspaceRoot: "C:/repo",
    packageRoot: "C:/repo",
    execPath: "C:/tools/bun.exe",
    hasBunRuntime: true,
    forwardArgs: ["--profile", "review", "--config", "model=\"gpt-5.4\""],
    env: {},
  });

  assert.equal(context.launchKind, "dev-run");
  assert.equal(context.relaunchExecutable, "C:/tools/bun.exe");
  assert.deepEqual(context.relaunchArgs, [
    "run",
    "--silent",
    join("C:\\repo", "src", "index.tsx"),
    "--",
    "--profile",
    "review",
    "--config",
    "model=\"gpt-5.4\"",
  ]);
});

test("creates an installed-bin relaunch plan with normalized target cwd and env", () => {
  const root = createTempWorkspace();
  try {
    const nextWorkspace = join(root, "next");
    mkdirSync(nextWorkspace);

    const context = resolveLaunchContext({
      workspaceRoot: root,
      packageRoot: "C:/repo",
      execPath: "C:/Program Files/nodejs/node.exe",
      env: {
        UBUME_LAUNCH_KIND: "installed-bin",
        UBUME_PACKAGE_ROOT: "C:/repo",
        UBUME_LAUNCHER_SCRIPT: "C:/repo/bin/ubume.js",
        UBUME_RELAUNCH_EXECUTABLE: "C:/Program Files/nodejs/node.exe",
        UBUME_RELAUNCH_ARGS: JSON.stringify(["C:/repo/bin/ubume.js", "--profile", "review"]),
      },
    });

    const result = createWorkspaceRelaunchPlan(".\\next", context, {});
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.plan.executable, "C:/Program Files/nodejs/node.exe");
    assert.deepEqual(result.plan.args, ["C:/repo/bin/ubume.js", "--profile", "review"]);
    assert.equal(result.plan.cwd, normalizeWorkspaceRoot(nextWorkspace));
    assert.equal(result.plan.env.CODEX_WORKSPACE_ROOT, normalizeWorkspaceRoot(nextWorkspace));
    assert.equal(result.plan.env.UBUME_LAUNCH_KIND, "installed-bin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects relaunch targets that do not exist", () => {
  const root = createTempWorkspace();
  try {
    const context = resolveLaunchContext({
      workspaceRoot: root,
      packageRoot: root,
      execPath: "C:/tools/bun.exe",
      hasBunRuntime: true,
      env: {},
    });

    const result = createWorkspaceRelaunchPlan(".\\missing", context, {});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /does not exist/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects relaunch targets that are files instead of directories", () => {
  const root = createTempWorkspace();
  try {
    const fileTarget = join(root, "notes.txt");
    writeFileSync(fileTarget, "hello", "utf8");
    const context = resolveLaunchContext({
      workspaceRoot: root,
      packageRoot: root,
      execPath: "C:/tools/bun.exe",
      hasBunRuntime: true,
      env: {},
    });

    const result = createWorkspaceRelaunchPlan(".\\notes.txt", context, {});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /not a directory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks workspace relaunch while busy", () => {
  assert.deepEqual(guardWorkspaceRelaunch(false), { allowed: true });
  assert.equal(guardWorkspaceRelaunch(true).allowed, false);
  assert.match(guardWorkspaceRelaunch(true).message ?? "", /finish the current run/i);
});

test("describes dev launch mode with install guidance", () => {
  const message = buildWorkspaceStatusMessage(resolveLaunchContext({
    workspaceRoot: "C:/repo",
    packageRoot: "C:/repo",
    execPath: "C:/tools/bun.exe",
    hasBunRuntime: true,
    env: {},
  }));

  assert.match(message, /Launch mode: dev\/repo launch/i);
  assert.match(message, /npm run install:dev-bin/i);
  assert.match(message, /ubume-dev/i);
  assert.doesNotMatch(message, /npm link/i);
  assert.match(message, /\/workspace relaunch <path>/i);
});
