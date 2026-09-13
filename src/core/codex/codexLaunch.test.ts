import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeConfig, normalizeRuntimeConfig } from "../../config/runtimeConfig.js";
import { prepareCodexExecLaunch } from "./codexLaunch.js";
import type { CodexCliCapabilities } from "../models/codexCapabilities.js";

test("prepares a shared launch plan with resolved executable strategy and source metadata", async () => {
  const capabilities: CodexCliCapabilities = {
    askForApproval: false,
    sandbox: true,
    config: true,
    fullAuto: true,
  };

  const result = await prepareCodexExecLaunch(
    {
      runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
        model: "gpt-5.4",
        reasoningLevel: "medium",
        policy: {
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
        },
      })),
      cwd: "C:/repo",
      structuredOutput: false,
      probeCapabilities: true,
    },
    "file:///C:/project/src/core/providers/codexSubprocess.ts",
    {
      resolveExecutable: async () => "C:/tools/codex.cmd",
      getCapabilities: async () => capabilities,
    },
  );

  assert.deepEqual(result, {
    ok: true,
    strategy: "config-overrides",
    executable: "C:/tools/codex.cmd",
    capabilities,
    responsibleModulePath: "C:\\project\\src\\core\\providers\\codexSubprocess.ts",
    responsibleModuleKind: "src",
    launchContext: {
      launchKind: process.env.UBUME_LAUNCH_KIND,
      packageRoot: process.env.UBUME_PACKAGE_ROOT,
      launcherScript: process.env.UBUME_LAUNCHER_SCRIPT,
    },
    args: [
      "exec",
      "--skip-git-repo-check",
      "--cd",
      "C:/repo",
      "--model",
      "gpt-5.4",
      "--config",
      "model_reasoning_effort=medium",
      "-c",
      "approval_policy=on-request",
      "--sandbox",
      "workspace-write",
      "-",
    ],
  });
});

test("launch diagnostics are injectable and silent by default", async () => {
  const previousDebug = process.env.UBUME_DEBUG_CODEX_LAUNCH;
  process.env.UBUME_DEBUG_CODEX_LAUNCH = "1";
  const capabilities: CodexCliCapabilities = {
    askForApproval: false,
    sandbox: true,
    config: true,
    fullAuto: true,
  };

  try {
    const silent = await prepareCodexExecLaunch(
      {
        runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
          model: "gpt-5.4",
          reasoningLevel: "medium",
          policy: {
            approvalPolicy: "on-request",
            sandboxMode: "workspace-write",
          },
        })),
        cwd: "C:/repo",
        structuredOutput: true,
      },
      "file:///C:/repo/src/core/providers/codexSubprocess.ts",
      {
        resolveExecutable: async () => "C:/tools/codex.cmd",
        getCapabilities: async () => capabilities,
      },
    );
    assert.equal(silent.ok, true);

    const diagnostics: string[] = [];
    await prepareCodexExecLaunch(
      {
        runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
          model: "gpt-5.4",
          reasoningLevel: "medium",
          policy: {
            approvalPolicy: "on-request",
            sandboxMode: "workspace-write",
          },
        })),
        cwd: "C:/repo",
        structuredOutput: true,
      },
      "file:///C:/repo/src/core/providers/codexSubprocess.ts",
      {
        resolveExecutable: async () => "C:/tools/codex.cmd",
        getCapabilities: async () => capabilities,
        diagnosticsLogger: (message) => diagnostics.push(message),
      },
    );

    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /\[ubume\] codex launch debug/);
  } finally {
    if (previousDebug == null) {
      delete process.env.UBUME_DEBUG_CODEX_LAUNCH;
    } else {
      process.env.UBUME_DEBUG_CODEX_LAUNCH = previousDebug;
    }
  }
});

test("uses modern Codex capabilities by default without probing help output", async () => {
  let capabilityProbeCount = 0;

  const result = await prepareCodexExecLaunch(
    {
      runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
        model: "gpt-5.4-mini",
        reasoningLevel: "medium",
        policy: {
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
        },
      })),
      cwd: "C:/repo",
      structuredOutput: true,
    },
    "file:///C:/repo/src/core/providers/codexSubprocess.ts",
    {
      resolveExecutable: async () => "codex.cmd",
      getCapabilities: async () => {
        capabilityProbeCount += 1;
        throw new Error("capability probe should not run");
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(capabilityProbeCount, 0);
});

test("can explicitly probe capabilities for compatibility fallback", async () => {
  let capabilityProbeCount = 0;
  const capabilities: CodexCliCapabilities = {
    askForApproval: false,
    sandbox: false,
    config: true,
    fullAuto: false,
  };

  const result = await prepareCodexExecLaunch(
    {
      runtime: resolveRuntimeConfig(normalizeRuntimeConfig({
        model: "gpt-5.4-mini",
        reasoningLevel: "medium",
        policy: {
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
        },
      })),
      cwd: "C:/repo",
      structuredOutput: false,
      probeCapabilities: true,
    },
    "file:///C:/repo/src/core/providers/codexSubprocess.ts",
    {
      resolveExecutable: async () => "codex.cmd",
      getCapabilities: async () => {
        capabilityProbeCount += 1;
        return capabilities;
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(capabilityProbeCount, 1);
  if (result.ok) {
    assert.deepEqual(result.args.slice(-5), [
      "-c",
      "approval_policy=on-request",
      "-c",
      "sandbox_mode=workspace-write",
      "-",
    ]);
  }
});
