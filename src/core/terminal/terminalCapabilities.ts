export interface TerminalCapabilityInput {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  platform: NodeJS.Platform | string;
  env: Record<string, string | undefined>;
}

export interface TerminalCapabilityResult {
  supported: boolean;
  reason: "supported" | "notty" | "unsupported-terminal";
  message: string;
  warning?: string;
}

const WINDOWS_SUPPORTED_TERM_PATTERNS = [
  /^xterm/i,
  /^screen/i,
  /^tmux/i,
  /^vt\d+/i,
  /^ansi/i,
  /^cygwin/i,
  /^linux/i,
];

function hasSupportedWindowsTerminal(env: Record<string, string | undefined>): boolean {
  const term = env.TERM ?? "";
  const termProgram = env.TERM_PROGRAM ?? "";

  if (env.WT_SESSION) return true;
  if (env.ANSICON) return true;
  if ((env.ConEmuANSI ?? "").toUpperCase() === "ON") return true;
  if (termProgram.toLowerCase() === "vscode") return true;
  if (termProgram.toLowerCase() === "hyper") return true;
  if (termProgram.toLowerCase() === "jetbrains-jediterm") return true;

  return WINDOWS_SUPPORTED_TERM_PATTERNS.some((pattern) => pattern.test(term));
}

export function getTerminalCapability(input: TerminalCapabilityInput): TerminalCapabilityResult {
  if (!input.stdinIsTTY || !input.stdoutIsTTY) {
    return {
      supported: false,
      reason: "notty",
      message: "This UI requires an interactive terminal.",
    };
  }

  // UBUME_FORCE_VT=1 bypasses terminal detection entirely — useful when the terminal
  // doesn't advertise VT support through standard env vars but is actually compatible.
  if (input.env.UBUME_FORCE_VT === "1") {
    return {
      supported: true,
      reason: "supported",
      message: "",
    };
  }

  const term = (input.env.TERM ?? "").trim().toLowerCase();
  if (term === "dumb") {
    return {
      supported: false,
      reason: "unsupported-terminal",
      message: "This terminal does not support the VT control sequences required by the Ubume UI. Use a VT-compatible terminal such as Windows Terminal or the VS Code terminal.",
    };
  }

  if (input.platform !== "win32") {
    return {
      supported: true,
      reason: "supported",
      message: "",
    };
  }

  // Windows-specific terminal detection below.
  if (hasSupportedWindowsTerminal(input.env)) {
    return {
      supported: true,
      reason: "supported",
      message: "",
    };
  }

  const message = "This terminal does not advertise VT control sequence support. Ubume will continue because modern Windows terminals usually support VT; set UBUME_REQUIRE_VT=1 to hard-fail when support is not detected.";

  if (input.env.UBUME_REQUIRE_VT === "1") {
    return {
      supported: false,
      reason: "unsupported-terminal",
      message: "This terminal does not appear to support the VT control sequences required by the Ubume UI. Use Windows Terminal, the VS Code terminal, or another VT-compatible terminal, or set UBUME_FORCE_VT=1 to bypass this check.",
    };
  }

  return {
    supported: true,
    reason: "supported",
    message: "",
    warning: message,
  };
}
