import { captureCodexProcessOutput } from "../executables/codexExecutable.js";
import { stripAnsi, stripNonPrintableControls } from "../providers/codexTranscript.js";

const HELP_TIMEOUT_MS = 5000;

export interface CodexCliCapabilities {
  askForApproval: boolean;
  sandbox: boolean;
  config: boolean;
  fullAuto: boolean;
  image?: boolean;
}

const capabilityCache = new Map<string, Promise<CodexCliCapabilities>>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHelpText(text: string): string {
  return stripNonPrintableControls(stripAnsi(text))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .toLowerCase();
}

// Uses a hand-rolled word-boundary pattern rather than \b so that flag names
// containing hyphens (e.g. --ask-for-approval) are matched reliably.
function hasCliToken(helpText: string, token: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(token.toLowerCase())}(?=$|[^a-z0-9-])`, "m");
  return pattern.test(helpText);
}

export function parseCodexCliCapabilities(
  execHelpText: string,
  _topLevelHelpText: string,
): CodexCliCapabilities {
  const execHelp = normalizeHelpText(execHelpText);

  return {
    askForApproval: hasCliToken(execHelp, "--ask-for-approval"),
    sandbox: hasCliToken(execHelp, "--sandbox"),
    config: hasCliToken(execHelp, "--config") || hasCliToken(execHelp, "-c"),
    fullAuto: hasCliToken(execHelp, "--full-auto"),
    image: hasCliToken(execHelp, "--image") || hasCliToken(execHelp, "-i"),
  };
}

export async function getCodexCliCapabilities(executable: string): Promise<CodexCliCapabilities> {
  const cached = capabilityCache.get(executable);
  if (cached) {
    return cached;
  }

  const inFlight = (async () => {
    const [execHelp, topLevelHelp] = await Promise.allSettled([
      captureCodexProcessOutput(executable, ["exec", "--help"], HELP_TIMEOUT_MS),
      captureCodexProcessOutput(executable, ["--help"], HELP_TIMEOUT_MS),
    ]);

    const outputs: string[] = [];

    if (execHelp.status === "fulfilled") {
      outputs.push(execHelp.value.stdout, execHelp.value.stderr);
    }

    if (topLevelHelp.status === "fulfilled") {
      outputs.push(topLevelHelp.value.stdout, topLevelHelp.value.stderr);
    }

    if (outputs.length === 0) {
      if (execHelp.status === "rejected") {
        throw execHelp.reason;
      }

      if (topLevelHelp.status === "rejected") {
        throw topLevelHelp.reason;
      }

      throw new Error("Unable to determine Codex CLI capabilities from help output.");
    }

    return parseCodexCliCapabilities(
      execHelp.status === "fulfilled" ? `${execHelp.value.stdout}\n${execHelp.value.stderr}` : "",
      topLevelHelp.status === "fulfilled" ? `${topLevelHelp.value.stdout}\n${topLevelHelp.value.stderr}` : "",
    );
  })();

  capabilityCache.set(executable, inFlight);

  try {
    return await inFlight;
  } catch (error) {
    capabilityCache.delete(executable);
    throw error;
  }
}
