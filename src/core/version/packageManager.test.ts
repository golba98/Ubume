import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, CommandSpec, CommandStreamHandlers } from "../../core/process/CommandRunner.js";
import {
  detectGlobalPackageManager,
  formatPermissionGuidance,
  getUpdateCommand,
  isPermissionError,
  runUpdateCommand,
  type GlobalPackageManager,
} from "./packageManager.js";

function makeResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    userMessage: "Command completed.",
    ...overrides,
  };
}

// --- detection ---

const DETECTION_CASES: Array<[string, GlobalPackageManager]> = [
  ["/usr/local/lib/node_modules/ubume/bin/ubume.js", "npm"],
  ["C:\\Users\\jorda\\AppData\\Roaming\\npm\\node_modules\\ubume\\bin\\ubume.js", "npm"],
  ["/home/user/.local/share/pnpm/global/5/node_modules/ubume/bin/ubume.js", "pnpm"],
  ["C:\\Users\\jorda\\AppData\\Local\\pnpm\\global\\5\\node_modules\\ubume\\bin\\ubume.js", "pnpm"],
  ["/home/user/.bun/install/global/node_modules/ubume/bin/ubume.js", "bun"],
  ["C:\\Users\\jorda\\.bun\\install\\global\\node_modules\\ubume\\bin\\ubume.js", "bun"],
  ["/home/user/.config/yarn/global/node_modules/ubume/bin/ubume.js", "yarn"],
  ["C:\\Users\\jorda\\AppData\\Local\\Yarn\\config\\global\\node_modules\\ubume\\bin\\ubume.js", "yarn"],
];

for (const [path, expected] of DETECTION_CASES) {
  test(`detectGlobalPackageManager detects ${expected} from ${path}`, () => {
    assert.equal(detectGlobalPackageManager({ UBUME_LAUNCHER_SCRIPT: path }), expected);
    assert.equal(detectGlobalPackageManager({ CODEXA_LAUNCHER_SCRIPT: path }), expected);
  });
}

test("detectGlobalPackageManager defaults to npm when no launcher path is available", () => {
  assert.equal(detectGlobalPackageManager({}, ""), "npm");
});

test("detectGlobalPackageManager prefers the explicit override over the environment", () => {
  const pm = detectGlobalPackageManager(
    { UBUME_LAUNCHER_SCRIPT: "/usr/local/lib/node_modules/ubume/bin/ubume.js" },
    "/home/user/.bun/install/global/node_modules/ubume/bin/ubume.js",
  );
  assert.equal(pm, "bun");
});

// --- commands ---

test("getUpdateCommand returns the right command per package manager", () => {
  assert.equal(getUpdateCommand("npm").displayCommand, "npm install -g ubume@latest");
  assert.equal(getUpdateCommand("pnpm").displayCommand, "pnpm add -g ubume@latest");
  assert.equal(getUpdateCommand("yarn").displayCommand, "yarn global add ubume@latest");
  assert.equal(getUpdateCommand("bun").displayCommand, "bun add -g ubume@latest");
});

test("getUpdateCommand argv matches its display command", () => {
  for (const pm of ["npm", "pnpm", "yarn", "bun"] as const) {
    const { displayCommand, argv } = getUpdateCommand(pm);
    assert.equal(argv.join(" "), displayCommand);
  }
});

// --- permission detection ---

test("isPermissionError detects EACCES/EPERM spawn error codes", () => {
  assert.equal(isPermissionError(makeResult({ status: "spawn_error", exitCode: null, errorCode: "EACCES" })), true);
  assert.equal(isPermissionError(makeResult({ status: "spawn_error", exitCode: null, errorCode: "EPERM" })), true);
  assert.equal(isPermissionError(makeResult({ status: "spawn_error", exitCode: null, errorCode: "ENOENT" })), false);
});

test("isPermissionError detects npm EACCES reported via stderr with nonzero exit", () => {
  const result = makeResult({
    status: "failed",
    exitCode: 243,
    stderr: "npm ERR! Error: EACCES: permission denied, access '/usr/local/lib/node_modules'",
  });
  assert.equal(isPermissionError(result), true);
});

test("isPermissionError is false for ordinary failures", () => {
  assert.equal(isPermissionError(makeResult({ status: "failed", exitCode: 1, stderr: "npm ERR! network timeout" })), false);
});

// --- guidance ---

test("formatPermissionGuidance never suggests sudo and shows the update command", () => {
  for (const pm of ["npm", "pnpm", "yarn", "bun"] as const) {
    const guidance = formatPermissionGuidance(pm);
    assert.doesNotMatch(guidance, /sudo/i);
    assert.match(guidance, new RegExp(getUpdateCommand(pm).argv[0]!));
  }
});

test("formatPermissionGuidance for npm mentions npm config get prefix", () => {
  assert.match(formatPermissionGuidance("npm"), /npm config get prefix/);
});

// --- execution routing ---

test("runUpdateCommand uses argv spawn on POSIX", async () => {
  const calls: CommandSpec[] = [];
  const fakeRun = (spec: CommandSpec, _handlers?: CommandStreamHandlers) => {
    calls.push(spec);
    return { child: null as never, result: Promise.resolve(makeResult()), cancel: () => {} };
  };

  const { result } = runUpdateCommand("npm", {}, {
    platform: "linux",
    runCommandFn: fakeRun,
    runShellCommandFn: () => {
      throw new Error("shell path must not be used on POSIX");
    },
  });
  const res = await result;
  assert.equal(res.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.executable, "npm");
  assert.deepEqual(calls[0]!.args, ["install", "-g", "ubume@latest"]);
  assert.equal(calls[0]!.timeoutMs, 300_000);
});

test("runUpdateCommand routes through the shell on Windows for .cmd shim support", async () => {
  const shellCalls: string[] = [];
  const fakeShell = (command: string, _options: unknown, _handlers?: CommandStreamHandlers) => {
    shellCalls.push(command);
    return { child: null as never, result: Promise.resolve(makeResult()), cancel: () => {} };
  };

  const { result } = runUpdateCommand("pnpm", {}, {
    platform: "win32",
    runCommandFn: () => {
      throw new Error("argv path must not be used on win32");
    },
    runShellCommandFn: fakeShell,
  });
  await result;
  assert.deepEqual(shellCalls, ["pnpm add -g ubume@latest"]);
});

test("runUpdateCommand exposes cancel from the underlying runner", () => {
  let canceled = false;
  const fakeRun = () => ({
    child: null as never,
    result: Promise.resolve(makeResult({ status: "canceled" })),
    cancel: () => {
      canceled = true;
    },
  });

  const { cancel } = runUpdateCommand("npm", {}, { platform: "linux", runCommandFn: fakeRun });
  cancel();
  assert.equal(canceled, true);
});
