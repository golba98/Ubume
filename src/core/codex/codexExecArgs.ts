import type { ResolvedRuntimeConfig } from "../../config/runtimeConfig.js";
import type { CodexCliCapabilities } from "../models/codexCapabilities.js";
import type { ProviderImageAttachment } from "../providerRuntime/types.js";

export interface BuildCodexExecArgsOptions {
  runtime: ResolvedRuntimeConfig;
  cwd: string;
  structuredOutput?: boolean;
  imageAttachments?: readonly ProviderImageAttachment[];
}

export type CodexLaunchStrategy =
  | "direct-flags"
  | "config-overrides"
  | "full-auto"
  | "fail";

export type BuildCodexExecArgsResult =
  | { ok: true; args: string[]; strategy: Exclude<CodexLaunchStrategy, "fail"> }
  | { ok: false; error: string; strategy: "fail" };

// Prevents newline/null injection into CLI args — rejects the path if it contains unsafe characters.
function sanitizeWorkingDirectory(cwd: string): string {
  if (cwd.includes("\n") || cwd.includes("\r") || cwd.includes("\0")) {
    return process.cwd();
  }

  return cwd;
}

function isFullAutoRuntime(runtime: ResolvedRuntimeConfig): boolean {
  return runtime.policy.approvalPolicy === "never" && runtime.policy.sandboxMode === "danger-full-access";
}

function buildCapabilitySummary(capabilities: CodexCliCapabilities): string {
  const supported: string[] = [];

  if (capabilities.askForApproval) supported.push("--ask-for-approval");
  if (capabilities.sandbox) supported.push("--sandbox");
  if (capabilities.config) supported.push("--config/-c");
  if (capabilities.fullAuto) supported.push("--full-auto");

  return supported.length > 0 ? supported.join(", ") : "none";
}

function buildRuntimeFailureMessage(runtime: ResolvedRuntimeConfig, capabilities: CodexCliCapabilities): string {
  return [
    "Installed Codex CLI cannot safely apply the requested runtime configuration.",
    `Requested approval policy: ${runtime.policy.approvalPolicy}.`,
    `Requested sandbox mode: ${runtime.policy.sandboxMode}.`,
    `Detected launch controls: ${buildCapabilitySummary(capabilities)}.`,
    "Update Codex or choose a runtime configuration that your installed CLI can represent.",
  ].join("\n");
}

function buildRuntimePolicyArgs(runtime: ResolvedRuntimeConfig, capabilities: CodexCliCapabilities): BuildCodexExecArgsResult {
  const args: string[] = [];
  const missingDirectApproval = !capabilities.askForApproval;
  const missingDirectSandbox = !capabilities.sandbox;
  const runtimePolicy = runtime.policy;

  if (!missingDirectApproval && !missingDirectSandbox) {
    args.push("--ask-for-approval", runtimePolicy.approvalPolicy);
    args.push("--sandbox", runtimePolicy.sandboxMode);
    return { ok: true, args, strategy: "direct-flags" };
  }

  if (isFullAutoRuntime(runtime) && capabilities.fullAuto) {
    args.push("--full-auto");
    return { ok: true, args, strategy: "full-auto" };
  }

  if (capabilities.config) {
    if (capabilities.askForApproval) {
      args.push("--ask-for-approval", runtimePolicy.approvalPolicy);
    } else {
      args.push("-c", `approval_policy=${runtimePolicy.approvalPolicy}`);
    }

    if (capabilities.sandbox) {
      args.push("--sandbox", runtimePolicy.sandboxMode);
    } else {
      args.push("-c", `sandbox_mode=${runtimePolicy.sandboxMode}`);
    }

    return { ok: true, args, strategy: "config-overrides" };
  }

  return {
    ok: false,
    strategy: "fail",
    error: buildRuntimeFailureMessage(runtime, capabilities),
  };
}

export function buildCodexExecArgs(
  options: BuildCodexExecArgsOptions,
  capabilities: CodexCliCapabilities,
): BuildCodexExecArgsResult {
  const { runtime } = options;
  const args: string[] = ["exec"];

  if ((options.imageAttachments?.length ?? 0) > 0 && capabilities.image === false) {
    return {
      ok: false,
      strategy: "fail",
      error: "Installed Codex CLI does not support image attachments. Update Codex or remove the image from the prompt.",
    };
  }

  if (options.structuredOutput ?? true) {
    args.push("--experimental-json");
  }

  args.push(
    "--skip-git-repo-check",
    "--cd",
    sanitizeWorkingDirectory(options.cwd),
    "--model",
    runtime.model,
  );

  if (!capabilities.config) {
    return {
      ok: false,
      strategy: "fail",
      error: [
        `Installed Codex CLI cannot safely apply the selected reasoning level "${runtime.reasoningLevel}".`,
        `Detected launch controls: ${buildCapabilitySummary(capabilities)}.`,
        "This Codex version does not support --config / -c overrides.",
      ].join("\n"),
    };
  }

  args.push("--config", `model_reasoning_effort=${runtime.reasoningLevel}`);

  const policyArgs = buildRuntimePolicyArgs(runtime, capabilities);
  if (!policyArgs.ok) {
    return policyArgs;
  }

  args.push(...policyArgs.args);

  for (const attachment of options.imageAttachments ?? []) {
    args.push("--image", attachment.path);
  }

  if (runtime.policy.networkAccess) {
    args.push("--config", `sandbox_workspace_write.network_access=${JSON.stringify(runtime.policy.networkAccess)}`);
  }

  if (runtime.policy.writableRoots.length > 0) {
    args.push("--config", `sandbox_workspace_write.writable_roots=${JSON.stringify(runtime.policy.writableRoots)}`);
  }

  if (runtime.policy.serviceTier !== "flex") {
    args.push("--config", `service_tier=${runtime.policy.serviceTier}`);
  }

  if (runtime.policy.personality !== "none") {
    args.push("--config", `personality=${runtime.policy.personality}`);
  }

  args.push("-");
  return { ok: true, args, strategy: policyArgs.strategy };
}
