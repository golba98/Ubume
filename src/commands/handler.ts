import {
  formatLayeredConfigStatus,
  type LayeredConfigResult,
} from "../config/layeredConfig.js";
import {
  formatApprovalPolicyLabel,
  formatNetworkAccessLabel,
  formatPermissionsStatus,
  formatPersonalityLabel,
  formatRuntimeStatus,
  formatSandboxModeLabel,
  formatServiceTierLabel,
  type ResolvedRuntimeConfig,
  type RuntimeConfig,
  type RuntimeNetworkAccess,
} from "../config/runtimeConfig.js";
import {
  AUTH_PREFERENCES,
  AVAILABLE_BACKENDS,
  AVAILABLE_MODELS,
  AVAILABLE_THEMES,
  BUSY_LOADER_SETTING_VALUES,
  WORKSPACE_DISPLAY_MODES,
  formatAuthPreferenceLabel,
  formatBackendLabel,
  formatModeCommandHelp,
  formatModeLabel,
  formatReasoningLabel,
  formatThemeLabel,
  formatWorkspaceDisplayModeLabel,
  normalizeLegacyDirectoryDisplayMode,
  resolveModeCommand,
  type BusyLoaderSettingValue,
  type TerminalTitleMode,
  type WorkspaceDisplayMode,
} from "../config/settings.js";

import type { WorkspaceCommandContext } from "../core/workspace/launchContext.js";
import {
  findModelCapability,
  formatModelCapabilitiesList,
  getSelectableModelCapabilities,
  type CodexModelCapabilities,
} from "../core/models/codexModelCapabilities.js";
import { dumpRenderCounts } from "../core/perf/renderDebug.js";

export type CommandAction =
  | "exit"
  | "clear"
  | "resume"
  | "login"
  | "logout"
  | "auth_status"
  | "backend"
  | "open_provider_picker"
  | "route_status"
  | "model"
  | "mode"
  | "auth"
  | "open_backend_picker"
  | "open_model_picker"
  | "open_mode_picker"
  | "reasoning"
  | "open_reasoning_picker"
  | "plan_mode"
  | "open_settings_panel"
  | "setting_status"
  | "setting_workspace_display"
  | "setting_terminal_title"
  | "setting_busy_loader"
  | "theme"
  | "help"
  | "copy"
  | "paste_image"
  | "backends"
  | "models"
  | "workspace"
  | "workspace_relaunch"
  | "config_status"
  | "config_trust_status"
  | "config_trust_set"
  | "open_auth_panel"
  | "open_theme_picker"
  | "open_permissions_panel"
  | "themes"
  | "verbose_toggle"
  | "status"
  | "permissions_status"
  | "runtime_approval_policy"
  | "runtime_sandbox_mode"
  | "runtime_network_access"
  | "runtime_writable_roots_add"
  | "runtime_writable_roots_remove"
  | "runtime_writable_roots_clear"
  | "runtime_writable_roots_list"
  | "runtime_service_tier"
  | "runtime_personality"
  | "diagnose_github"
  | "diagnose_providers"
  | "update"
  | "unknown";

export interface CommandResult {
  action: CommandAction;
  message?: string;
  value?: string;
}

export interface CommandContext {
  config: LayeredConfigResult;
  runtime: RuntimeConfig;
  resolvedRuntime: ResolvedRuntimeConfig;
  settings: {
    workspaceDisplayMode: WorkspaceDisplayMode;
    terminalTitleMode: TerminalTitleMode;
    showBusyLoader: boolean;
  };
  workspace: WorkspaceCommandContext;
  tokensUsed?: number;
  modelCapabilities?: CodexModelCapabilities | null;
  routeStatusMessage?: string;
  activeRouteProviderLabel?: string;
  projectInstructions?: import("../core/workspace/projectInstructions.js").ProjectInstructionsLoadResult | null;
}

// Mirrors AVAILABLE_APPROVAL_POLICIES[].id from runtimeConfig.ts
const APPROVAL_POLICY_VALUES = ["inherit", "untrusted", "on-request", "never"] as const;
// Mirrors AVAILABLE_SANDBOX_MODES[].id from runtimeConfig.ts
const SANDBOX_MODE_VALUES = ["inherit", "read-only", "workspace-write", "danger-full-access"] as const;
// Input aliases — "on"/"off" are mapped to "enabled"/"disabled" in the network case below
const NETWORK_ACCESS_VALUES = ["inherit", "on", "off"] as const;
// Mirrors AVAILABLE_SERVICE_TIERS[].id from runtimeConfig.ts
const SERVICE_TIER_VALUES = ["flex", "fast"] as const;
// Mirrors AVAILABLE_PERSONALITIES[].id from runtimeConfig.ts
const PERSONALITY_VALUES = ["none", "friendly", "pragmatic"] as const;

function isOneOf<T extends string>(value: string, list: readonly T[]): value is T {
  return (list as readonly string[]).includes(value);
}

function formatWritableRoots(roots: readonly string[]): string {
  return roots.length > 0
    ? roots.map((root) => `  - ${root}`).join("\n")
    : "  - none";
}

function expandReasoningAliases(arg: string): string {
  const normalized = arg.toLowerCase();
  // "extra high" is a user-facing alias for "xhigh"
  return normalized === "extra high" ? "xhigh" : normalized;
}

function simplePolicySetter<T extends string>(
  rest: string,
  normalizedRest: string,
  action: CommandAction,
  values: readonly T[],
  statusMessage: string,
  setMessage: (value: T) => string,
  usageMessage: string,
): CommandResult {
  if (!rest || normalizedRest === "status") {
    return { action, message: statusMessage };
  }
  if (isOneOf(normalizedRest, values)) {
    return { action, value: normalizedRest, message: setMessage(normalizedRest) };
  }
  return { action: "unknown", message: usageMessage };
}

function handlePolicyCommand(
  commandPrefix: "/runtime" | "/permissions",
  arg: string,
  context: CommandContext,
  includeExtendedControls = true,
): CommandResult {
  const [subcommandRaw, ...restTokens] = arg.split(/\s+/);
  const subcommand = subcommandRaw?.toLowerCase() ?? "";
  const rest = restTokens.join(" ").trim();
  const normalizedRest = rest.toLowerCase();

  switch (subcommand) {
    case "approval-policy": {
      return simplePolicySetter(
        rest,
        normalizedRest,
        "runtime_approval_policy",
        APPROVAL_POLICY_VALUES,
        `Approval policy: configured ${formatApprovalPolicyLabel(context.runtime.policy.approvalPolicy)}; effective ${formatApprovalPolicyLabel(context.resolvedRuntime.policy.approvalPolicy)}.`,
        (v) => `Approval policy set to ${formatApprovalPolicyLabel(v)}.`,
        `Usage: ${commandPrefix} approval-policy [status|inherit|untrusted|on-request|never]`,
      );
    }

    case "sandbox": {
      return simplePolicySetter(
        rest,
        normalizedRest,
        "runtime_sandbox_mode",
        SANDBOX_MODE_VALUES,
        `Sandbox mode: configured ${formatSandboxModeLabel(context.runtime.policy.sandboxMode)}; effective ${formatSandboxModeLabel(context.resolvedRuntime.policy.sandboxMode)}.`,
        (v) => `Sandbox mode set to ${formatSandboxModeLabel(v)}.`,
        `Usage: ${commandPrefix} sandbox [status|inherit|read-only|workspace-write|danger-full-access]`,
      );
    }

    case "network": {
      if (!rest || normalizedRest === "status") {
        return {
          action: "runtime_network_access",
          message: `Network access: configured ${formatNetworkAccessLabel(context.runtime.policy.networkAccess)}; effective ${formatNetworkAccessLabel(context.resolvedRuntime.policy.networkAccess)}.`,
        };
      }
      if (isOneOf(normalizedRest, NETWORK_ACCESS_VALUES)) {
        // "on"/"off" are accepted aliases for "enabled"/"disabled"
        const value: RuntimeNetworkAccess = normalizedRest === "on"
          ? "enabled"
          : normalizedRest === "off"
            ? "disabled"
            : "inherit";
        return {
          action: "runtime_network_access",
          value,
          message: `Network access set to ${formatNetworkAccessLabel(value)}.`,
        };
      }
      return {
        action: "unknown",
        message: `Usage: ${commandPrefix} network [status|inherit|on|off]`,
      };
    }

    case "writable-roots": {
      if (!rest || normalizedRest === "list" || normalizedRest === "status") {
        return {
          action: "runtime_writable_roots_list",
          message: `Writable roots:\n${formatWritableRoots(context.runtime.policy.writableRoots)}`,
        };
      }

      if (normalizedRest === "clear") {
        return {
          action: "runtime_writable_roots_clear",
          message: "Writable roots cleared.",
        };
      }

      if (normalizedRest.startsWith("add ")) {
        const pathValue = rest.slice("add".length).trim();
        if (!pathValue) {
          return {
            action: "unknown",
            message: `Usage: ${commandPrefix} writable-roots add <path>`,
          };
        }
        return {
          action: "runtime_writable_roots_add",
          value: pathValue,
          message: `Writable root added: ${pathValue}`,
        };
      }

      if (normalizedRest.startsWith("remove ")) {
        const pathValue = rest.slice("remove".length).trim();
        if (!pathValue) {
          return {
            action: "unknown",
            message: `Usage: ${commandPrefix} writable-roots remove <path>`,
          };
        }
        return {
          action: "runtime_writable_roots_remove",
          value: pathValue,
          message: `Writable root removed: ${pathValue}`,
        };
      }

      return {
        action: "unknown",
        message: `Usage: ${commandPrefix} writable-roots [list|add <path>|remove <path>|clear]`,
      };
    }

    case "service-tier": {
      if (!includeExtendedControls) {
        return {
          action: "unknown",
          message: `Unknown ${commandPrefix.slice(1)} command. Use ${commandPrefix} <approval-policy|sandbox|network|writable-roots>.`,
        };
      }
      return simplePolicySetter(
        rest,
        normalizedRest,
        "runtime_service_tier",
        SERVICE_TIER_VALUES,
        `Service tier: ${formatServiceTierLabel(context.runtime.policy.serviceTier)}.`,
        (v) => `Service tier set to ${formatServiceTierLabel(v)}.`,
        `Usage: ${commandPrefix} service-tier [status|flex|fast]`,
      );
    }

    case "personality": {
      if (!includeExtendedControls) {
        return {
          action: "unknown",
          message: `Unknown ${commandPrefix.slice(1)} command. Use ${commandPrefix} <approval-policy|sandbox|network|writable-roots>.`,
        };
      }
      return simplePolicySetter(
        rest,
        normalizedRest,
        "runtime_personality",
        PERSONALITY_VALUES,
        `Personality: ${formatPersonalityLabel(context.runtime.policy.personality)}.`,
        (v) => `Personality set to ${formatPersonalityLabel(v)}.`,
        `Usage: ${commandPrefix} personality [status|none|friendly|pragmatic]`,
      );
    }

    default:
      return {
        action: "unknown",
        message: includeExtendedControls
          ? `Unknown ${commandPrefix.slice(1)} command. Use /status or ${commandPrefix} <approval-policy|sandbox|network|writable-roots|service-tier|personality>.`
          : `Unknown ${commandPrefix.slice(1)} command. Use /permissions <approval-policy|sandbox|network|writable-roots>.`,
      };
  }
}

function formatRenderCounts(): string {
  const counts = dumpRenderCounts();
  const lines = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `  ${name}: ${count}`);
  return lines.length > 0
    ? `Render counts:\n${lines.join("\n")}`
    : "No render counts recorded. Set CODEXA_RENDER_DEBUG=1 to enable.";
}

function buildHelpMessage(context: CommandContext): string {
  return [
    "Shell execution:",
    "  !<command>         Run any shell command directly  e.g. !ls -la",
    "                     Output streams live in a terminal block",
    "                     Esc cancels a running command",
    "",
    "Commands:",
    "  /exit, /quit       Quit the application and cancel active run",
    "  /clear             Clear the chat window and cancel the active run",
    "  /resume            Resume a previous conversation",
    "  /diagnose github|providers   Run diagnostics",
    "  /backend [name]    Switch backend (no arg opens picker)",
    "  /providers         Open provider picker (/provider alias)",
    "  /route             Show workspace default and active chat route",
    "  /model [name]      Switch model (no arg opens picker)",
    `  /mode [name]       Switch execution mode (${formatModeCommandHelp()})`,
    "                     suggest = read-only-style prompting, auto-edit = file edits, full-auto = strongest autonomy",
    "  /reasoning [level] Set reasoning level (no arg opens picker)",
    "  /plan [on|off]     Show or toggle session plan mode",
    "  /setting, /settings Open the settings picker",
    "  /setting workspace [dir|name|simple] Control the header workspace label",
    "  /setting terminal-title [dir|name|simple] Control the terminal tab title",
    "  /setting busy-loader [true|false] Control the busy footer animation",
    "  /status            Show the effective runtime configuration",
    "  /config            Show layered config sources and winning values",
    "  /config trust [status|on|off] Manage whether project config is allowed to load",
    "  /permissions       Open or update permissions and sandbox controls",
    "  /permissions status",
    "  /permissions approval-policy [status|inherit|untrusted|on-request|never]",
    "  /permissions sandbox [status|inherit|read-only|workspace-write|danger-full-access]",
    "  /permissions network [status|inherit|on|off]",
    "  /permissions writable-roots [list|add <path>|remove <path>|clear]",
    "  /runtime ...       Inspect or update runtime policy controls",
    "                     Compatibility surface; /permissions is the primary entry point",
    "  /runtime approval-policy [status|inherit|untrusted|on-request|never]",
    "  /runtime sandbox [status|inherit|read-only|workspace-write|danger-full-access]",
    "  /runtime network [status|inherit|on|off]",
    "  /runtime writable-roots [list|add <path>|remove <path>|clear]",
    "  /runtime service-tier [status|flex|fast]",
    "  /runtime personality [status|none|friendly|pragmatic]",
    "  /theme [name]      Switch theme directly (no arg opens picker)",
    "  /themes            Open visual theme picker (Up/Down + Enter)",
    "  /verbose           Toggle verbose mode (shows detailed processing info)",
    "  /auth [option]     Open auth panel or set auth preference",
    "  /auth status       Probe Codexa auth status",
    "  /login             Show guided ChatGPT subscription login steps",
    "  /logout            Show guided logout steps",
    "  /backends          List all available backends",
    "  /models            Open model picker",
    "  /workspace         Show the locked workspace for this session",
    "  /workspace relaunch <path> Restart the app in another workspace folder",
    `  Current reasoning: ${formatReasoningLabel(context.runtime.reasoningLevel)}`,
    `  Current plan mode: ${context.runtime.planMode ? "Enabled" : "Disabled"}`,
    "  /copy              Copy last response to clipboard",
    "  /paste-image       Attach the image currently on the clipboard",
    "  /update [status]   Check for updates and install the latest Codexa (status: cached result only)",
    "  /help              Show this help",
    "",
    "Local development:",
    "  npm run install:dev-bin  Install the codexa-dev command",
    "  codexa-dev               Run this repo without replacing codexa",
    "",
    "Shortcuts:",
    "  Ctrl+B    Open backend picker",
    "  Ctrl+O    Open model picker",
    "  Shift+Tab Rotate Plan → Read-only → Auto → Full Access",
    "  Ctrl+Alt+P Open provider picker",
    "  Ctrl+A    Open auth panel",
    "  Ctrl+V    Attach clipboard image (when forwarded by the terminal)",
    "  Ctrl+L    Clear chat and cancel active run",
    "  Esc       Cancel active run or shell command",
    "  Ctrl+Y    Cycle execution mode",
    "  Ctrl+C / Ctrl+Q    Quit",
    "  ↑ / ↓    Navigate input history",
  ].join("\n");
}

export function handleCommand(text: string, context: CommandContext): CommandResult | null {
  if (text.startsWith("/")) {
    const [rawCmd, ...argTokens] = text.slice(1).trim().split(/\s+/);
    const cmd = rawCmd?.toLowerCase() ?? "";
    const arg = argTokens.join(" ").trim();
    const normalizedArg = arg.toLowerCase();

    switch (cmd) {
      case "exit":
      case "quit":
        return { action: "exit" };

      case "clear":
        return { action: "clear" };

      case "backend": {
        if (!arg) return { action: "open_backend_picker" };
        if (AVAILABLE_BACKENDS.some((item) => item.id === arg)) {
          return {
            action: "backend",
            value: arg,
            message: `Backend switched to ${formatBackendLabel(arg)}`,
          };
        }
        return {
          action: "unknown",
          message: `Unknown backend: ${arg}. Use /backends to list available backends.`,
        };
      }

      case "providers":
      case "provider":
        return { action: "open_provider_picker" };

      case "route":
        return {
          action: "route_status",
          message: context.routeStatusMessage ?? [
            "Route status:",
            "  Workspace default: OpenAI",
            `  Active chat route: OpenAI / ${context.runtime.model}`,
            `  Active model: ${context.runtime.model}`,
            "  Active provider mode: Usable inside Codexa",
          ].join("\n"),
        };

      case "model": {
        if (!arg) return { action: "open_model_picker" };
        const detectedModels = context.modelCapabilities
          ? getSelectableModelCapabilities(context.modelCapabilities)
          : [];
        const detectedModel = detectedModels.find((model) => model.model === arg || model.id === arg);
        if (detectedModel) {
          return { action: "model", value: detectedModel.model, message: `Model switched to ${detectedModel.model}` };
        }
        if (!context.modelCapabilities && (AVAILABLE_MODELS as readonly string[]).includes(arg)) {
          return { action: "model", value: arg, message: `Model switched to ${arg}` };
        }
        return {
          action: "unknown",
          message: `Unknown model: ${arg}. Use /models to list available models.`,
        };
      }

      case "models":
        return { action: "open_model_picker" };

      case "mode": {
        if (!arg) {
          return {
            action: "mode",
            message: `Mode: ${context.runtime.planMode ? "Plan" : formatModeLabel(context.runtime.mode)}. Use Shift+Tab to rotate modes.`,
          };
        }
        if (normalizedArg === "plan") {
          return {
            action: "plan_mode",
            value: "on",
            message: "Plan mode enabled.",
          };
        }
        const resolvedMode = resolveModeCommand(arg);
        if (resolvedMode) {
          return {
            action: "mode",
            value: resolvedMode,
            message: `Mode switched to ${formatModeLabel(resolvedMode)}`,
          };
        }
        return {
          action: "unknown",
          message: `Unknown mode: ${arg}. Valid: ${formatModeCommandHelp()}`,
        };
      }

      case "reasoning": {
        if (!arg) return { action: "open_reasoning_picker" };
        const normalized = expandReasoningAliases(arg);
        const modelCapability = findModelCapability(context.modelCapabilities, context.runtime.model);
        const detectedLevels = modelCapability?.supportedReasoningLevels;
        if (detectedLevels && detectedLevels.some((item) => item.id === normalized)) {
          return {
            action: "reasoning",
            value: normalized,
            message: `Reasoning level switched to ${formatReasoningLabel(normalized)}`,
          };
        }
        if (detectedLevels) {
          const valid = detectedLevels.map((item) => item.id).join(", ");
          return {
            action: "unknown",
            message: `Unknown reasoning level for ${context.runtime.model}: ${arg}. Valid: ${valid}`,
          };
        }
        return {
          action: "reasoning",
          value: normalized,
          message: `Reasoning level switched to ${formatReasoningLabel(normalized)} (runtime metadata unavailable; unverified until runtime)`,
        };
      }

      case "plan": {
        if (!arg || normalizedArg === "status") {
          return {
            action: "plan_mode",
            message: `Plan mode: ${context.runtime.planMode ? "Enabled" : "Disabled"}.`,
          };
        }

        if (normalizedArg === "on" || normalizedArg === "off") {
          return {
            action: "plan_mode",
            value: normalizedArg,
            message: `Plan mode ${normalizedArg === "on" ? "enabled" : "disabled"}.`,
          };
        }

        return {
          action: "unknown",
          message: "Usage: /plan [on|off]",
        };
      }

      case "setting":
      case "settings": {
        if (!arg) {
          return { action: "open_settings_panel" };
        }

        if (normalizedArg === "workspace" || normalizedArg === "workspace-display" || normalizedArg === "directory") {
          return {
            action: "setting_workspace_display",
            message: [
              `Workspace display: ${formatWorkspaceDisplayModeLabel(context.settings.workspaceDisplayMode)} (${context.settings.workspaceDisplayMode})`,
              "Allowed values: dir, name, simple",
              "dir = show the current workspace folder name",
              "name = show Codexa",
              "simple = show only the final folder name",
            ].join("\n"),
          };
        }

        const workspaceSettingPrefix = ["workspace ", "workspace-display ", "directory "].find((prefix) => normalizedArg.startsWith(prefix));
        if (workspaceSettingPrefix) {
          const nextValue = normalizedArg.slice(workspaceSettingPrefix.length).trim();
          // "normal" was the legacy default label before "dir" was introduced
          const legacyMap: Record<string, WorkspaceDisplayMode> = {
            normal: normalizeLegacyDirectoryDisplayMode("normal"),
          };
          const mappedValue = legacyMap[nextValue] ?? nextValue;
          if (WORKSPACE_DISPLAY_MODES.includes(mappedValue as WorkspaceDisplayMode)) {
            const value = mappedValue as WorkspaceDisplayMode;
            return {
              action: "setting_workspace_display",
              value,
              message: `Workspace display set to ${formatWorkspaceDisplayModeLabel(value)} (${value}).`,
            };
          }

          return {
            action: "unknown",
            message: "Usage: /setting workspace [dir|name|simple]",
          };
        }

        if (normalizedArg === "terminal-title" || normalizedArg === "terminal") {
          return {
            action: "setting_terminal_title",
            message: [
              `Terminal title: ${formatWorkspaceDisplayModeLabel(context.settings.terminalTitleMode)} (${context.settings.terminalTitleMode})`,
              "Allowed values: dir, name, simple",
              "dir = show the current workspace folder name",
              "name = show Codexa",
              "simple = show only the final folder name",
            ].join("\n"),
          };
        }

        const terminalTitleSettingPrefix = ["terminal-title ", "terminal "].find((prefix) => normalizedArg.startsWith(prefix));
        if (terminalTitleSettingPrefix) {
          const nextValue = normalizedArg.slice(terminalTitleSettingPrefix.length).trim();
          if (WORKSPACE_DISPLAY_MODES.includes(nextValue as WorkspaceDisplayMode)) {
            const value = nextValue as TerminalTitleMode;
            return {
              action: "setting_terminal_title",
              value,
              message: `Terminal title set to ${formatWorkspaceDisplayModeLabel(value)} (${value}).`,
            };
          }

          return {
            action: "unknown",
            message: "Usage: /setting terminal-title [dir|name|simple]",
          };
        }

        if (normalizedArg === "busy-loader") {
          return {
            action: "setting_busy_loader",
            message: `Busy loader: ${context.settings.showBusyLoader ? "true" : "false"}`,
          };
        }

        if (normalizedArg.startsWith("busy-loader ")) {
          const nextValue = normalizedArg.slice("busy-loader ".length).trim();
          if (BUSY_LOADER_SETTING_VALUES.includes(nextValue as BusyLoaderSettingValue)) {
            return {
              action: "setting_busy_loader",
              value: nextValue,
              message: `Busy loader ${nextValue === "true" ? "enabled" : "disabled"}.`,
            };
          }

          return {
            action: "unknown",
            message: "Usage: /setting busy-loader [true|false]",
          };
        }

        return {
          action: "unknown",
          message: "Usage: /setting, /setting workspace [dir|name|simple], /setting terminal-title [dir|name|simple], or /setting busy-loader [true|false]",
        };
      }

      case "theme": {
        if (!arg) return { action: "open_theme_picker" };
        if (AVAILABLE_THEMES.some((item) => item.id === arg)) {
          return {
            action: "theme",
            value: arg,
            message: `Theme switched to ${formatThemeLabel(arg)}`,
          };
        }
        return {
          action: "unknown",
          message: `Unknown theme: ${arg}. Use /themes to list available themes.`,
        };
      }

      case "backends": {
        const list = AVAILABLE_BACKENDS
          .map((item, index) => `  ${index + 1}. ${item.label} (${item.id})`)
          .join("\n");
        return {
          action: "backends",
          message: `Available backends:\n${list}\n\nCurrent: ${formatBackendLabel(context.runtime.provider)}`,
        };
      }

      case "workspace": {
        if (!arg) {
          return {
            action: "workspace",
            message: context.workspace.summaryMessage,
          };
        }

        if (normalizedArg === "relaunch") {
          return {
            action: "unknown",
            message: "Usage: /workspace relaunch <path>",
          };
        }

        if (normalizedArg.startsWith("relaunch ")) {
          return {
            action: "workspace_relaunch",
            value: arg.slice("relaunch".length).trim(),
          };
        }

        return {
          action: "unknown",
          message: "Unknown workspace command. Use /workspace or /workspace relaunch <path>.",
        };
      }

      case "config": {
        if (!arg || normalizedArg === "status") {
          return {
            action: "config_status",
            message: formatLayeredConfigStatus(context.config),
          };
        }

        if (normalizedArg === "trust" || normalizedArg === "trust status") {
          return {
            action: "config_trust_status",
            message: [
              "Project trust:",
              `  Root: ${context.config.diagnostics.projectRoot}`,
              `  Status: ${context.config.diagnostics.projectTrusted ? "Trusted" : "Untrusted"}`,
            ].join("\n"),
          };
        }

        if (normalizedArg === "trust on" || normalizedArg === "trust off") {
          return {
            action: "config_trust_set",
            value: normalizedArg.endsWith("on") ? "on" : "off",
            message: `Project trust ${normalizedArg.endsWith("on") ? "enabled" : "disabled"}.`,
          };
        }

        return {
          action: "unknown",
          message: "Unknown config command. Use /config, /config status, or /config trust [status|on|off].",
        };
      }

      case "auth": {
        if (!arg) return { action: "open_auth_panel" };
        if (arg === "status") {
          return { action: "auth_status" };
        }
        if (AUTH_PREFERENCES.some((item) => item.id === arg)) {
          return {
            action: "auth",
            value: arg,
            message: `Auth preference set to ${formatAuthPreferenceLabel(arg)}`,
          };
        }
        return {
          action: "unknown",
          message: "Unknown auth option. Use /auth, /auth status, or one of the documented preference ids.",
        };
      }

      case "status":
        return {
          action: "status",
          message: [
            formatRuntimeStatus(context.resolvedRuntime, {
              workspaceRoot: context.workspace.root,
              tokensUsed: context.tokensUsed,
              projectInstructions: context.projectInstructions ?? null,
            }),
            context.routeStatusMessage,
          ].filter((line): line is string => Boolean(line)).join("\n\n"),
        };

      case "permissions": {
        if (!arg) {
          return { action: "open_permissions_panel" };
        }

        if (normalizedArg === "status") {
          return {
            action: "permissions_status",
            message: formatPermissionsStatus(
              context.runtime,
              context.resolvedRuntime,
              context.workspace.root,
            ),
          };
        }

        return handlePolicyCommand("/permissions", arg, context, false);
      }

      case "runtime": {
        if (!arg) {
          return {
            action: "status",
            message: formatRuntimeStatus(context.resolvedRuntime, {
              workspaceRoot: context.workspace.root,
              tokensUsed: context.tokensUsed,
            }),
          };
        }
        return handlePolicyCommand("/runtime", arg, context, true);
      }

      case "login":
        return { action: "login" };

      case "logout":
        return { action: "logout" };

      case "copy":
        return { action: "copy" };

      case "paste-image":
        return { action: "paste_image" };

      case "resume":
        return { action: "resume" };

      case "themes":
        return { action: "open_theme_picker" };


      case "verbose":
        return { action: "verbose_toggle" };

      case "debug": {
        if (normalizedArg === "renders") {
          return {
            action: "verbose_toggle",
            message: formatRenderCounts(),
          };
        }
        return { action: "verbose_toggle" };
      }

      case "diagnose": {
        if (normalizedArg === "github") {
          return {
            action: "diagnose_github",
            message: "Running GitHub connectivity diagnostics...",
          };
        }
        if (normalizedArg === "providers") {
          return {
            action: "diagnose_providers",
            message: "Collecting provider diagnostics...",
          };
        }
        return {
          action: "unknown",
          message: "Usage: /diagnose github|providers",
        };
      }

      case "help":
        return { action: "help", message: buildHelpMessage(context) };

      case "update":
        // Bare /update forces a fresh registry check; /update status is the
        // explicit no-network path that reuses the cached/in-memory result.
        return { action: "update", value: normalizedArg || "check" };

      default:
        return {
          action: "unknown",
          message: `Unknown command: /${cmd}. Type /help for available commands.`,
        };
      }
  }

  // "?cmd" is a common mistype of "/cmd" — suggest the corrected form
  if (text.startsWith("?")) {
    const potentialCmd = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return {
      action: "unknown",
      message: `Invalid command syntax: ${text}. Use /help for available commands. Did you mean /${potentialCmd}?`,
    };
  }

  return null;
}
