import type { LaunchArgs } from "../config/launchArgs.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HeadlessExecArgs {
  help: boolean;
  benchmarkDiagnostics: boolean;
  timing: boolean;
  promptPolicy: "raw" | "wrapped";
  prompt: string;
  launchArgs: LaunchArgs;
}

export type HeadlessExecArgsParseResult =
  | { ok: true; value: HeadlessExecArgs }
  | { ok: false; error: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeNonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseConfigFlagValue(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }

  return trimmed;
}

function parseModelFlagValue(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function buildLaunchArgs(params: {
  prompt: string | null;
  profile: string | null;
  configOverrides: string[];
  passthroughArgs: string[];
  modelOverride: string | null;
}): LaunchArgs {
  return {
    help: false,
    version: false,
    initialPrompt: params.prompt,
    profile: params.profile,
    configOverrides: params.configOverrides,
    passthroughArgs: params.passthroughArgs,
    modelOverride: params.modelOverride,
    noClear: false,
  };
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export function parseHeadlessExecArgs(argv: readonly string[]): HeadlessExecArgsParseResult {
  const configOverrides: string[] = [];
  const passthroughArgs: string[] = [];
  const positionalPromptParts: string[] = [];
  let explicitPrompt: string | null = null;
  let profile: string | null = null;
  let modelOverride: string | null = null;
  let help = false;
  let benchmarkDiagnostics = false;
  let timing = false;
  let promptPolicy: "raw" | "wrapped" = "raw";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--benchmark-diagnostics") {
      benchmarkDiagnostics = true;
      timing = true;
      continue;
    }

    if (arg === "--timing") {
      timing = true;
      continue;
    }

    if (arg === "--skip-git-repo-check") {
      passthroughArgs.push(arg);
      continue;
    }

    // --codexa-prompt-policy is the pre-rename spelling; keep accepting it.
    if (arg === "--ubume-prompt-policy" || arg === "--codexa-prompt-policy") {
      const value = normalizeNonEmpty(argv[index + 1]);
      if (value !== "raw" && value !== "wrapped") {
        return { ok: false, error: "Missing or invalid value for --ubume-prompt-policy. Use raw or wrapped." };
      }
      promptPolicy = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--ubume-prompt-policy=") || arg.startsWith("--codexa-prompt-policy=")) {
      const value = normalizeNonEmpty(arg.slice(arg.indexOf("=") + 1));
      if (value !== "raw" && value !== "wrapped") {
        return { ok: false, error: "Invalid value for --ubume-prompt-policy. Use raw or wrapped." };
      }
      promptPolicy = value;
      continue;
    }

    if (arg === "--") {
      positionalPromptParts.push(...argv.slice(index + 1));
      break;
    }

    if (arg === "--prompt") {
      const value = normalizeNonEmpty(argv[index + 1]);
      if (!value) {
        return { ok: false, error: "Missing value for --prompt." };
      }
      explicitPrompt = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--prompt=")) {
      const value = normalizeNonEmpty(arg.slice("--prompt=".length));
      if (!value) {
        return { ok: false, error: "Missing value for --prompt." };
      }
      explicitPrompt = value;
      continue;
    }

    if (arg === "--profile") {
      const value = normalizeNonEmpty(argv[index + 1]);
      if (!value) {
        return { ok: false, error: "Missing value for --profile." };
      }
      profile = value;
      passthroughArgs.push(arg, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      const value = normalizeNonEmpty(arg.slice("--profile=".length));
      if (!value) {
        return { ok: false, error: "Missing value for --profile." };
      }
      profile = value;
      passthroughArgs.push(`--profile=${value}`);
      continue;
    }

    if (arg === "-c" || arg === "--config") {
      const value = parseConfigFlagValue(argv[index + 1]);
      if (!value) {
        return { ok: false, error: `Missing key=value payload for ${arg}.` };
      }
      configOverrides.push(value);
      passthroughArgs.push(arg, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      const value = parseConfigFlagValue(arg.slice("--config=".length));
      if (!value) {
        return { ok: false, error: "Missing key=value payload for --config." };
      }
      configOverrides.push(value);
      passthroughArgs.push(`--config=${value}`);
      continue;
    }

    if (arg.startsWith("-c=")) {
      const value = parseConfigFlagValue(arg.slice(3));
      if (!value) {
        return { ok: false, error: "Missing key=value payload for -c." };
      }
      configOverrides.push(value);
      passthroughArgs.push(`-c=${value}`);
      continue;
    }

    if (arg === "--model" || arg === "-m") {
      const value = parseModelFlagValue(argv[index + 1]);
      if (!value) {
        return { ok: false, error: `Missing value for ${arg}.` };
      }
      configOverrides.push(`model=${quoteTomlString(value)}`);
      passthroughArgs.push(arg, value);
      modelOverride = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      const value = parseModelFlagValue(arg.slice("--model=".length));
      if (!value) {
        return { ok: false, error: "Missing value for --model." };
      }
      configOverrides.push(`model=${quoteTomlString(value)}`);
      passthroughArgs.push(`--model=${value}`);
      modelOverride = value;
      continue;
    }

    if (arg === "--reasoning") {
      const value = parseModelFlagValue(argv[index + 1]);
      if (!value) {
        return { ok: false, error: `Missing value for ${arg}.` };
      }
      configOverrides.push(`model_reasoning_effort=${value}`);
      passthroughArgs.push(arg, value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--reasoning=")) {
      const value = parseModelFlagValue(arg.slice("--reasoning=".length));
      if (!value) {
        return { ok: false, error: "Missing value for --reasoning." };
      }
      configOverrides.push(`model_reasoning_effort=${value}`);
      passthroughArgs.push(`--reasoning=${value}`);
      continue;
    }

    if (arg.startsWith("-")) {
      return { ok: false, error: `Unknown option for ubume exec: ${arg}` };
    }

    positionalPromptParts.push(arg, ...argv.slice(index + 1));
    break;
  }

  const positionalPrompt = positionalPromptParts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .trim() || null;

  if (explicitPrompt && positionalPrompt) {
    return { ok: false, error: "Provide a prompt either positionally or with --prompt, not both." };
  }

  const prompt = explicitPrompt ?? positionalPrompt;
  if (help) {
    return {
      ok: true,
      value: {
        help,
        benchmarkDiagnostics,
        timing,
        promptPolicy,
        prompt: prompt ?? "",
        launchArgs: buildLaunchArgs({ prompt, profile, configOverrides, passthroughArgs, modelOverride }),
      },
    };
  }

  if (!prompt) {
    return { ok: false, error: "Missing prompt. Use ubume exec \"prompt\" or ubume exec --prompt \"prompt\"." };
  }

  return {
    ok: true,
    value: {
      help,
      benchmarkDiagnostics,
      timing,
      promptPolicy,
      prompt,
      launchArgs: buildLaunchArgs({ prompt, profile, configOverrides, passthroughArgs, modelOverride }),
    },
  };
}
