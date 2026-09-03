import React, { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "node:path";

// Diagnostic tracing hook — no-op by default; wire to a real logger when debugging.
function appDiagLog(msg: string): void {
  void msg;
}

function normalizeRuntimeAvailability(value: unknown): RuntimeAvailability {
  if (value === "checking" || value === "reconnecting") return value;
  if (value === "available") return "available";
  if (value === "unavailable" || value === "no-models") return "unavailable";
  return "unknown";
}

function formatRuntimeProviderLabel(providerId: ProviderId): string {
  if (providerId === "local") return "Local";
  if (providerId === "codexa-native" || providerId === "codexa-cupy") return "Codexa Native";
  if (providerId === "google") return "Google";
  if (providerId === "anthropic") return "Anthropic";
  if (providerId === "mistral") return "Mistral Vibe CLI";
  if (providerId === "antigravity") return "Antigravity";
  return "OpenAI";
}

interface ProviderSetupPlan {
  installCommand: string | null;
  setupCommand: string;
}

function getProviderSetupPlan(providerId: ProviderId, windows: boolean): ProviderSetupPlan {
  switch (providerId) {
    case "openai":
      return { installCommand: "npm install -g @openai/codex", setupCommand: "codex login" };
    case "anthropic":
      return { installCommand: "npm install -g @anthropic-ai/claude-code", setupCommand: "claude" };
    case "google":
      return { installCommand: "npm install -g @google/gemini-cli", setupCommand: "gemini" };
    case "mistral":
      return windows
        ? { installCommand: "if (Get-Command uv -ErrorAction SilentlyContinue) { uv tool install mistral-vibe } else { irm https://astral.sh/uv/install.ps1 | iex; uv tool install mistral-vibe }", setupCommand: "vibe --setup" }
        : { installCommand: "curl -LsSf https://mistral.ai/vibe/install.sh | bash", setupCommand: "vibe --setup" };
    case "antigravity":
      return windows
        ? { installCommand: "irm https://antigravity.google/cli/install.ps1 | iex", setupCommand: "agy" }
        : { installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash", setupCommand: "agy" };
    default:
      return { installCommand: null, setupCommand: "" };
  }
}

function readDiagnosticString(
  diagnostics: Record<string, string | number | boolean | null> | undefined,
  keys: string[],
): string | null {
  if (!diagnostics) return null;
  for (const key of keys) {
    const value = diagnostics[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}
import { Box, Text, useApp, useFocusManager, useInput, useStdin, useStdout } from "ink";
import { expandPastedContent, type PastedContentRegistry } from "./ui/input/pastedContent.js";
import { useStdinRawModeLease } from "./ui/input/useStdinRawModeLease.js";
import { handleCommand } from "./commands/handler.js";
import {
  applyLayeredRuntimeOverride,
  resolveLayeredConfig,
  type LayeredConfigResult,
} from "./config/layeredConfig.js";
import type { LaunchArgs } from "./config/launchArgs.js";
import { loadSettings, saveRuntimeModePreference, saveSettings } from "./config/persistence.js";
import {
  APP_VERSION,
  type AuthPreference,
  type AvailableBackend,
  type AvailableMode,
  type AvailableModel,
  parseBusyLoaderSettingValue,
  type ReasoningLevel,
  USER_SETTING_DEFINITIONS,
  type WorkspaceDisplayMode,
  type UserSettingValues,
  estimateTokens,
  formatBusyLoaderSettingValue,
  formatAuthPreferenceLabel,
  formatBackendLabel,
  formatWorkspaceDisplayModeLabel,
  formatModeLabel,
  formatReasoningLabel,
  formatThemeLabel,
  formatWorkspaceDisplayPath,
  getNextRotatingMode,
  type HeaderConfig,
  type TerminalTitleMode,
} from "./config/settings.js";
import {
  AVAILABLE_APPROVAL_POLICIES,
  AVAILABLE_NETWORK_ACCESS_VALUES,
  AVAILABLE_SANDBOX_MODES,
  addWritableRoot,
  buildRuntimeSummary,
  clearWritableRoots,
  diffRuntimeConfig,
  formatApprovalPolicyLabel,
  formatNetworkAccessLabel,
  formatPersonalityLabel,
  formatSandboxModeLabel,
  formatServiceTierLabel,
  mergeRuntimeConfig,
  removeWritableRoot,
  resolveRuntimeConfig,
  resolveWritableRootCommandPath,
  type PartialRuntimeConfig,
  type RuntimeApprovalPolicy,
  type RuntimeConfig,
  type RuntimeNetworkAccess,
  type RuntimePersonality,
  type RuntimeSandboxMode,
  type RuntimeServiceTier,
} from "./config/runtimeConfig.js";
import { setProjectTrust } from "./config/trustStore.js";
import {
  type CodexAuthProbeResult,
  getAuthStatusMessage,
  getLoginGuidance,
  getLogoutGuidance,
  getRunGateDecision,
  isLikelyAuthFailure,
  probeCodexAuthStatus,
} from "./core/auth/codexAuth.js";
import { copyToClipboard } from "./core/shared/clipboard.js";
import { normalizePlanReviewMarkdown, savePlan, readPlan } from "./core/workspace/planStorage.js";
import { getBlockedCleanupFailure } from "./core/shared/cleanupFastFail.js";
import { runShellCommand, summarizeCommandResult } from "./core/process/CommandRunner.js";
import {
  buildPlanExecutionPrompt,
  buildPlanningPrompt,
  detectHollowResponse,
  isClearlySafeGeneratedCleanupRequest,
  resolveExecutionMode,
} from "./core/codex/codexPrompt.js";
import { formatHollowResponse } from "./core/shared/hollowResponseFormat.js";
import {
  createFallbackModelCapabilities,
  findModelCapability,
  formatModelCapabilitiesList,
  getCodexModelCapabilities,
  getPreferredModelFromCapabilities,
  getSelectableModelCapabilities,
  normalizeReasoningForModelCapabilities,
  type CodexModelCapabilities,
} from "./core/models/codexModelCapabilities.js";
import { loadSeededCodexCapabilities } from "./core/models/codexModelsCacheSeed.js";
import {
  buildWorkspaceCommandContext,
  createWorkspaceRelaunchPlan,
  guardWorkspaceRelaunch,
  type LaunchContext,
  resolveLaunchContext,
} from "./core/workspace/launchContext.js";
import {
  findOutsideWorkspacePaths,
  formatSkippedDependencyPath,
  getPromptWorkspaceGuardMessage,
  getShellWorkspaceGuardMessage,
} from "./core/workspace/workspaceGuard.js";
import {
  formatContextCompact,
  formatContextLength,
  resolveModelContextLength,
  type ModelContextMetadata,
} from "./core/providerRuntime/contextMetadata.js";
import { captureWorkspaceSnapshot, createWorkspaceActivityTracker, diffWorkspaceSnapshots } from "./core/workspace/workspaceActivity.js";
import { resolveWorkspaceRoot } from "./core/workspace/workspaceRoot.js";
import { resolveCodexaAttachmentDir } from "./core/workspace/appData.js";
import { ConversationStore, type ConversationListEntry, type ConversationMessage, type ConversationRecord } from "./core/workspace/conversationStore.js";
import {
  importExternalFile,
  isImageFile,
  rewritePromptWithImportedPaths,
} from "./core/shared/attachments.js";
import { loadProjectInstructions } from "./core/workspace/projectInstructions.js";
import { isNoiseLine } from "./core/providers/codexTranscript.js";
import { getBackendProvider } from "./core/providers/registry.js";
import type {
  BackendProgressUpdate,
  BackendProvider,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "./core/providers/types.js";
import { commandExistsOnPath, launchProviderCli } from "./core/providerLauncher/launcher.js";
import { buildProviderRegistry, findProvider, getActiveRouteProviderId, isKnownProviderId } from "./core/providerLauncher/registry.js";
import type { LocalBackendId, ProviderId, ProviderPickerAction, ProviderWorkspaceConfig } from "./core/providerLauncher/types.js";
import {
  discoverProviderModels,
  getProviderRouteSetupMessage,
  getProviderRuntime,
  isProviderRouteConfigured,
  isProviderRoutableInCodexa,
  persistProviderDiscovery,
  resolveActiveProviderRoute,
  validateProviderRouteActivation,
} from "./core/providerRuntime/registry.js";
import { hasGeminiApiKey, runGeminiDiagnostics } from "./core/providerRuntime/gemini.js";
import { checkLocalProvider, runLocalDiagnostics, setLocalProviderConfig } from "./core/providerRuntime/local.js";
import { closeLocalHarnessSession, shutdownLocalHarness } from "./core/providerRuntime/localHarness/runtime.js";
import {
  detectVibeActiveModel,
  launchMistralVibeCli,
  resetMistralVibeSession,
  resolveVibeExecutable,
} from "./core/providerRuntime/mistralVibe.js";
import { validateAnthropicRoute, ANTHROPIC_ROUTE_SETUP_MESSAGE } from "./core/providerRuntime/anthropic.js";
import { providerModelsToCodexCapabilities } from "./core/providerRuntime/models.js";
import {
  loadProviderWorkspaceConfig,
  saveProviderWorkspaceConfig,
  setProviderActiveRoute,
  setProviderDefaultReasoning,
  setProviderDefaultModel,
  setLocalBackendPreference,
  setProviderWorkspaceDefault,
} from "./core/providerLauncher/workspaceConfig.js";
import { sanitizeTerminalInput, sanitizeTerminalLines, sanitizeTerminalOutput } from "./core/terminal/terminalSanitize.js";
import { createTerminalModeController, setTerminalControlUIState } from "./core/terminal/terminalControl.js";
import { resolveInkRenderInstance, resetInkOutputForFreshFrame } from "./core/terminal/inkRenderReset.js";
import { createClearFrameBoundaryController } from "./core/terminal/clearFrameBoundary.js";
import {
  setTerminalTitleLifecycleState,
} from "./core/terminal/terminalTitle.js";
import { getStdinDebugState, traceInputDebug } from "./core/debug/inputDebug.js";
import { traceModelStateDebug } from "./core/debug/modelStateDebug.js";
import * as perf from "./core/perf/profiler.js";
import * as renderDebug from "./core/perf/renderDebug.js";
import {
  checkGhCli,
  checkLocalGitRemote,
  checkLocalGitWrite,
  classifyDiagnostics,
  getLocalGitRemoteUrl,
  parseRepoIdentity,
  type DiagnosticResult,
} from "./core/shared/githubDiagnostics.js";
import type { RunEvent, Screen, ShellEvent, TimelineEvent, UIState, UserPromptEvent } from "./session/types.js";
import {
  buildFollowUpPrompt,
  createRunEvent,
  extractAssistantActionRequired,
  guardConfigMutation,
  isCurrentRun,
} from "./session/chatLifecycle.js";
import { findUserPrompt, useAppSessionState } from "./session/appSession.js";
import { conversationMessagesToTimeline, selectConversationContext } from "./session/conversation.js";
import { selectPersistedAssistantResponse } from "./session/persistedResponse.js";
import { createLiveRenderScheduler, type LiveRenderUpdate } from "./session/liveRenderScheduler.js";
import { hasFinalizedTranscriptPlan } from "./session/planTranscript.js";
import { schedulePromptRunStartAfterVisibleCommit } from "./session/promptRunSchedule.js";
import {
  approvePlanExecution,
  beginPlanFeedback,
  cancelPlanFeedback,
  createInitialPlanFlowState,
  finishPlanGeneration,
  resetPlanFlow,
  startPlanGeneration,
  submitPlanFeedback,
  type PlanFlowState,
} from "./session/planFlow.js";
import { AuthPanel } from "./ui/panels/AuthPanel.js";
import { BackendPicker } from "./ui/panels/BackendPicker.js";
import { measureBottomComposerRows, MemoizedBottomComposer } from "./ui/chrome/BottomComposer.js";
import { resolveStartupHeaderMode, useTerminalViewport } from "./ui/layout.js";
import { ModelPickerScreen } from "./ui/panels/ModelPickerScreen.js";
import { ModePicker } from "./ui/panels/ModePicker.js";
import { PlanActionPicker, type PlanActionValue, measurePlanActionPickerRows } from "./ui/panels/PlanActionPicker.js";
import { PermissionsPanel, type PermissionsPanelAction } from "./ui/panels/PermissionsPanel.js";
import { ProviderPicker, type LocalBackendStatus } from "./ui/panels/ProviderPicker.js";
import { ProviderSetupPrompt } from "./ui/panels/ProviderSetupPrompt.js";
import { ReasoningPicker } from "./ui/panels/ReasoningPicker.js";
import { AttachmentImportPanel, type PendingImportFile } from "./ui/panels/AttachmentImportPanel.js";
import { ToolApprovalPanel } from "./ui/panels/ToolApprovalPanel.js";
import { SelectionPanel } from "./ui/panels/SelectionPanel.js";
import { SettingsPanel } from "./ui/panels/SettingsPanel.js";
import { UpdatePromptPanel } from "./ui/panels/UpdatePromptPanel.js";
import { ResumePicker } from "./ui/panels/ResumePicker.js";
import { measureTextEntryPanelRows, TextEntryPanel } from "./ui/panels/TextEntryPanel.js";
import { ThemePicker } from "./ui/panels/ThemePicker.js";
import { getFocusTargetForScreen, FOCUS_IDS } from "./ui/input/focus.js";
import { ThemeProvider, THEMES } from "./ui/theme.js";
import { buildActiveRuntimeDisplay, runtimeDisplayToSummary } from "./ui/render/runtimeDisplay.js";
import {
  cancelThemeSelection,
  commitThemeSelection,
  getDisplayedThemeName,
  previewThemeSelection,
  shouldBumpComposerInstance,
  type ThemeSelectionState,
} from "./ui/themeFlow.js";
import { isBusy as isUiBusy } from "./session/types.js";
import { AppShell } from "./ui/chrome/AppShell.js";
import { TranscriptShell } from "./ui/timeline/TranscriptShell.js";
import { resetTimelineMeasureCaches } from "./ui/timeline/timelineMeasure.js";
import type { RuntimeAvailability } from "./ui/chrome/RuntimeStatusBar.js";
import { checkForUpdates, formatLocalDevUpdateStatus, formatUpdateInstructions, shouldRunStartupUpdateCheck, type UpdateCheckResult } from "./core/version/updateCheck.js";
import { detectGlobalPackageManager, getUpdateCommand } from "./core/version/packageManager.js";
import { isLocalDevChannel } from "./core/version/channel.js";
import {
  isCacheForRunningVersion,
  loadUpdateCheckCache,
  saveUpdateCheckCache,
} from "./config/updateCheckCache.js";
import { DEFAULT_UPDATE_CHECK_SETTINGS } from "./config/persistence.js";

// ─── Module Constants & Helpers ────────────────────────────────────────────────


let nextEventId = 0;
let nextTurnId = 0;
// 50ms keeps assistant text live while avoiding frame-wide terminal repaint
// churn during streaming/action updates.
const LIVE_UPDATE_FLUSH_MS = 50;
const PROGRESS_ONLY_FLUSH_MS = 175;

function formatWritableRootsMessage(roots: readonly string[]): string {
  return roots.length > 0
    ? roots.map((root) => `  - ${root}`).join("\n")
    : "  - none";
}

function createEventId(): number {
  return nextEventId++;
}

function createTurnId(): number {
  return nextTurnId++;
}

function createProviderMigrationNoticeEvent(
  notice: ProviderWorkspaceConfig["migrationNotice"] | undefined,
  providerLabel: string | null = null,
): TimelineEvent | null {
  if (!notice) return null;

  const resolvedProviderLabel = providerLabel ?? formatRuntimeProviderLabel(notice.revertedProviderId);
  return {
    id: createEventId(),
    type: "system",
    createdAt: Date.now(),
    title: sanitizeTerminalOutput("Provider migrated"),
    content: sanitizeTerminalOutput(
      `${formatRuntimeProviderLabel(notice.deprecatedProviderId as ProviderId)} provider is no longer supported. Reverted to ${resolvedProviderLabel}.`,
      { preserveTabs: false, tabSize: 2 },
    ),
  };
}

function createStartupStaticEvents({
  providerWorkspaceConfig,
}: {
  providerWorkspaceConfig: ProviderWorkspaceConfig;
}): TimelineEvent[] {
  return [
    createProviderMigrationNoticeEvent(providerWorkspaceConfig.migrationNotice),
  ].filter((event): event is TimelineEvent => event !== null);
}

function createInitialAuthStatus(): CodexAuthProbeResult {
  return {
    state: "checking",
    checkedAt: 0,
    rawSummary: "Auth check pending.",
    recommendedAction: "Run /auth status to check sign-in state.",
  };
}

interface AppProps {
  launchArgs: LaunchArgs;
}

interface PromptRunTiming {
  submitEpochMs: number;
  submitMonotonicMs: number;
}

interface PromptRunLifecycle {
  parseActionRequired?: boolean;
  disableModeAutoUpgrade?: boolean;
  runtimeOverride?: PartialRuntimeConfig;
  responsePresentation?: "assistant" | "plan";
  approvedPlan?: string;
  submitTiming?: PromptRunTiming;
  commitPrompt?: boolean;
  runIntent?: "normal" | "plan" | "approved-execution";
  onCompleted?: (result: { response: string; turnId: number; runId: number }) => void;
  onFailed?: (result: { message: string; turnId: number; runId: number }) => void;
  onCanceled?: (result: { turnId: number; runId: number }) => void;
}

function createPromptRunTiming(): PromptRunTiming {
  return {
    submitEpochMs: Date.now(),
    submitMonotonicMs: performance.now(),
  };
}

export function App({ launchArgs }: AppProps) {
  const { exit } = useApp();
  const focusManager = useFocusManager();
  const workspaceRoot = useMemo(() => resolveWorkspaceRoot(), []);
  const projectInstructionsLoad = useMemo(() => loadProjectInstructions(workspaceRoot), [workspaceRoot]);
  const projectInstructions = projectInstructionsLoad.status === "loaded"
    ? projectInstructionsLoad.instructions
    : null;
  const initialSettings = useRef(loadSettings());
  const startupUpdateEnabled = useRef(shouldRunStartupUpdateCheck(
    process.env,
    (initialSettings.current.updateCheck ?? DEFAULT_UPDATE_CHECK_SETTINGS).enabled,
  ));
  const initialUpdateCheckResult = useRef<UpdateCheckResult | null>((() => {
    if (!startupUpdateEnabled.current) return null;
    const cache = loadUpdateCheckCache();
    if (!cache?.updateAvailable || !cache.latestVersion || !isCacheForRunningVersion(cache, APP_VERSION)) {
      return null;
    }
    return {
      status: "update-available",
      currentVersion: cache.currentVersion,
      latestVersion: cache.latestVersion,
      checkedAt: cache.lastChecked,
      source: "cache",
    };
  })());
  const initialProviderWorkspaceConfig = useRef<ProviderWorkspaceConfig>(loadProviderWorkspaceConfig(workspaceRoot));
  const initialLayeredConfig = useRef<LayeredConfigResult | null>(null);
  if (initialLayeredConfig.current === null) {
    initialLayeredConfig.current = resolveLayeredConfig({ workspaceRoot, launchArgs });
  }
  const launchContext = useMemo(
    () => resolveLaunchContext({ workspaceRoot, forwardArgs: launchArgs.passthroughArgs }),
    [launchArgs.passthroughArgs, workspaceRoot],
  );
  const workspaceCommandContext = useMemo(
    () => buildWorkspaceCommandContext(launchContext),
    [launchContext],
  );
  const terminalLayout = useTerminalViewport();
  // Assigned during render (like screenRef) so the clear-frame boundary can
  // tell, at frame-write time, whether the committing tree was laid out
  // against the current terminal width (the viewport hook commits dimensions
  // on a trailing settle, so frames can lag stdout.columns).
  const terminalLayoutColsRef = useRef<number | undefined>(terminalLayout.rawCols ?? terminalLayout.cols);
  terminalLayoutColsRef.current = terminalLayout.rawCols ?? terminalLayout.cols;
  const [staticRepaintGeneration, bumpStaticRepaintGeneration] = useState(0);
  const staticRepaintGenerationRef = useRef(0);
  staticRepaintGenerationRef.current = staticRepaintGeneration;

  // ─── State & Refs ────────────────────────────────────────────────────────────

  const [baseLayeredConfig, setBaseLayeredConfig] = useState<LayeredConfigResult>(initialLayeredConfig.current);
  const [sessionRuntimeOverride, setSessionRuntimeOverride] = useState<PartialRuntimeConfig>(() => {
    const initialRoute = initialProviderWorkspaceConfig.current.activeRoute;
    if (!initialRoute || !isProviderRoutableInCodexa(initialRoute.providerId)) {
      return {};
    }

    // When --model was given on the CLI, that arg must win over the persisted activeRoute
    // model so that explicit test/benchmark model flags are actually honoured for the session.
    const cliModel = launchArgs.modelOverride;
    return {
      model: cliModel ?? initialRoute.modelId,
      ...(initialRoute.reasoning ? { reasoningLevel: initialRoute.reasoning } : {}),
    };
  });
  const [authPreference, setAuthPreference] = useState<AuthPreference>(initialSettings.current.auth.preference);
  const [workspaceDisplayMode, setWorkspaceDisplayMode] = useState<WorkspaceDisplayMode>(
    initialSettings.current.ui.workspaceDisplayMode,
  );
  const [terminalTitleMode, setTerminalTitleMode] = useState<TerminalTitleMode>(
    initialSettings.current.ui.terminalTitleMode,
  );
  const [showBusyLoader, setShowBusyLoader] = useState(
    initialSettings.current.ui.showBusyLoader,
  );
  const [providerWorkspaceConfig, setProviderWorkspaceConfig] = useState<ProviderWorkspaceConfig>(
    initialProviderWorkspaceConfig.current,
  );
  const [localBackendStatuses, setLocalBackendStatuses] = useState<Record<LocalBackendId, LocalBackendStatus>>({
    "lm-studio": { state: "idle", label: "Not checked" },
    unsloth: { state: "idle", label: "Not checked" },
  });
  const [pendingRouteProviderId, setPendingRouteProviderId] = useState<ProviderId | null>(null);
  const [providerSetup, setProviderSetup] = useState<ProviderId | null>(null);
  const providerLaunchBypassRef = useRef(false);
  const providerActionRef = useRef<((providerId: ProviderId, action: ProviderPickerAction, localBackend?: LocalBackendId) => void) | null>(null);
  const [themeSelection, setThemeSelection] = useState<ThemeSelectionState>({
    committedTheme: initialSettings.current.ui.theme,
    previewTheme: null,
  });
  const [themeNotice, setThemeNotice] = useState<string | null>(null);
  const [customTheme, setCustomTheme] = useState(initialSettings.current.ui.customTheme);
  const [headerConfig] = useState(initialSettings.current.header);
  // Hold the first interactive frame behind the update check. A cached update
  // opens immediately; an uncached launch shows a short checking panel instead
  // of allowing input and interrupting the user a moment later.
  const [screen, setScreen] = useState<Screen>(
    startupUpdateEnabled.current ? "update-prompt" : "main",
  );
  // A startup update check can be the first frame Ink ever renders. Do not
  // pre-mount TranscriptShell hidden in that case: its <Static> intro would be
  // consumed before the normal buffer has received it, leaving only the live
  // composer/footer when the overlay exits. Mount it fresh on the first real
  // main-screen render, then keep it mounted across later overlays so normal
  // transcript/static-buffer preservation continues to work.
  const transcriptHasMountedRef = useRef(screen === "main");
  const shouldMountTranscript = screen === "main" || transcriptHasMountedRef.current;
  if (screen === "main") {
    transcriptHasMountedRef.current = true;
  }
  const [pendingImport, setPendingImport] = useState<{
    prompt: string;
    providerPrompt: string;
    files: PendingImportFile[];
    attachmentsDir: string;
  } | null>(null);
  const pastedContentRegistryRef = useRef<PastedContentRegistry>(new Map());
  const [toolApproval, setToolApproval] = useState<ToolApprovalRequest | null>(null);
  const toolApprovalResolverRef = useRef<((decision: ToolApprovalDecision) => void) | null>(null);
  const [registryNonce, setRegistryNonce] = useState(0);
  const screenRef = useRef<Screen>("main");
  screenRef.current = screen;
  const [composerInstanceKey, setComposerInstanceKey] = useState(0);
  // Bumped purely to force one extra React commit when the /clear boundary needs
  // the authoritative post-clear frame flushed (see the syncRenderState effect).
  const [, bumpPostClearRepaint] = useState(0);
  const { state: sessionState, dispatch: dispatchSession } = useAppSessionState(() => {
    return createStartupStaticEvents({
      providerWorkspaceConfig: initialProviderWorkspaceConfig.current,
    });
  });
  const conversationStore = useMemo(
    () => new ConversationStore(workspaceRoot, {
      onDiagnostic: (message) => appDiagLog(`CONVERSATION_STORE: ${message}`),
    }),
    [workspaceRoot],
  );
  const activeConversationRef = useRef<ConversationRecord | null>(null);
  const [conversationRouteOverride, setConversationRouteOverride] = useState<import("./core/providerRuntime/types.js").ProviderRoute | null>(null);
  const [resumeConversations, setResumeConversations] = useState<ConversationListEntry[]>([]);
  const [authStatus, setAuthStatus] = useState<CodexAuthProbeResult>(createInitialAuthStatus());
  const [authStatusBusy, setAuthStatusBusy] = useState(false);
  // Running character total across the conversation — used to estimate token usage
  const [conversationChars, setConversationChars] = useState(0);
  const rolloverResponseCharsRef = useRef(0);
  // Seeded synchronously from local caches (codex's models_cache.json or the
  // persisted last-good discovery) so the model picker opens instantly with
  // real models; live discovery replaces this in the background.
  const [modelCapabilities, setModelCapabilities] = useState<CodexModelCapabilities | null>(() => loadSeededCodexCapabilities());
  const [modelCapabilitiesBusy, setModelCapabilitiesBusy] = useState(false);
  // True while a provider route switch is validating (subprocess probes);
  // drives the model picker's loading state for non-openai providers.
  const [routeSwitchBusy, setRouteSwitchBusy] = useState(false);
  const [providerModelLoading, setProviderModelLoading] = useState<Record<string, boolean>>({});
  const [providerModelErrors, setProviderModelErrors] = useState<Record<string, string>>({});
  const [activeContextMetadata, setActiveContextMetadata] = useState<ModelContextMetadata | null>(null);
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  // Keep Ink's raw-mode refcount above zero for the whole session so composer
  // remounts (overlay exit shell swap + instance key bump) never detach Ink's
  // stdin reader; see useStdinRawModeLease.
  useStdinRawModeLease();
  const terminalControl = useMemo(() => createTerminalModeController((chunk) => stdout.write(chunk)), [stdout]);
  // Live Ink instance behind this stdout, used to reset Ink's frame caches on
  // the /clear boundary so the next frame is authoritative (see handleClear).
  const inkInstance = useMemo(() => resolveInkRenderInstance(stdout), [stdout]);
  const clearFrameBoundaryController = useMemo(
    () => createClearFrameBoundaryController({
      instance: inkInstance,
      terminalControl,
      stdout,
      source: "src/app.tsx:clearBoundary",
      onWidthResizeRefresh: () => bumpStaticRepaintGeneration((tick) => tick + 1),
      getRenderedRepaintGeneration: () => staticRepaintGenerationRef.current,
      getRenderedLayoutCols: () => terminalLayoutColsRef.current,
      // Read at frame-write time; screenRef is assigned during render, so it
      // always reflects the render that produced the frame being written.
      isOverlayActive: () => screenRef.current !== "main",
    }),
    [inkInstance, stdout, terminalControl],
  );
  const [verboseMode, setVerboseMode] = useState(false);
  const [planFlow, setPlanFlow] = useState<PlanFlowState>(createInitialPlanFlowState);
  const [initialRevisionText, setInitialRevisionText] = useState("");
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(initialUpdateCheckResult.current);
  // Launcher path is fixed for the process lifetime, so detect once.
  const globalPackageManager = useMemo(() => detectGlobalPackageManager(), []);
  const overlayMode = screen !== "main";

  // ─── Effects & Handlers ──────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      clearFrameBoundaryController?.dispose();
    };
  }, [clearFrameBoundaryController]);

  useEffect(() => {
    if (!clearFrameBoundaryController) return;
    const postClearRepaintPending = clearFrameBoundaryController.syncRenderState({
      generation: sessionState.clearEpoch,
      staticEventsLength: sessionState.staticEvents.length,
      activeEventsLength: sessionState.activeEvents.length,
      transcriptCleared: sessionState.staticEvents.length === 0 && sessionState.activeEvents.length === 0,
      clearGenerationReady: sessionState.clearEpoch > 0 && sessionState.uiState.kind === "IDLE" && sessionState.activeEvents.length === 0,
      uiStateKind: sessionState.uiState.kind,
    });
    if (postClearRepaintPending) {
      // Ink already wrote (and suppressed) the cleared frame during the commit
      // that preceded this passive effect, so the boundary's gate only became
      // satisfiable just now. Force one more commit to deterministically flush
      // the authoritative post-clear frame instead of waiting on an incidental
      // later render. `bumpPostClearRepaint` is not an effect dependency, so this
      // re-render does not re-run the effect (no loop).
      bumpPostClearRepaint((tick) => tick + 1);
    }
  }, [clearFrameBoundaryController, sessionState]);

  useLayoutEffect(() => {
    // The clear-frame boundary owns alternate-screen switching so the buffer
    // flip happens atomically with the first frame of the new screen (see
    // clearFrameBoundary.ts). Toggling from an effect would run after Ink has
    // already written that frame into the wrong buffer — the overlay would
    // land in the normal buffer's scrollback and the alt screen would open
    // blank. This effect is only a fallback for environments where no live
    // Ink instance could be resolved (tests, exotic Ink versions).
    if (clearFrameBoundaryController) return;
    terminalControl.setAlternateScreen(
      overlayMode,
      overlayMode ? "src/app.tsx:overlay.enterAlternateScreen" : "src/app.tsx:overlay.exitAlternateScreen",
    );
  }, [clearFrameBoundaryController, overlayMode, terminalControl]);

  useEffect(() => {
    return () => {
      terminalControl.setAlternateScreen(false, "src/app.tsx:overlay.cleanupAlternateScreen");
    };
  }, [terminalControl]);

  const cleanupRef = useRef<(() => void) | null>(null);
  const activeRunLifecycleRef = useRef<PromptRunLifecycle | null>(null);
  const activeRunTimingRef = useRef<(PromptRunTiming & { runId: number; turnId: number }) | null>(null);
  const isMountedRef = useRef(true);
  const activeRunIdRef = useRef<number | null>(null);
  const activeTurnIdRef = useRef<number | null>(null);
  const clearEpochRef = useRef<number>(0); // Incremented on /clear to suppress stale command events
  const externalCliStatusRef = useRef(sessionState.externalCliStatus);
  const previousScreenRef = useRef<Screen>("main");
  const themePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const themeNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelDiscoveryInFlightRef = useRef<Promise<CodexModelCapabilities> | null>(null);
  const modelDiscoveryAnnounceRef = useRef(false);
  const intendedInputModeRef = useRef<"chat/input" | "model-picker">("chat/input");
  const intendedFocusTargetRef = useRef<string>(FOCUS_IDS.composer);
  const modelSelectionInFlightRef = useRef(false);
  // Async provider validation/model discovery must not infer that the picker
  // should close. This ref is set only by explicit picker open/close actions.
  const modelPickerOpenRef = useRef(false);
  const providerModelRefreshesRef = useRef(new Map<ProviderId, Promise<unknown>>());
  const localBackendCheckInFlightRef = useRef(new Map<LocalBackendId, ReturnType<typeof checkLocalProvider>>());
  const providerModelsLoadedRef = useRef(new Set<ProviderId>());
  const providerRouteErrorsRef = useRef<Record<string, string>>({});
  const providerDiagnosticsRef = useRef<Record<string, Record<string, string | number | boolean | null>>>({});
  const providerMigrationNoticeShownRef = useRef(Boolean(initialProviderWorkspaceConfig.current.migrationNotice));
  const initialPromptSubmittedRef = useRef(false);
  const activeThemeName = getDisplayedThemeName(themeSelection);
  const activeTheme =
    activeThemeName === "custom"
      ? { ...THEMES.purple, ...customTheme }
      : (THEMES[activeThemeName] ?? THEMES.purple);
  const baseRuntimeConfigRef = useRef(baseLayeredConfig.runtime);
  const layeredRuntimeConfig = useMemo(
    () => applyLayeredRuntimeOverride(baseLayeredConfig, sessionRuntimeOverride, "In-session overrides"),
    [baseLayeredConfig, sessionRuntimeOverride],
  );
  const runtimeConfig = layeredRuntimeConfig.runtime;
  const { provider: backend, model, mode, reasoningLevel, planMode } = runtimeConfig;
  const resolvedRuntimeConfig = useMemo(() => resolveRuntimeConfig(runtimeConfig), [runtimeConfig]);
  const runtimeSummary = useMemo(() => buildRuntimeSummary(resolvedRuntimeConfig), [resolvedRuntimeConfig]);
  const activeProviderRoute = useMemo(() => {
    // When --model was given on the CLI, override the stored activeRoute's modelId so
    // the actual run uses the CLI model instead of whatever is persisted in providers.json.
    // The providers.json entry is left unchanged so it survives this session.
    const cliModel = launchArgs.modelOverride;
    const configuredRoute = conversationRouteOverride ?? providerWorkspaceConfig.activeRoute;
    const effectiveRoute = cliModel && configuredRoute
      ? { ...configuredRoute, modelId: cliModel }
      : configuredRoute;
    return resolveActiveProviderRoute({
      workspaceConfigActiveRoute: effectiveRoute,
      currentModel: model,
      currentReasoning: reasoningLevel,
    });
  }, [conversationRouteOverride, launchArgs.modelOverride, model, providerWorkspaceConfig.activeRoute, reasoningLevel, registryNonce]);
  const previousProviderRouteRef = useRef(activeProviderRoute);
  useEffect(() => {
    const previous = previousProviderRouteRef.current;
    const changed = previous.providerId !== activeProviderRoute.providerId
      || previous.modelId !== activeProviderRoute.modelId
      || previous.localBackend !== activeProviderRoute.localBackend;
    if (changed && previous.providerId === "local") {
      void closeLocalHarnessSession(activeConversationRef.current?.metadata.localHarnessSession?.sessionId);
    }
    previousProviderRouteRef.current = activeProviderRoute;
  }, [activeProviderRoute]);
  const activeProviderRuntime = useMemo(
    () => getProviderRuntime(activeProviderRoute.providerId),
    [activeProviderRoute.providerId],
  );
  const providerRegistry = useMemo(
    () => {
      setLocalProviderConfig(providerWorkspaceConfig.providers?.local);
      return buildProviderRegistry({
        activeModel: model,
        workspaceRoot,
        workspaceConfig: providerWorkspaceConfig,
        diagnostics: providerDiagnosticsRef.current,
        routeErrors: providerRouteErrorsRef.current,
      });
    },
    // registryNonce is intentionally included: startup probes and post-validation
    // updates mutate providerDiagnosticsRef/providerRouteErrorsRef (refs, not state)
    // and then increment the nonce to trigger a re-read of those refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, providerWorkspaceConfig, registryNonce, workspaceRoot],
  );
  const workspaceDefaultProvider = useMemo(
    () => providerRegistry.find((provider) => provider.isDefault) ?? providerRegistry[0] ?? null,
    [providerRegistry],
  );
  const activeRouteProviderId = activeProviderRoute.providerId;
  const markProviderAvailability = useCallback((
    providerId: ProviderId,
    availability: RuntimeAvailability,
    reason: string,
  ) => {
    const previous = providerDiagnosticsRef.current[providerId] ?? {};
    const selectedModel = typeof previous.selectedModel === "string" && previous.selectedModel.trim()
      ? previous.selectedModel.trim()
      : providerId === activeProviderRoute.providerId
        ? activeProviderRoute.modelId
        : null;
    providerDiagnosticsRef.current[providerId] = {
      ...previous,
      selectedModel,
      availabilityStatus: availability,
      endpointCheckResult: availability,
    };
    traceModelStateDebug("provider_availability_marked", {
      providerId,
      selectedModel,
      availability,
      reason,
    });
    setRegistryNonce((current) => current + 1);
  }, [activeProviderRoute.modelId, activeProviderRoute.providerId]);

  // Reset provider readiness when the user switches to a different provider.
  useEffect(() => {
    dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "idle" });
  }, [activeRouteProviderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeRouteProvider = useMemo(
    () => findProvider(providerRegistry, activeRouteProviderId) ?? providerRegistry[0] ?? null,
    [activeRouteProviderId, providerRegistry],
  );
  const modelPickerProviderId = pendingRouteProviderId ?? activeProviderRoute.providerId;
  const modelPickerRuntime = useMemo(
    () => getProviderRuntime(modelPickerProviderId),
    [modelPickerProviderId],
  );
  const modelPickerDiscovery = useMemo(() => {
    if (modelPickerProviderId === "openai") return null;
    return discoverProviderModels(modelPickerProviderId);
    // registryNonce is intentionally included: route validation discovers models
    // as a side effect and bumps the nonce so an open picker re-reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPickerProviderId, registryNonce]);
  const providerModelCapabilities = useMemo(() => {
    if (!modelPickerDiscovery) return null;
    return providerModelsToCodexCapabilities(modelPickerDiscovery.models, activeProviderRoute.modelId);
  }, [activeProviderRoute.modelId, modelPickerDiscovery]);
  const activeRouteModelCapabilities = useMemo(() => {
    if (activeProviderRoute.providerId === "openai") return modelCapabilities;
    const discovery = discoverProviderModels(activeProviderRoute.providerId);
    return providerModelsToCodexCapabilities(discovery.models, activeProviderRoute.modelId);
  // Local startup discovery mutates the runtime cache without necessarily
  // changing the restored model id. Re-read it when the registry nonce moves
  // so discovered context metadata can replace the initial Unknown value.
  }, [activeProviderRoute.modelId, activeProviderRoute.providerId, modelCapabilities, registryNonce]);
  const modelPickerModels = useMemo(
    () => {
      if (providerModelCapabilities) {
        return getSelectableModelCapabilities(providerModelCapabilities);
      }
      if (modelPickerProviderId === "openai") {
        return getSelectableModelCapabilities(modelCapabilities ?? createFallbackModelCapabilities(null));
      }
      return [];
    },
    [modelCapabilities, modelPickerProviderId, providerModelCapabilities],
  );
  const modelPickerCurrentModel = useMemo(() => {
    if (!pendingRouteProviderId) return activeProviderRoute.modelId;
    if (pendingRouteProviderId === activeProviderRoute.providerId) return activeProviderRoute.modelId;
    // Non-active provider: use stored default, fall back to first selectable model
    const storedDefault = providerWorkspaceConfig.providers?.[pendingRouteProviderId]?.currentModel;
    const selectable = getSelectableModelCapabilities(
      providerModelCapabilities ?? createFallbackModelCapabilities(null),
    );
    return storedDefault ?? selectable[0]?.model ?? model;
  }, [activeProviderRoute, model, pendingRouteProviderId, providerModelCapabilities, providerWorkspaceConfig]);
  const modelPickerCurrentReasoning = useMemo(() => {
    if (!pendingRouteProviderId) {
      return activeProviderRoute.reasoning ?? reasoningLevel;
    }
    if (pendingRouteProviderId === activeProviderRoute.providerId) {
      return activeProviderRoute.reasoning ?? reasoningLevel;
    }
    const storedReasoning = providerWorkspaceConfig.providers?.[pendingRouteProviderId]?.currentReasoning;
    if (storedReasoning) return storedReasoning;
    const pickerCapabilities = pendingRouteProviderId === "openai" ? modelCapabilities : providerModelCapabilities;
    const capability = findModelCapability(pickerCapabilities, modelPickerCurrentModel);
    return capability?.defaultReasoningLevel
      ?? capability?.supportedReasoningLevels?.[0]?.id
      ?? reasoningLevel;
  }, [
    activeProviderRoute.providerId,
    activeProviderRoute.reasoning,
    modelPickerCurrentModel,
    modelCapabilities,
    pendingRouteProviderId,
    providerModelCapabilities,
    providerWorkspaceConfig.providers,
    reasoningLevel,
  ]);
  const modelPickerProviderLabel = useMemo(
    () => modelPickerRuntime.modelPickerLabel
      ?? findProvider(providerRegistry, modelPickerProviderId)?.displayName
      ?? modelPickerRuntime.label,
    [modelPickerProviderId, modelPickerRuntime, providerRegistry],
  );
  const modelPickerEmptyMessage = useMemo(() => {
    if (modelPickerProviderId === "openai") {
      return modelCapabilities?.error ? `No models available: ${modelCapabilities.error}` : "No models available.";
    }
    if (modelPickerDiscovery?.status === "ready" && modelPickerDiscovery.models.length === 0) {
      const setup = getProviderRouteSetupMessage(modelPickerProviderId);
      return `No ${modelPickerProviderLabel} models available because the route is not configured. ${setup}`;
    }
    if (providerModelErrors[modelPickerProviderId]) {
      return `${providerModelErrors[modelPickerProviderId]} Press Refresh models to retry.`;
    }
    return modelPickerDiscovery?.message ?? "No models available.";
  }, [modelCapabilities, modelPickerDiscovery, modelPickerProviderId, modelPickerProviderLabel, providerModelErrors]);
  const routeStatusMessage = useMemo(() => {
    const providerLines = providerRegistry.map((provider) => {
      const runtime = getProviderRuntime(provider.id);
      const discovery = runtime.discoverModels();
      const routingStatus = runtime.routeAvailable
        ? isProviderRouteConfigured(provider.id) ? "configured" : "not configured"
        : "unavailable";
      
      let line = `  ${provider.displayName} routing: ${routingStatus} (${discovery.backendKind})`;
      
      const diagnostics = providerDiagnosticsRef.current[provider.id];
      if (diagnostics && provider.id === "google") {
        const lines = [line];
        if (diagnostics.resolvedCommand ?? diagnostics.executablePath) lines.push(`    Resolved command: ${diagnostics.resolvedCommand ?? diagnostics.executablePath}`);
        if (diagnostics.version) lines.push(`    Version: ${diagnostics.version}`);
        if (diagnostics.headlessPromptMode) lines.push(`    Headless prompt mode: ${diagnostics.headlessPromptMode}`);
        lines.push(`    Status: ${diagnostics.probeStatus ?? (diagnostics.status === "completed" && diagnostics.exitCode === 0 && diagnostics.probeMatch ? "Ready" : "failed")}`);
        if (diagnostics.lastProbeCommandArgs) lines.push(`    Last probe command args: ${diagnostics.lastProbeCommandArgs}`);
        if (diagnostics.status !== "completed" || diagnostics.exitCode !== 0 || !diagnostics.probeMatch) {
          const reason = diagnostics.failureReason ?? (diagnostics.timeout ? "timeout" : "unknown");
          lines.push(`    Reason: ${reason}`);
          if (diagnostics.firstUsefulOutputLine) lines.push(`    First output: ${diagnostics.firstUsefulOutputLine}`);
        }
        lines.push(`    API fallback: ${hasGeminiApiKey() ? "available" : "unavailable"}`);
        line = lines.join("\n");
      }

      if (diagnostics && provider.id === "local") {
        const lines = [line];
        lines.push(`    Base URL: ${diagnostics.baseUrl ?? "unknown"}`);
        lines.push(`    Selected model: ${diagnostics.selectedModel ?? "none"}`);
        lines.push(`    Models: ${diagnostics.discoveredModels || "none"}`);
        lines.push(`    Endpoint check: ${diagnostics.endpointCheckResult ?? "unknown"}`);
        if (diagnostics.errorMessage) lines.push(`    Error: ${diagnostics.errorMessage}`);
        line = lines.join("\n");
      }

      if (diagnostics?.contextSource || diagnostics?.contextError) {
        const contextLength = typeof diagnostics.contextLength === "number"
          ? diagnostics.contextLength
          : null;
        const lines = line.split("\n");
        lines.push(`    Context: ${formatContextLength(contextLength)}`);
        lines.push(`    Context source: ${diagnostics.contextSource ?? "unknown"}`);
        lines.push(`    Context confidence: ${diagnostics.contextConfidence ?? "unknown"}`);
        if (diagnostics.contextRawField) lines.push(`    Context field: ${diagnostics.contextRawField}`);
        if (diagnostics.contextError) lines.push(`    Context reason: ${diagnostics.contextError}`);
        line = lines.join("\n");
      }

      return line;
    });

    const activeModelInfo = activeProviderRoute.providerId === "google" && activeProviderRoute.modelSelection
      ? (activeProviderRoute.modelSelection.kind === "auto"
          ? `Auto (${activeProviderRoute.modelSelection.family === "gemini-3" ? "Gemini 3" : "Gemini 2.5"}) -> ${activeProviderRoute.modelId}`
          : activeProviderRoute.modelId)
      : activeProviderRoute.modelId;

    const ctxValue = activeContextMetadata?.contextLength != null
      ? `${activeContextMetadata.confidence === "estimated" ? "~" : ""}${formatContextCompact(activeContextMetadata.contextLength)}`
      : "Unknown";
    const ctxSource = activeContextMetadata?.source && activeContextMetadata.source !== "unknown"
      ? ` (${activeContextMetadata.source})`
      : "";

    return [
      "Route status:",
      `  Workspace default provider: ${workspaceDefaultProvider?.displayName ?? "OpenAI"}`,
      `  Active chat route: ${activeRouteProvider?.displayName ?? "OpenAI"} / ${activeModelInfo}`,
      `  Context: ${ctxValue}${ctxSource}`,
      `  Backend kind: ${activeProviderRoute.backendKind}`,
      `  In-Codexa routing: ${activeProviderRuntime.routeAvailable ? isProviderRouteConfigured(activeProviderRoute.providerId) ? "configured" : "not configured" : "unavailable"}`,
      `  External launch: ${activeRouteProvider?.launchCommand ? "Available" : "Unavailable"}`,
      ...(providerLines.length > 0 ? providerLines : []),
    ].join("\n");
  }, [activeContextMetadata, activeProviderRoute.backendKind, activeProviderRoute.modelId, activeProviderRoute.modelSelection, activeProviderRoute.providerId, activeProviderRoute.reasoning, activeProviderRuntime.routeAvailable, activeRouteModelCapabilities, activeRouteProvider, providerRegistry, reasoningLevel, workspaceDefaultProvider]);
  const selectableModelCapabilities = useMemo(
    () => activeRouteModelCapabilities ? getSelectableModelCapabilities(activeRouteModelCapabilities) : [],
    [activeRouteModelCapabilities],
  );
  const currentModelCapability = useMemo(
    () => findModelCapability(activeRouteModelCapabilities, activeProviderRoute.modelId),
    [activeProviderRoute.modelId, activeRouteModelCapabilities],
  );
  const currentModelRawMetadataKey = useMemo(
    () => currentModelCapability?.raw === undefined ? "" : JSON.stringify(currentModelCapability.raw),
    [currentModelCapability?.raw],
  );
  const currentReasoningCapabilities = currentModelCapability?.supportedReasoningLevels ?? [];
  const currentReasoningSourceLabel = useMemo(() => {
    if (activeProviderRoute.providerId !== "anthropic") return null;
    const raw = currentModelCapability?.raw as { source?: string; effortVerified?: boolean } | null | undefined;
    if (raw?.source === "claude-code" || raw?.source === "discovered") return "Discovered from Claude Code";
    if (raw?.source === "settings" || raw?.source === "config") return "From Claude settings";
    return raw?.effortVerified === false ? "Fallback defaults; unverified" : "Fallback defaults";
  }, [activeProviderRoute.providerId, currentModelCapability]);

  useEffect(() => {
    let cancelled = false;
    const providerId = activeProviderRoute.providerId;
    const modelId = activeProviderRoute.modelId;
    const rawMetadata = currentModelCapability?.raw;

    void resolveModelContextLength({
      providerId,
      modelId,
      providerConfig: providerWorkspaceConfig.providers?.[providerId],
      rawMetadata,
    }).then((metadata) => {
      if (cancelled || !isMountedRef.current) return;
      setActiveContextMetadata(metadata);

      const contextSource = metadata.source === "known-registry" ? "registry" : metadata.source;
      providerDiagnosticsRef.current[providerId] = {
        ...(providerDiagnosticsRef.current[providerId] ?? {}),
        contextLength: metadata.contextLength,
        contextSource,
        contextConfidence: metadata.confidence,
        contextRawField: metadata.rawField ?? null,
        contextError: metadata.error ?? null,
      };
      setRegistryNonce((current) => current + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeProviderRoute.modelId,
    activeProviderRoute.providerId,
    currentModelRawMetadataKey,
    providerWorkspaceConfig.providers,
  ]);

  const workspaceLabel = useMemo(
    () => formatWorkspaceDisplayPath(workspaceRoot, workspaceDisplayMode),
    [workspaceDisplayMode, workspaceRoot],
  );
  const { staticEvents, activeEvents, uiState, inputValue, cursor } = sessionState;

  const currentUserSettings = useMemo<UserSettingValues>(() => ({
    workspaceDisplayMode,
    terminalTitleMode,
    showBusyLoader: formatBusyLoaderSettingValue(showBusyLoader),
  }), [showBusyLoader, terminalTitleMode, workspaceDisplayMode]);

  const allowedWritableRoots = useMemo(
    () => resolvedRuntimeConfig.policy.writableRoots,
    [resolvedRuntimeConfig],
  );

  const hasPlanFileAvailable = useMemo(
    () => planFlow.kind !== "idle"
      && planFlow.planFilePath !== null
      && existsSync(planFlow.planFilePath),
    [planFlow],
  );

  const activeRuntimeDisplay = useMemo(() => buildActiveRuntimeDisplay({
    route: activeProviderRoute,
    reasoningLevel,
    mode,
    tokensUsed: estimateTokens(conversationChars),
    modelCapability: currentModelCapability,
    contextMetadata: activeContextMetadata,
  }), [
    activeContextMetadata,
    activeProviderRoute,
    conversationChars,
    currentModelCapability,
    mode,
    reasoningLevel,
  ]);
  const currentModelSpec = activeRuntimeDisplay.modelSpec;
  const activeRuntimeAvailability = useMemo<RuntimeAvailability>(() => {
    if (activeProviderRoute.providerId !== "local") {
      return "available";
    }
    const diagnostics = providerDiagnosticsRef.current.local;
    return normalizeRuntimeAvailability(diagnostics?.availabilityStatus ?? diagnostics?.endpointCheckResult);
  // registryNonce intentionally re-reads providerDiagnosticsRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProviderRoute.providerId, registryNonce]);
  const visibleRuntimeModelState = useMemo(() => {
    const diagnostics = providerDiagnosticsRef.current[activeProviderRoute.providerId];
    const providerLabel = activeRouteProvider?.displayName
      ?? formatRuntimeProviderLabel(activeProviderRoute.providerId);
    const diagnosticModel = readDiagnosticString(diagnostics, [
      "selectedModel",
      "modelId",
      "currentModel",
      "defaultModel",
    ]);
    const routeModel = activeProviderRoute.modelId?.trim();
    const modelLabel = routeModel
      || diagnosticModel
      || (activeRuntimeAvailability === "checking" || activeRuntimeAvailability === "reconnecting"
        ? "Detecting..."
        : "Unknown");
    const modelDisplay = activeRuntimeDisplay.footerModelDisplay?.trim()
      || `${providerLabel} / ${modelLabel}`;
    const diagnosticContext = readDiagnosticString(diagnostics, ["contextDisplay", "contextLength"]);
    const contextDisplay = activeRuntimeDisplay.contextDisplay?.trim()
      || diagnosticContext
      || "Unknown";
    const nextState = {
      selectedProvider: activeProviderRoute.providerId,
      selectedModel: modelLabel,
      modelDisplay,
      contextDisplay,
      availability: activeRuntimeAvailability,
    };
    traceModelStateDebug("runtime_model_display_derived", nextState);
    return nextState;
  // registryNonce intentionally re-reads providerDiagnosticsRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeProviderRoute.modelId,
    activeProviderRoute.providerId,
    activeRuntimeAvailability,
    activeRuntimeDisplay.contextDisplay,
    activeRuntimeDisplay.footerModelDisplay,
    activeRouteProvider?.displayName,
    registryNonce,
  ]);

  const hasUserPrompt = useMemo(
    () => staticEvents.some((e) => e.type === "user") || activeEvents.some((e) => e.type === "user"),
    [staticEvents, activeEvents],
  );

  const hasVisibleTranscriptPlan = useMemo(
    () => planFlow.kind === "awaiting_action"
      && hasFinalizedTranscriptPlan(staticEvents, planFlow.currentPlan),
    [planFlow, staticEvents],
  );

  // Refs for mutable state values — used by stable callbacks below so they
  // always read the latest value without being listed as deps (which would
  // recreate the callbacks on every keystroke and defeat memoisation).
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const busy = isUiBusy(uiState);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const prevBusyRef = useRef(busy);
  useEffect(() => {
    if (!busy && prevBusyRef.current && screen === "main") {
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      focusManager.focus(FOCUS_IDS.composer);
    }
    prevBusyRef.current = busy;
  }, [busy, screen, focusManager]);

  const modelCapabilitiesBusyRef = useRef(modelCapabilitiesBusy);
  modelCapabilitiesBusyRef.current = modelCapabilitiesBusy;
  const composerRows = useMemo(() => {
    if (planFlow.kind === "awaiting_action") {
      return hasVisibleTranscriptPlan ? measurePlanActionPickerRows(terminalLayout.cols) : 1;
    }
    if (planFlow.kind === "collecting_feedback") {
      return measureTextEntryPanelRows();
    }
    return measureBottomComposerRows({
      layout: terminalLayout,
      uiState,
      mode,
      model,
      reasoningLevel,
      tokensUsed: estimateTokens(conversationChars),
      modelSpec: currentModelSpec,
      value: inputValue,
      cursor,
    });
  }, [
    conversationChars,
    currentModelSpec,
    cursor,
    inputValue,
    mode,
    model,
    planFlow.kind,
    hasVisibleTranscriptPlan,
    reasoningLevel,
    terminalLayout,
    uiState,
  ]);
  const activeRootComponent = screen === "main" ? "TranscriptShell" : "AppShell";
  const startupHeaderMode = useMemo(
    () => resolveStartupHeaderMode({
      cols: terminalLayout.cols,
      rows: terminalLayout.rows,
      introRows: 8,
      composerRows,
    }),
    [composerRows, terminalLayout.cols, terminalLayout.rows],
  );
  const previousStartupTraceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const nextKey = [
      terminalLayout.cols,
      terminalLayout.rows,
      terminalLayout.mode,
      activeRootComponent,
      screen,
      startupHeaderMode,
      staticEvents.length,
      activeEvents.length,
      uiState.kind,
    ].join("|");
    if (previousStartupTraceKeyRef.current === nextKey) return;
    previousStartupTraceKeyRef.current = nextKey;
    renderDebug.traceEvent("startup", "state", {
      cols: terminalLayout.cols,
      rows: terminalLayout.rows,
      layoutMode: terminalLayout.mode,
      activeRoot: activeRootComponent,
      screen,
      startupHeaderMode,
      logoBranchSelected: startupHeaderMode === "large",
      staticEventsLength: staticEvents.length,
      activeEventsLength: activeEvents.length,
      uiStateKind: uiState.kind,
    });
  }, [
    activeEvents.length,
    activeRootComponent,
    screen,
    startupHeaderMode,
    staticEvents.length,
    terminalLayout.cols,
    terminalLayout.mode,
    terminalLayout.rows,
    uiState.kind,
  ]);

  renderDebug.useRenderDebug("Root", {
    screen,
    activeRoot: activeRootComponent,
    uiStateKind: uiState.kind,
    staticEvents,
    activeEvents,
    activeEventsLength: activeEvents.length,
    inputValue,
    cursor,
    busy,
    composerRows,
    startupHeaderMode,
    logoBranchSelected: startupHeaderMode === "large",
    cols: terminalLayout.cols,
    rows: terminalLayout.rows,
    layoutMode: terminalLayout.mode,
    layoutEpoch: terminalLayout.layoutEpoch,
    planFlowKind: planFlow.kind,
    mode,
    model,
    reasoningLevel,
  });
  renderDebug.useLifecycleDebug("App", {
    screen,
    uiStateKind: uiState.kind,
  });
  renderDebug.traceLayoutValidity("Root", {
    cols: terminalLayout.cols,
    rows: terminalLayout.rows,
    rawCols: terminalLayout.rawCols,
    rawRows: terminalLayout.rawRows,
    composerRows,
  });
  const previousUiStateKindRef = useRef(uiState.kind);
  useEffect(() => {
    setTerminalControlUIState(uiState.kind);
    setTerminalTitleLifecycleState(`${uiState.kind}${busy ? ":busy" : ":idle"}`);
  }, [busy, uiState.kind]);

  useEffect(() => {
    const previousKind = previousUiStateKindRef.current;
    if (previousKind !== uiState.kind) {
      renderDebug.traceStateTransition({
        component: "App",
        prevKind: previousKind,
        nextKind: uiState.kind,
        activeEventsLength: activeEvents.length,
        staticEventsLength: staticEvents.length,
        screen,
      });
      previousUiStateKindRef.current = uiState.kind;
    }
  }, [activeEvents.length, screen, staticEvents.length, uiState.kind]);
  const previousEventCountRef = useRef(staticEvents.length + activeEvents.length);
  useEffect(() => {
    const previousCount = previousEventCountRef.current;
    const nextCount = staticEvents.length + activeEvents.length;
    if (previousCount > 0 && nextCount === 0) {
      renderDebug.traceBlankFrame("Root", {
        reason: "event-count-dropped-to-zero",
        previousCount,
        staticEventsLength: staticEvents.length,
        activeEventsLength: activeEvents.length,
        uiStateKind: uiState.kind,
        screen,
      });
    }
    previousEventCountRef.current = nextCount;
  }, [activeEvents.length, screen, staticEvents.length, uiState.kind]);
  const previousRootMeasurements = useRef<{
    composerRows: number;
    cols: number;
    rows: number;
    layoutEpoch: number;
  } | null>(null);
  useEffect(() => {
    const previous = previousRootMeasurements.current;
    const changed: string[] = [];
    if (!previous) {
      changed.push("mount");
    } else {
      if (previous.composerRows !== composerRows) changed.push("composerRows");
      if (previous.cols !== terminalLayout.cols) changed.push("width");
      if (previous.rows !== terminalLayout.rows) changed.push("height");
      if (previous.layoutEpoch !== terminalLayout.layoutEpoch) changed.push("layoutEpoch");
    }
    if (changed.length > 0) {
      renderDebug.traceEvent("layout", "rootMeasurementUpdate", {
        reason: changed.join(","),
        composerRows,
        cols: terminalLayout.cols,
        rows: terminalLayout.rows,
        layoutEpoch: terminalLayout.layoutEpoch,
      });
    }
    previousRootMeasurements.current = {
      composerRows,
      cols: terminalLayout.cols,
      rows: terminalLayout.rows,
      layoutEpoch: terminalLayout.layoutEpoch,
    };
  }, [composerRows, terminalLayout.cols, terminalLayout.layoutEpoch, terminalLayout.rows]);

  const backendProvider: BackendProvider = useMemo(() => getBackendProvider(backend), [backend]);
  const provider: BackendProvider = useMemo(() => {
    if (activeProviderRoute.providerId === "openai") {
      return backendProvider;
    }

    const routeRuntime = getProviderRuntime(activeProviderRoute.providerId);
    return {
      id: backend,
      label: routeRuntime.label,
      description: routeRuntime.routeStatus,
      authState: routeRuntime.routeAvailable ? "delegated" : "coming-soon",
      authLabel: routeRuntime.routeAvailable ? "Configured" : "Not configured",
      statusMessage: routeRuntime.routeStatus,
      supportsModels: (candidateModel) => candidateModel === activeProviderRoute.modelId,
      run: routeRuntime.run
        ? (prompt, options, handlers) => {
          const geminiCommandPath = activeProviderRoute.providerId === "google"
            ? providerWorkspaceConfig.providers?.google?.geminiCommandPath ?? options.runtime.geminiCommandPath
            : options.runtime.geminiCommandPath;
          return routeRuntime.run?.({
            prompt,
            route: activeProviderRoute,
            runtime: geminiCommandPath ? { ...options.runtime, geminiCommandPath } : options.runtime,
            workspaceRoot: options.workspaceRoot,
            projectInstructions: options.projectInstructions,
            localConfig: activeProviderRoute.providerId === "local"
              ? providerWorkspaceConfig.providers?.local
              : undefined,
            runIntent: options.runIntent,
            conversationHistory: options.conversationHistory,
            localContextCheckpoint: options.localContextCheckpoint,
            localHarnessSession: activeProviderRoute.providerId === "local"
              ? activeConversationRef.current?.metadata.localHarnessSession
              : undefined,
          }, handlers) ?? (() => undefined);
        }
        : undefined,
    };
  }, [activeProviderRoute, backend, backendProvider, providerWorkspaceConfig.providers]);

  const getInputDebugSnapshot = useCallback((extra: Record<string, unknown> = {}) => {
    const currentScreen = screenRef.current;
    const currentBusy = busyRef.current;
    const currentModelLoading = modelCapabilitiesBusyRef.current;

    return {
      screen: currentScreen,
      mode: intendedInputModeRef.current,
      modelPickerOpen: currentScreen === "model-picker",
      composerEnabled: currentScreen === "main" && !currentBusy,
      inputLocked: currentBusy,
      busy: currentBusy,
      modelLoading: currentModelLoading,
      modelSelection: modelSelectionInFlightRef.current,
      focusTarget: intendedFocusTargetRef.current,
      stdin: getStdinDebugState(stdin),
      ...extra,
    };
  }, [stdin]);

  useEffect(() => {
    baseRuntimeConfigRef.current = baseLayeredConfig.runtime;
  }, [baseLayeredConfig.runtime]);

  useEffect(() => {
    saveSettings({
      ui: {
        layoutStyle: initialSettings.current.ui.layoutStyle,
        theme: themeSelection.committedTheme,
        workspaceDisplayMode,
        terminalTitleMode,
        showBusyLoader,
        customTheme,
      },
      auth: {
        preference: authPreference,
      },
      header: headerConfig,
      updateCheck: initialSettings.current.updateCheck,
    });
  }, [authPreference, customTheme, showBusyLoader, terminalTitleMode, themeSelection.committedTheme, workspaceDisplayMode]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cleanupRef.current?.();
      void shutdownLocalHarness();
      if (themePreviewTimerRef.current) {
        clearTimeout(themePreviewTimerRef.current);
        themePreviewTimerRef.current = null;
      }
      if (themeNoticeTimerRef.current) {
        clearTimeout(themeNoticeTimerRef.current);
        themeNoticeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (screen === "theme-picker") {
      return;
    }

    if (themePreviewTimerRef.current) {
      clearTimeout(themePreviewTimerRef.current);
      themePreviewTimerRef.current = null;
    }
  }, [screen]);

  useEffect(() => {
    const previousScreen = previousScreenRef.current;
    if (shouldBumpComposerInstance(previousScreen, screen)) {
      setComposerInstanceKey((currentKey) => currentKey + 1);
    }
    previousScreenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    const focusTarget = getFocusTargetForScreen(screen);
    intendedFocusTargetRef.current = focusTarget;
    traceInputDebug("focus_route", getInputDebugSnapshot({ focusTarget }));
    focusManager.focus(focusTarget);
  }, [composerInstanceKey, focusManager, getInputDebugSnapshot, screen]);

  useEffect(() => {
    if (screen !== "main") return;

    if (planFlow.kind === "awaiting_action") {
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      focusManager.focus(FOCUS_IDS.composer);
      return;
    }

    if (planFlow.kind === "collecting_feedback") {
      intendedFocusTargetRef.current = FOCUS_IDS.composer;
      focusManager.focus(FOCUS_IDS.composer);
    }
  }, [focusManager, planFlow.kind, screen]);

  useEffect(() => {
    if (screen === "model-picker" || intendedInputModeRef.current !== "model-picker") {
      return;
    }

    traceInputDebug("safety_recovery", getInputDebugSnapshot({
      reason: "model-picker-closed-with-stale-input-mode",
      restoredMode: "chat/input",
      restoredFocusTarget: FOCUS_IDS.composer,
    }));
    intendedInputModeRef.current = "chat/input";
    intendedFocusTargetRef.current = FOCUS_IDS.composer;
    focusManager.focus(FOCUS_IDS.composer);
  }, [focusManager, getInputDebugSnapshot, screen]);

  const returnToChatMode = useCallback((reason = "unknown") => {
    if (modelPickerOpenRef.current) {
      intendedInputModeRef.current = "model-picker";
      intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
      traceInputDebug("model_picker_async_completion_preserved", getInputDebugSnapshot({
        reason,
        restoredMode: "model-picker",
        restoredModelPickerOpen: true,
        restoredFocusTarget: FOCUS_IDS.modelPicker,
      }));
      focusManager.focus(FOCUS_IDS.modelPicker);
      return;
    }
    intendedInputModeRef.current = "chat/input";
    intendedFocusTargetRef.current = FOCUS_IDS.composer;
    traceInputDebug("model_picker_close", getInputDebugSnapshot({
      reason,
      restoredMode: "chat/input",
      restoredModelPickerOpen: false,
      restoredComposerEnabled: true,
      restoredInputLocked: false,
      restoredFocusTarget: FOCUS_IDS.composer,
    }));
    setScreen("main");
    focusManager.focus(FOCUS_IDS.composer);
  }, [focusManager, getInputDebugSnapshot]);

  const returnFromUpdateOverlay = useCallback(() => {
    setScreen("main");
    focusManager.focus(FOCUS_IDS.composer);
  }, [focusManager]);

  const appendStaticEvent = useCallback((event: TimelineEvent) => {
    dispatchSession({ type: "APPEND_STATIC_EVENT", event });
  }, [dispatchSession]);

  const appendSystemEvent = useCallback((title: string, content: string) => {
    const safeTitle = sanitizeTerminalOutput(title);
    const safeContent = sanitizeTerminalOutput(content, { preserveTabs: false, tabSize: 2 });
    appendStaticEvent({
      id: createEventId(),
      type: "system",
      createdAt: Date.now(),
      title: safeTitle,
      content: safeContent,
    });
  }, [appendStaticEvent]);

  const appendErrorEvent = useCallback((title: string, content: string) => {
    const safeTitle = sanitizeTerminalOutput(title);
    const safeContent = sanitizeTerminalOutput(content, { preserveTabs: false, tabSize: 2 });
    appendStaticEvent({
      id: createEventId(),
      type: "error",
      createdAt: Date.now(),
      title: safeTitle,
      content: safeContent,
    });
  }, [appendStaticEvent]);

  const saveActiveConversation = useCallback(() => {
    const current = activeConversationRef.current;
    if (!current || current.messages.length === 0) return;
    const next: ConversationRecord = {
      ...current,
      metadata: {
        ...current.metadata,
        providerId: activeProviderRoute.providerId,
        modelId: activeProviderRoute.modelId,
        backendKind: activeProviderRoute.backendKind,
        ...(activeProviderRoute.localBackend ? { localBackend: activeProviderRoute.localBackend } : {}),
        ...(activeProviderRoute.reasoning ? { reasoning: activeProviderRoute.reasoning } : {}),
      },
    };
    activeConversationRef.current = next;
    try {
      conversationStore.save(next);
    } catch (error) {
      appDiagLog(`CONVERSATION_STORE: save failed: ${error instanceof Error ? error.message : "filesystem error"}`);
    }
  }, [activeProviderRoute, conversationStore]);

  const appendConversationMessage = useCallback((message: ConversationMessage) => {
    const current = activeConversationRef.current ?? conversationStore.createConversation({
      providerId: activeProviderRoute.providerId,
      modelId: activeProviderRoute.modelId,
      backendKind: activeProviderRoute.backendKind,
      localBackend: activeProviderRoute.localBackend,
      reasoning: activeProviderRoute.reasoning,
    });
    const next: ConversationRecord = { ...current, messages: [...current.messages, message] };
    activeConversationRef.current = next;
    try {
      conversationStore.save(next);
    } catch (error) {
      appDiagLog(`CONVERSATION_STORE: message save failed: ${error instanceof Error ? error.message : "filesystem error"}`);
    }
  }, [activeProviderRoute, conversationStore]);

  const openResumePicker = useCallback(() => {
    if (busy) {
      appendSystemEvent("Resume unavailable", "Finish the active run before switching conversations.");
      return;
    }
    saveActiveConversation();
    setResumeConversations(conversationStore.list());
    setScreen("resume-picker");
  }, [appendSystemEvent, busy, conversationStore, saveActiveConversation]);

  const resumeConversation = useCallback((id: string) => {
    const loaded = conversationStore.load(id);
    if (!loaded) {
      appendErrorEvent("Resume failed", "That conversation could not be loaded.");
      setScreen("main");
      return;
    }
    const previousHarnessSessionId = activeConversationRef.current?.metadata.localHarnessSession?.sessionId;
    if (previousHarnessSessionId && previousHarnessSessionId !== loaded.metadata.localHarnessSession?.sessionId) {
      void closeLocalHarnessSession(previousHarnessSessionId);
    }
    activeConversationRef.current = loaded;
    setConversationChars(loaded.messages.reduce((total, message) => total + message.content.length, 0));
    resetTimelineMeasureCaches();
    dispatchSession({
      type: "CLEAR_TRANSCRIPT",
      seedEvents: conversationMessagesToTimeline(loaded.messages, createEventId),
    });
    const routeProvider = typeof loaded.metadata.providerId === "string" && isKnownProviderId(loaded.metadata.providerId)
      ? loaded.metadata.providerId
      : null;
    if (routeProvider) {
      const discovery = discoverProviderModels(routeProvider);
      const modelUnavailable = discovery.status === "ready"
        && discovery.models.length > 0
        && !discovery.models.some((model) => model.modelId === loaded.metadata.modelId || model.id === loaded.metadata.modelId);
      const route = {
        providerId: routeProvider,
        modelId: loaded.metadata.modelId,
        backendKind: loaded.metadata.backendKind && loaded.metadata.backendKind !== "unavailable"
          ? loaded.metadata.backendKind as import("./core/providerRuntime/types.js").ProviderBackendKind
          : getProviderRuntime(routeProvider).backendKind,
        ...(loaded.metadata.reasoning ? { reasoning: loaded.metadata.reasoning } : {}),
      } satisfies import("./core/providerRuntime/types.js").ProviderRoute;
      setConversationRouteOverride(modelUnavailable ? null : route);
      if (!isProviderRoutableInCodexa(routeProvider) || modelUnavailable) {
        const reason = !isProviderRoutableInCodexa(routeProvider)
          ? `${routeProvider} is not currently available`
          : `${loaded.metadata.modelId} is not currently available`;
        appendSystemEvent("Original route unavailable", `Restored the conversation, but ${reason}. Codexa will use the current route when you send the next message.`);
        setConversationRouteOverride(null);
      }
    } else {
      appendSystemEvent("Original route unavailable", "Restored the conversation history; continuing with the current provider route.");
    }
    setScreen("main");
    dispatchSession({ type: "RESET_INPUT" });
    intendedFocusTargetRef.current = FOCUS_IDS.composer;
    focusManager.focus(FOCUS_IDS.composer);
  }, [appendErrorEvent, appendSystemEvent, conversationStore, dispatchSession, focusManager]);

  useEffect(() => {
    const notice = providerWorkspaceConfig.migrationNotice;
    if (!notice || providerMigrationNoticeShownRef.current) return;
    const providerLabel = findProvider(providerRegistry, notice.revertedProviderId)?.displayName ?? "OpenAI";
    const event = createProviderMigrationNoticeEvent(notice, providerLabel);
    if (!event) return;
    providerMigrationNoticeShownRef.current = true;
    appendStaticEvent(event);
  }, [appendStaticEvent, providerRegistry, providerWorkspaceConfig.migrationNotice]);

  useEffect(() => {
    if (projectInstructionsLoad.status === "loaded") {
      traceInputDebug("project_instructions_loaded", {
        path: projectInstructionsLoad.instructions.path,
        content: projectInstructionsLoad.instructions.content,
      });
      return;
    }

    if (projectInstructionsLoad.status === "error") {
      appendErrorEvent(
        "Project instructions",
        `Could not read ${projectInstructionsLoad.path}: ${projectInstructionsLoad.message}`,
      );
    }
  }, [appendErrorEvent, projectInstructionsLoad]);

  const refreshModelCapabilities = useCallback((forceRefresh = false, announce = false): Promise<CodexModelCapabilities> => {
    // Single-flight: concurrent requests share the same in-flight discovery
    // promise so we never spawn a duplicate discovery job or emit duplicate
    // transcript messages.
    if (modelDiscoveryInFlightRef.current && !forceRefresh) {
      traceInputDebug("model_loading_inflight", getInputDebugSnapshot({ forceRefresh, announce }));
      if (announce) {
        modelDiscoveryAnnounceRef.current = true;
      }
      return modelDiscoveryInFlightRef.current;
    }

    if (announce) {
      modelDiscoveryAnnounceRef.current = true;
    }

    setModelCapabilitiesBusy(true);
    traceInputDebug("model_loading_start", getInputDebugSnapshot({ forceRefresh, announce }));
    const promise = (async () => {
      try {
        const capabilities = await getCodexModelCapabilities({ forceRefresh });
        setModelCapabilities(capabilities);
        traceInputDebug("model_loading_success", getInputDebugSnapshot({
          status: capabilities.status,
          source: capabilities.source,
          modelCount: getSelectableModelCapabilities(capabilities).length,
        }));
        if (capabilities.status === "fallback") {
          traceInputDebug("model_loading_failure", getInputDebugSnapshot({
            status: capabilities.status,
            error: capabilities.error,
          }));
        }
        if (modelDiscoveryAnnounceRef.current) {
          const modelCount = getSelectableModelCapabilities(capabilities).length;
          const source = capabilities.status === "ready" ? "Codex runtime" : "fallback compatibility list";
          appendSystemEvent("Model discovery", `Loaded ${modelCount} models from ${source}.`);
        }
        return capabilities;
      } catch (error) {
        const fallback = createFallbackModelCapabilities(error);
        setModelCapabilities(fallback);
        traceInputDebug("model_loading_failure", getInputDebugSnapshot({
          error: error instanceof Error ? error.message : String(error),
        }));
        if (modelDiscoveryAnnounceRef.current) {
          appendErrorEvent("Model discovery failed", fallback.error ?? "Unable to discover Codex models.");
        }
        return fallback;
      } finally {
        setModelCapabilitiesBusy(false);
        modelDiscoveryInFlightRef.current = null;
        modelDiscoveryAnnounceRef.current = false;
        traceInputDebug("model_loading_finished", getInputDebugSnapshot({ forceRefresh, announce }));
      }
    })();

    modelDiscoveryInFlightRef.current = promise;
    return promise;
  }, [appendErrorEvent, appendSystemEvent, getInputDebugSnapshot]);

  const ensureProviderModels = useCallback((providerId: ProviderId, forceRefresh = false) => {
    if (providerId === "openai") {
      return refreshModelCapabilities(forceRefresh, false);
    }

    const runtime = getProviderRuntime(providerId);
    if (!runtime.refreshModels) {
      return Promise.resolve(null);
    }

    const cached = discoverProviderModels(providerId);
    const hasDiscoveredModels = cached.models.some((item) => item.source && item.source !== "fallback");
    if (!forceRefresh && cached.models.length > 0 && (hasDiscoveredModels || providerModelsLoadedRef.current.has(providerId))) {
      return Promise.resolve(cached);
    }

    const existing = providerModelRefreshesRef.current.get(providerId);
    if (existing && !forceRefresh) return existing;

    setProviderModelLoading((current) => ({ ...current, [providerId]: true }));
    setProviderModelErrors((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });

    const promise = runtime.refreshModels({
      cwd: workspaceRoot,
      localConfig: providerId === "local" ? providerWorkspaceConfig.providers?.local : undefined,
    }).then((discovery) => {
      providerModelsLoadedRef.current.add(providerId);
      persistProviderDiscovery(discovery);
      if (discovery.status !== "ready" || discovery.models.length === 0) {
        setProviderModelErrors((current) => ({
          ...current,
          [providerId]: discovery.message ?? `Unable to load ${runtime.label} models.`,
        }));
      }
      setRegistryNonce((current) => current + 1);
      return discovery;
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setProviderModelErrors((current) => ({ ...current, [providerId]: message }));
      setRegistryNonce((current) => current + 1);
      return null;
    }).finally(() => {
      providerModelRefreshesRef.current.delete(providerId);
      setProviderModelLoading((current) => ({ ...current, [providerId]: false }));
    });

    providerModelRefreshesRef.current.set(providerId, promise);
    return promise;
  }, [persistProviderDiscovery, providerWorkspaceConfig.providers, refreshModelCapabilities, workspaceRoot]);

  const setRuntimeUnauthenticated = useCallback((summary: string) => {
    setAuthStatus({
      state: "unauthenticated",
      checkedAt: Date.now(),
      rawSummary: summary,
      recommendedAction: "Run `codex login` and retry.",
    });
  }, []);

  const refreshAuthStatus = useCallback(async (announce: boolean) => {
    setAuthStatusBusy(true);
    setAuthStatus((prev) => ({ ...prev, state: "checking" }));

    try {
      const result = await probeCodexAuthStatus();
      setAuthStatus(result);
      if (announce) {
        appendSystemEvent("Auth status", getAuthStatusMessage(result));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown auth probe failure";
      const fallback: CodexAuthProbeResult = {
        state: "unknown",
        checkedAt: Date.now(),
        rawSummary: message,
        recommendedAction: "Run `codex login` manually, then retry /auth status.",
      };
      setAuthStatus(fallback);
      if (announce) {
        appendErrorEvent("Auth status probe failed", message);
      }
    } finally {
      setAuthStatusBusy(false);
    }
  }, [appendErrorEvent, appendSystemEvent]);

  useEffect(() => {
    void refreshAuthStatus(false);
  }, []);

  // Probe Anthropic/Claude Code CLI auth at startup so the provider picker
  // shows the correct route availability without requiring manual activation.
  useEffect(() => {
    void (async () => {
      try {
        const result = await validateAnthropicRoute({ cwd: workspaceRoot, configuredPath: providerWorkspaceConfig.providers?.anthropic?.claudeCommandPath });
        if (result.diagnostics) {
          providerDiagnosticsRef.current["anthropic"] = result.diagnostics as Record<string, string | number | boolean | null>;
        }
        if (result.status !== "ready") {
          providerRouteErrorsRef.current["anthropic"] = result.message ?? ANTHROPIC_ROUTE_SETUP_MESSAGE;
        } else {
          delete providerRouteErrorsRef.current["anthropic"];
          // Persist the freshly discovered catalog so newly released Claude
          // models replace the stale on-disk cache without a manual refresh.
          persistProviderDiscovery(discoverProviderModels("anthropic"));
        }
      } catch {
        // Best-effort probe — failures are surfaced only when the user activates the route.
      }
      setRegistryNonce((n) => n + 1);
    })();
  // workspaceRoot is stable for the session lifetime; this runs exactly once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot]);

  // Probe local OpenAI-compatible servers such as LM Studio at startup so the
  // provider picker can show actual availability and loaded model IDs.
  useEffect(() => {
    if (activeProviderRoute.providerId !== "local") return;
    void (async () => {
      try {
        markProviderAvailability("local", "checking", "startup-probe");
        const result = await checkLocalProvider({ override: providerWorkspaceConfig.providers?.local });
        if (result.diagnostics) {
          providerDiagnosticsRef.current["local"] = result.diagnostics as Record<string, string | number | boolean | null>;
        }
        if (result.status !== "ready") {
          providerRouteErrorsRef.current["local"] = result.message ?? "Local provider unavailable.";
        } else {
          delete providerRouteErrorsRef.current["local"];
          const detectedModel = typeof result.diagnostics?.selectedModel === "string"
            ? result.diagnostics.selectedModel.trim()
            : "";
          if (detectedModel && detectedModel !== activeProviderRoute.modelId) {
            const localBackend = activeProviderRoute.localBackend
              ?? providerWorkspaceConfig.providers?.local?.localBackend
              ?? "lm-studio";
            const nextReasoning = activeProviderRoute.reasoning ?? reasoningLevel;
            let nextConfig = setProviderActiveRoute(providerWorkspaceConfig, {
              providerId: "local",
              modelId: detectedModel,
              backendKind: result.backendKind,
              reasoning: nextReasoning,
              localBackend,
            });
            nextConfig = setProviderDefaultModel(nextConfig, "local", detectedModel);
            saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
            setProviderWorkspaceConfig(nextConfig);
            updateRuntimeConfig((current) => ({ ...current, model: detectedModel }));
          }
        }
      } catch {
        // Best-effort probe — failures are surfaced only when the user activates the route.
      }
      setRegistryNonce((n) => n + 1);
    })();
  // workspaceRoot is stable for the session lifetime; local provider config is
  // loaded before this first startup probe.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProviderRoute.providerId, workspaceRoot]);

  // Check npm on every interactive startup before enabling the composer.
  useEffect(() => {
    if (!startupUpdateEnabled.current) return;

    void (async () => {
      const cache = loadUpdateCheckCache();
      try {
        const result = await checkForUpdates({ enabled: true });
        if (result.status === "error") {
          // A previously confirmed update is still useful when npm is briefly
          // unreachable, but it must never suppress the next fresh startup check.
          if (cache?.updateAvailable && cache.latestVersion && isCacheForRunningVersion(cache, APP_VERSION)) {
            setUpdateCheckResult({
              status: "update-available",
              currentVersion: cache.currentVersion,
              latestVersion: cache.latestVersion,
              checkedAt: cache.lastChecked,
              source: "cache",
            });
          } else {
            returnFromUpdateOverlay();
          }
          return;
        }

        setUpdateCheckResult(result);
        saveUpdateCheckCache({
          lastChecked: result.checkedAt,
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          updateAvailable: result.status === "update-available",
        });
        if (result.status !== "update-available") {
          returnFromUpdateOverlay();
        }
      } catch {
        // Never crash the TUI on a failed update check.
        if (!initialUpdateCheckResult.current) {
          returnFromUpdateOverlay();
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const repaintCommittedTheme = useCallback((themeName: string) => {
    // Persist the committed value synchronously as well as through the normal
    // settings effect. This matters when the terminal is closed immediately
    // after choosing a theme, before React gets another effect pass.
    saveSettings({
      ui: {
        layoutStyle: initialSettings.current.ui.layoutStyle,
        theme: themeName,
        workspaceDisplayMode,
        terminalTitleMode,
        showBusyLoader,
        customTheme,
      },
      auth: { preference: authPreference },
      header: headerConfig,
      updateCheck: initialSettings.current.updateCheck,
    });
    setThemeSelection((currentTheme) => commitThemeSelection(currentTheme, themeName));
    setThemeNotice(`Theme switched to ${formatThemeLabel(themeName)}.`);
    if (themeNoticeTimerRef.current) clearTimeout(themeNoticeTimerRef.current);
    themeNoticeTimerRef.current = setTimeout(() => {
      setThemeNotice(null);
      themeNoticeTimerRef.current = null;
    }, 1800);

  }, [authPreference, customTheme, headerConfig, showBusyLoader, terminalTitleMode, workspaceDisplayMode]);

  // Track clear epoch to suppress stale command result events
  useEffect(() => {
    clearEpochRef.current = sessionState.clearEpoch;
  }, [sessionState.clearEpoch]);

  useEffect(() => {
    externalCliStatusRef.current = sessionState.externalCliStatus;
  }, [sessionState.externalCliStatus]);

  const reloadBaseLayeredConfig = useCallback(() => {
    const nextConfig = resolveLayeredConfig({ workspaceRoot, launchArgs });
    baseRuntimeConfigRef.current = nextConfig.runtime;
    setBaseLayeredConfig(nextConfig);
    return nextConfig;
  }, [launchArgs, workspaceRoot]);

  const updateRuntimeConfig = useCallback((updater: (current: RuntimeConfig) => RuntimeConfig) => {
    setSessionRuntimeOverride((currentPatch) => {
      const baseRuntime = baseRuntimeConfigRef.current;
      const currentRuntime = mergeRuntimeConfig(baseRuntime, currentPatch);
      const nextRuntime = updater(currentRuntime);
      return diffRuntimeConfig(baseRuntime, nextRuntime);
    });
  }, []);

  const updateRuntimePolicy = useCallback((updater: (current: RuntimeConfig["policy"]) => RuntimeConfig["policy"]) => {
    updateRuntimeConfig((current) => ({
      ...current,
      policy: updater(current.policy),
    }));
  }, [updateRuntimeConfig]);

  const persistActiveRoute = useCallback((
    providerId: ProviderId,
    nextModel: string,
    nextReasoning: string,
    backendKindOverride?: ReturnType<typeof getProviderRuntime>["backendKind"],
    modelSelection?: import("./core/providerRuntime/types.js").GeminiModelSelection,
    localBackend?: LocalBackendId,
  ) => {
    try {
      setConversationRouteOverride(null);
      const runtime = getProviderRuntime(providerId);
      let nextConfig = setProviderActiveRoute(providerWorkspaceConfig, {
        providerId,
        modelId: nextModel,
        backendKind: backendKindOverride ?? runtime.backendKind,
        reasoning: nextReasoning,
        modelSelection,
        ...(providerId === "local" ? { localBackend: localBackend ?? providerWorkspaceConfig.providers?.local?.localBackend ?? "lm-studio" } : {}),
      });
      nextConfig = setProviderDefaultReasoning(
        setProviderDefaultModel(nextConfig, providerId, nextModel),
        providerId,
        nextReasoning,
      );
      saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
      setProviderWorkspaceConfig(nextConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save active route.";
      appendErrorEvent("Route save failed", message);
    }
  }, [appendErrorEvent, providerWorkspaceConfig, workspaceRoot]);

  const persistProviderDefaultModelAndReasoning = useCallback((
    providerId: ProviderId,
    modelId: string,
    nextReasoning: string,
  ) => {
    try {
      const withModel = setProviderDefaultModel(providerWorkspaceConfig, providerId, modelId);
      const nextConfig = setProviderDefaultReasoning(withModel, providerId, nextReasoning);
      saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
      setProviderWorkspaceConfig(nextConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save provider defaults.";
      appendErrorEvent("Provider defaults save failed", message);
    }
  }, [appendErrorEvent, providerWorkspaceConfig, workspaceRoot]);

  // Auto-correct the runtime model when capabilities load and the configured model is
  // unavailable. Placed after persistActiveRoute / persistProviderDefaultModelAndReasoning
  // declarations because the effect calls persistActiveRoute (TDZ-safe from here).
  useEffect(() => {
    if (activeProviderRoute.providerId !== "openai") {
      return;
    }
    if (modelCapabilities?.status !== "ready") {
      return;
    }

    const nextModel = getPreferredModelFromCapabilities(modelCapabilities, model);
    const nextReasoning = normalizeReasoningForModelCapabilities(
      nextModel,
      reasoningLevel,
      modelCapabilities,
    );

    if (nextModel === model && nextReasoning === reasoningLevel) {
      return;
    }

    updateRuntimeConfig((current) => ({
      ...current,
      model: nextModel,
      reasoningLevel: nextReasoning,
    }));

    // Persist the corrected model so providers.json stays in sync and the same
    // correction does not silently re-fire on every restart. Skip persistence
    // when --model was given on the CLI: that session is intentionally temporary.
    if (nextModel !== model && !launchArgs.modelOverride) {
      persistActiveRoute(activeProviderRoute.providerId, nextModel, nextReasoning);
    }

    if (nextModel !== model) {
      appendSystemEvent(
        "Model updated",
        `Configured model ${model} is unavailable in the detected Codex runtime. Active model is now ${nextModel}.`,
      );
    } else if (nextReasoning !== reasoningLevel) {
      appendSystemEvent(
        "Reasoning updated",
        `Reasoning level is now ${formatReasoningLabel(nextReasoning)} for ${nextModel}.`,
      );
    }
  }, [activeProviderRoute.providerId, appendSystemEvent, launchArgs.modelOverride, model, modelCapabilities, persistActiveRoute, reasoningLevel, updateRuntimeConfig]);

  const setBackendWithNotice = useCallback((nextBackend: AvailableBackend) => {
    const gate = guardConfigMutation("backend", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the backend.");
      return;
    }

    updateRuntimeConfig((current) => ({
      ...current,
      provider: nextBackend,
    }));
    setScreen("main");
    appendSystemEvent("Backend updated", `Active backend is now ${formatBackendLabel(nextBackend)}.`);
    if (nextBackend === "codex-subprocess") {
      void refreshAuthStatus(false);
    }
  }, [appendSystemEvent, busy, refreshAuthStatus, updateRuntimeConfig]);

  const setModeWithNotice = useCallback((nextMode: AvailableMode) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the mode.");
      return;
    }

    updateRuntimeConfig((current) => ({
      ...current,
      mode: nextMode,
      planMode: false,
    }));
    saveRuntimeModePreference(nextMode, false);
    setScreen("main");
    appendSystemEvent("Mode updated", `Execution mode switched to ${formatModeLabel(nextMode)}.`);
  }, [appendSystemEvent, busy, updateRuntimeConfig]);

  const cycleModeWithNotice = useCallback(() => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the mode.");
      return;
    }

    const next = getNextRotatingMode(mode, planMode);
    updateRuntimeConfig((current) => ({
      ...current,
      mode: next.mode,
      planMode: next.planMode,
    }));
    saveRuntimeModePreference(next.mode, next.planMode);
    if (!next.planMode) {
      setPlanFlow(resetPlanFlow());
    }
  }, [appendSystemEvent, busy, mode, planMode, updateRuntimeConfig]);

  const setReasoningWithNotice = useCallback((nextReasoningLevel: ReasoningLevel) => {
    const gate = guardConfigMutation("reasoning", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the reasoning level.");
      return;
    }

    const supported = currentModelCapability?.supportedReasoningLevels;
    if (supported && !supported.some((item) => item.id === nextReasoningLevel)) {
      appendErrorEvent(
        "Reasoning unavailable",
        `${model} does not advertise ${formatReasoningLabel(nextReasoningLevel)} reasoning in the detected Codex runtime.`,
      );
      return;
    }

    updateRuntimeConfig((current) => ({
      ...current,
      reasoningLevel: nextReasoningLevel,
    }));
    // When --model was given on the CLI the active route's modelId reflects that CLI arg,
    // not what is stored in providers.json. Persist the stored model so the CLI-only
    // override is never written permanently; fall back to activeProviderRoute.modelId when
    // no CLI model is active (normal interactive case).
    const modelToPersist = launchArgs.modelOverride
      ? (providerWorkspaceConfig.activeRoute?.modelId ?? activeProviderRoute.modelId)
      : activeProviderRoute.modelId;
    if (activeProviderRoute.providerId === "openai") {
      persistProviderDefaultModelAndReasoning("openai", modelToPersist, nextReasoningLevel);
    } else {
      persistActiveRoute(
        activeProviderRoute.providerId,
        modelToPersist,
        nextReasoningLevel,
        activeProviderRoute.backendKind,
        activeProviderRoute.modelSelection,
      );
    }
    setScreen("main");
    appendSystemEvent("Reasoning updated", `Reasoning level is now ${formatReasoningLabel(nextReasoningLevel)}.`);
  }, [
    activeProviderRoute.backendKind,
    activeProviderRoute.modelId,
    activeProviderRoute.modelSelection,
    activeProviderRoute.providerId,
    appendErrorEvent,
    appendSystemEvent,
    busy,
    currentModelCapability,
    launchArgs.modelOverride,
    model,
    persistActiveRoute,
    persistProviderDefaultModelAndReasoning,
    providerWorkspaceConfig.activeRoute,
    updateRuntimeConfig,
  ]);

  const setPlanModeWithNotice = useCallback((nextEnabled: boolean) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing plan mode.");
      return;
    }

    updateRuntimeConfig((current) => ({
      ...current,
      planMode: nextEnabled,
    }));
    saveRuntimeModePreference(mode, nextEnabled);
    if (!nextEnabled) {
      setPlanFlow(resetPlanFlow());
    }
    appendSystemEvent("Plan mode", `Plan mode ${nextEnabled ? "enabled" : "disabled"}.`);
  }, [appendSystemEvent, busy, mode, updateRuntimeConfig]);

  const togglePlanModeWithNotice = useCallback(() => {
    setPlanModeWithNotice(!planMode);
  }, [planMode, setPlanModeWithNotice]);

  const setModelWithNotice = useCallback(async (nextModel: AvailableModel) => {
    const gate = guardConfigMutation("model", busy);
    if (!gate.allowed) {
      traceInputDebug("model_selection_blocked", getInputDebugSnapshot({
        handler: "setModelWithNotice",
        model: nextModel,
        reason: "busy",
      }));
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the model.");
      return;
    }

    modelSelectionInFlightRef.current = true;
    traceInputDebug("model_selection_app_start", getInputDebugSnapshot({
      handler: "setModelWithNotice",
      model: nextModel,
    }));

    try {
      const routeProviderId = activeProviderRoute.providerId;
      const normalizedReasoning = normalizeReasoningForModelCapabilities(nextModel, reasoningLevel, activeRouteModelCapabilities);
      const validation = await validateProviderRouteActivation({
        route: {
          providerId: routeProviderId,
          modelId: nextModel,
          backendKind: getProviderRuntime(routeProviderId).backendKind,
          reasoning: normalizedReasoning,
        },
        workspaceRoot,
        geminiCommandPath: providerWorkspaceConfig.providers?.google?.geminiCommandPath ?? runtimeConfig.geminiCommandPath,
        claudeCommandPath: providerWorkspaceConfig.providers?.anthropic?.claudeCommandPath,
        localConfig: providerWorkspaceConfig.providers?.local,
      });
      if (validation.status !== "ready") {
        appendSystemEvent(
          "Provider route unavailable",
          `${validation.message ?? getProviderRouteSetupMessage(routeProviderId)} Previous active route remains ${activeRouteProvider?.displayName ?? "OpenAI"} / ${activeProviderRoute.modelId}.`,
        );
        return;
      }
      updateRuntimeConfig((current) => ({
        ...current,
        model: nextModel,
        reasoningLevel: normalizeReasoningForModelCapabilities(nextModel, current.reasoningLevel, activeRouteModelCapabilities),
      }));
      persistActiveRoute(routeProviderId, nextModel, normalizedReasoning, validation.backendKind);
      traceInputDebug("model_selection_app_success", getInputDebugSnapshot({
        handler: "setModelWithNotice",
        model: nextModel,
      }));
      appendSystemEvent(
        "Model updated",
        `Active model is now ${nextModel}. Reasoning set to ${formatReasoningLabel(normalizedReasoning)}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traceInputDebug("model_selection_app_failure", getInputDebugSnapshot({
        handler: "setModelWithNotice",
        model: nextModel,
        error: message,
      }));
      appendErrorEvent("Model selection failed", message);
    } finally {
      modelSelectionInFlightRef.current = false;
      returnToChatMode("selection");
    }
  }, [activeProviderRoute.modelId, activeProviderRoute.providerId, activeRouteModelCapabilities, activeRouteProvider, appendErrorEvent, appendSystemEvent, busy, getInputDebugSnapshot, persistActiveRoute, providerWorkspaceConfig.providers, reasoningLevel, returnToChatMode, runtimeConfig.geminiCommandPath, updateRuntimeConfig, workspaceRoot]);

  const setModelAndReasoningWithNotice = useCallback(async (
    nextModel: AvailableModel,
    nextReasoning: ReasoningLevel,
    providerId: ProviderId = activeProviderRoute.providerId,
    geminiSelection?: import("./core/providerRuntime/types.js").GeminiModelSelection,
    localBackend?: LocalBackendId,
  ) => {
    const gate = guardConfigMutation("model", busy);
    if (!gate.allowed) {
      traceInputDebug("model_selection_blocked", getInputDebugSnapshot({
        handler: "setModelAndReasoningWithNotice",
        model: nextModel,
        reasoning: nextReasoning,
        reason: "busy",
      }));
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the model.");
      returnToChatMode("selection-blocked");
      return;
    }

    const routeCapabilities = providerId === "openai"
      ? modelCapabilities
      : providerModelsToCodexCapabilities(discoverProviderModels(providerId).models, nextModel);
    const selectedCapability = findModelCapability(routeCapabilities, nextModel);
    const supported = selectedCapability?.supportedReasoningLevels;
    if (supported && supported.length > 0 && !supported.some((item) => item.id === nextReasoning)) {
      appendErrorEvent(
        "Reasoning unavailable",
        `${nextModel} does not advertise ${formatReasoningLabel(nextReasoning)} reasoning in the detected Codex runtime.`,
      );
      returnToChatMode("selection-invalid");
      return;
    }

    modelSelectionInFlightRef.current = true;
    // Reflect the target provider in the model picker immediately: route
    // validation below can take seconds (subprocess probes), and until it
    // persists the new active route, modelPickerProviderId would otherwise
    // keep resolving to the stale route.
    setPendingRouteProviderId(providerId);
    setRouteSwitchBusy(true);
    traceInputDebug("model_selection_app_start", getInputDebugSnapshot({
      handler: "setModelAndReasoningWithNotice",
      model: nextModel,
      reasoning: nextReasoning,
    }));

    try {
      const normalizedReasoning = normalizeReasoningForModelCapabilities(nextModel, nextReasoning, routeCapabilities);
      let validation;
      try {
        if (providerId === "local") {
          markProviderAvailability("local", "checking", "provider-validation");
        }
        validation = await validateProviderRouteActivation({
          route: {
            providerId,
            modelId: nextModel,
            backendKind: getProviderRuntime(providerId).backendKind,
            reasoning: normalizedReasoning,
            modelSelection: geminiSelection,
            ...(providerId === "local" ? { localBackend: localBackend ?? providerWorkspaceConfig.providers?.local?.localBackend ?? "lm-studio" } : {}),
          },
          workspaceRoot,
          geminiCommandPath: providerWorkspaceConfig.providers?.google?.geminiCommandPath ?? runtimeConfig.geminiCommandPath,
          claudeCommandPath: providerWorkspaceConfig.providers?.anthropic?.claudeCommandPath,
          localConfig: providerId === "local"
            ? { ...providerWorkspaceConfig.providers?.local, localBackend: localBackend ?? providerWorkspaceConfig.providers?.local?.localBackend ?? "lm-studio" }
            : providerWorkspaceConfig.providers?.local,
        });
        if (validation.diagnostics) {
          providerDiagnosticsRef.current[providerId] = validation.diagnostics as Record<string, string | number | boolean | null>;
        }
        setRegistryNonce((n) => n + 1);
      } finally {
        // Runtime status is rendered from provider diagnostics; no title guard is active here.
      }
      if (validation.status !== "ready") {
        traceInputDebug("model_selection_app_failure", getInputDebugSnapshot({
          handler: "setModelAndReasoningWithNotice",
          model: nextModel,
          reasoning: nextReasoning,
          error: validation.message ?? getProviderRouteSetupMessage(providerId),
        }));
        const errorMessage = validation.message ?? getProviderRouteSetupMessage(providerId);
        if (providerRouteErrorsRef.current[providerId] !== errorMessage) {
          appendSystemEvent(
            "Provider route unavailable",
            `${errorMessage} Previous active route remains ${activeRouteProvider?.displayName ?? "OpenAI"} / ${activeProviderRoute.modelId}.`,
          );
          providerRouteErrorsRef.current[providerId] = errorMessage;
        }
        if (!modelPickerOpenRef.current) setPendingRouteProviderId(null);
        return;
      }

      if (providerRouteErrorsRef.current[providerId]) {
        appendSystemEvent(
          "Provider route available",
          validation.message ?? (providerId === "google"
            ? "Google/Gemini is available via Gemini CLI."
            : providerId === "anthropic"
              ? "Anthropic/Claude is available via Claude Code."
              : `${getProviderRuntime(providerId).label} is available via ${validation.backendKind}.`),
        );
        delete providerRouteErrorsRef.current[providerId];
      }

      updateRuntimeConfig((current) => ({
        ...current,
        model: nextModel,
        reasoningLevel: normalizedReasoning,
      }));
      if (providerId === "mistral" && activeProviderRoute.providerId !== "mistral") {
        // Switching to Vibe starts a fresh CLI conversation instead of resuming a stale one.
        resetMistralVibeSession(workspaceRoot);
      }
      persistActiveRoute(providerId, nextModel, normalizedReasoning, validation.backendKind, geminiSelection, localBackend);
      if (!modelPickerOpenRef.current) setPendingRouteProviderId(null);
      traceInputDebug("model_selection_app_success", getInputDebugSnapshot({
        handler: "setModelAndReasoningWithNotice",
        model: nextModel,
        reasoning: normalizedReasoning,
      }));

      // Route changes are reflected reactively in the BottomComposer metadata row.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traceInputDebug("model_selection_app_failure", getInputDebugSnapshot({
        handler: "setModelAndReasoningWithNotice",
        model: nextModel,
        reasoning: nextReasoning,
        error: message,
      }));
      if (!modelPickerOpenRef.current) setPendingRouteProviderId(null);
      appendErrorEvent("Model selection failed", message);
    } finally {
      setRouteSwitchBusy(false);
      modelSelectionInFlightRef.current = false;
      returnToChatMode("selection");
    }
  }, [activeProviderRoute.modelId, activeProviderRoute.providerId, activeRouteProvider, appendErrorEvent, appendSystemEvent, busy, getInputDebugSnapshot, markProviderAvailability, modelCapabilities, persistActiveRoute, providerWorkspaceConfig.providers, returnToChatMode, runtimeConfig.geminiCommandPath, updateRuntimeConfig, workspaceRoot]);

  const setAuthPreferenceWithNotice = useCallback((nextPreference: AuthPreference) => {
    setAuthPreference(nextPreference);
    appendSystemEvent("Auth preference updated", `Preference set to ${formatAuthPreferenceLabel(nextPreference)}.`);
  }, [appendSystemEvent]);

  const applyWorkspaceDisplayMode = useCallback((nextMode: WorkspaceDisplayMode) => {
    setWorkspaceDisplayMode(nextMode);
  }, []);

  const setWorkspaceDisplayModeWithNotice = useCallback((nextMode: WorkspaceDisplayMode) => {
    applyWorkspaceDisplayMode(nextMode);
  }, [applyWorkspaceDisplayMode]);

  const setTerminalTitleModeWithNotice = useCallback((nextMode: TerminalTitleMode) => {
    setTerminalTitleMode(nextMode);
    appendSystemEvent(
      "Settings",
      `Terminal title set to ${formatWorkspaceDisplayModeLabel(nextMode)} (${nextMode}).`,
    );
  }, [appendSystemEvent]);

  const saveSettingsFromPanel = useCallback((nextSettings: UserSettingValues) => {
    if (nextSettings.workspaceDisplayMode !== workspaceDisplayMode) {
      applyWorkspaceDisplayMode(nextSettings.workspaceDisplayMode);
    }
    if (nextSettings.terminalTitleMode !== terminalTitleMode) {
      setTerminalTitleMode(nextSettings.terminalTitleMode);
    }
    const nextShowBusyLoader = parseBusyLoaderSettingValue(nextSettings.showBusyLoader);
    if (nextShowBusyLoader !== showBusyLoader) {
      setShowBusyLoader(nextShowBusyLoader);
    }
    setScreen("main");
  }, [applyWorkspaceDisplayMode, showBusyLoader, terminalTitleMode, workspaceDisplayMode]);

  const handleSkipUpdateForSession = useCallback(() => {
    returnFromUpdateOverlay();
  }, [returnFromUpdateOverlay]);

  const setApprovalPolicyWithNotice = useCallback((nextValue: RuntimeApprovalPolicy) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    updateRuntimePolicy((current) => ({ ...current, approvalPolicy: nextValue }));
    appendSystemEvent("Runtime policy", `Approval policy set to ${formatApprovalPolicyLabel(nextValue)}.`);
  }, [appendSystemEvent, busy, updateRuntimePolicy]);

  const setSandboxModeWithNotice = useCallback((nextValue: RuntimeSandboxMode) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    updateRuntimePolicy((current) => ({ ...current, sandboxMode: nextValue }));
    appendSystemEvent("Runtime policy", `Sandbox mode set to ${formatSandboxModeLabel(nextValue)}.`);
  }, [appendSystemEvent, busy, updateRuntimePolicy]);

  const setNetworkAccessWithNotice = useCallback((nextValue: RuntimeNetworkAccess) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    updateRuntimePolicy((current) => ({ ...current, networkAccess: nextValue }));
    appendSystemEvent("Runtime policy", `Network access set to ${formatNetworkAccessLabel(nextValue)}.`);
  }, [appendSystemEvent, busy, updateRuntimePolicy]);

  const addWritableRootWithNotice = useCallback((pathValue: string) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    const resolvedPath = resolveWritableRootCommandPath(pathValue, workspaceRoot);
    updateRuntimeConfig((current) => addWritableRoot(current, resolvedPath));
    appendSystemEvent("Runtime policy", `Writable root added: ${resolvedPath}.`);
  }, [appendSystemEvent, busy, updateRuntimeConfig, workspaceRoot]);

  const removeWritableRootWithNotice = useCallback((pathValue: string) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    const resolvedPath = resolveWritableRootCommandPath(pathValue, workspaceRoot);
    updateRuntimeConfig((current) => removeWritableRoot(current, resolvedPath));
    appendSystemEvent("Runtime policy", `Writable root removed: ${resolvedPath}.`);
  }, [appendSystemEvent, busy, updateRuntimeConfig, workspaceRoot]);

  const clearWritableRootsWithNotice = useCallback(() => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    updateRuntimeConfig((current) => clearWritableRoots(current));
    appendSystemEvent("Runtime policy", "Writable roots cleared.");
  }, [appendSystemEvent, busy, updateRuntimeConfig]);

  const setServiceTierWithNotice = useCallback((nextValue: RuntimeServiceTier) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    updateRuntimePolicy((current) => ({ ...current, serviceTier: nextValue }));
    appendSystemEvent("Runtime policy", `Service tier set to ${formatServiceTierLabel(nextValue)}.`);
  }, [appendSystemEvent, busy, updateRuntimePolicy]);

  const setPersonalityWithNotice = useCallback((nextValue: RuntimePersonality) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    updateRuntimePolicy((current) => ({ ...current, personality: nextValue }));
    appendSystemEvent("Runtime policy", `Personality set to ${formatPersonalityLabel(nextValue)}.`);
  }, [appendSystemEvent, busy, updateRuntimePolicy]);

  const setProjectTrustWithNotice = useCallback((trusted: boolean) => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing project trust.");
      return;
    }

    const projectRoot = baseLayeredConfig.diagnostics.projectRoot;
    setProjectTrust(projectRoot, trusted);
    reloadBaseLayeredConfig();
    appendSystemEvent(
      "Config trust",
      `${trusted ? "Trusted" : "Untrusted"} project root: ${projectRoot}.`,
    );
  }, [appendSystemEvent, baseLayeredConfig.diagnostics.projectRoot, busy, reloadBaseLayeredConfig]);

  const openBackendPicker = useCallback(() => {
    const gate = guardConfigMutation("backend", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the backend.");
      return;
    }

    setScreen("backend-picker");
  }, [appendSystemEvent, busy]);

  const probeLocalBackend = useCallback((localBackend: LocalBackendId) => {
    const existing = localBackendCheckInFlightRef.current.get(localBackend);
    if (existing) return existing;

    setLocalBackendStatuses((current) => ({
      ...current,
      [localBackend]: { state: "checking", label: "Checking…" },
    }));
    const promise = checkLocalProvider({
      override: { ...providerWorkspaceConfig.providers?.local, localBackend },
      localBackend,
    }).then((validation) => {
      const selectedModel = typeof validation.diagnostics?.selectedModel === "string"
        ? validation.diagnostics.selectedModel.trim()
        : "";
      const message = validation.message ?? "";
      const endpointResult = validation.diagnostics?.endpointCheckResult;
      const status: LocalBackendStatus = validation.status === "ready"
        ? { state: "ready", label: selectedModel || "Model loaded" }
        : endpointResult === "no-models" || /no model is loaded|no models were returned/i.test(message)
          ? { state: "no-model", label: "No model loaded" }
          : /api key|authentication|authenticate|identity/i.test(message)
            ? { state: "auth-required", label: "Authentication required" }
            : { state: "not-running", label: "Not running" };
      if (isMountedRef.current) {
        setLocalBackendStatuses((current) => ({ ...current, [localBackend]: status }));
      }
      return validation;
    }).catch((error) => {
      if (isMountedRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setLocalBackendStatuses((current) => ({
          ...current,
          [localBackend]: /api key|authentication|authenticate|identity/i.test(message)
            ? { state: "auth-required", label: "Authentication required" }
            : { state: "not-running", label: "Not running" },
        }));
      }
      throw error;
    }).finally(() => {
      localBackendCheckInFlightRef.current.delete(localBackend);
    });
    localBackendCheckInFlightRef.current.set(localBackend, promise);
    return promise;
  }, [providerWorkspaceConfig.providers]);

  const probeLocalBackends = useCallback(() => {
    void Promise.allSettled([
      probeLocalBackend("lm-studio"),
      probeLocalBackend("unsloth"),
    ]);
  }, [probeLocalBackend]);

  const openProviderPicker = useCallback(() => {
    modelPickerOpenRef.current = false;
    // Mid route switch, keep the pending id so initialProviderId highlights
    // the provider being activated instead of the stale route.
    if (!modelSelectionInFlightRef.current) {
      setPendingRouteProviderId(null);
    }
    const gate = guardConfigMutation("backend", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before opening providers.");
      return;
    }

    setScreen("provider-picker");
    providerDiagnosticsRef.current.mistral = {
      ...providerDiagnosticsRef.current.mistral,
      selectedModel: detectVibeActiveModel({ cwd: workspaceRoot }).modelId,
      availabilityStatus: "checking",
    };
    void resolveVibeExecutable({ cwd: workspaceRoot }).then((resolvedCommand) => {
      if (!isMountedRef.current) return;
      const modelDetection = detectVibeActiveModel({ cwd: workspaceRoot });
      providerDiagnosticsRef.current.mistral = {
        resolvedCommand,
        selectedModel: modelDetection.modelId,
        modelSource: modelDetection.source,
        configPath: modelDetection.configPath,
        availabilityStatus: resolvedCommand ? "available" : "unavailable",
      };
      setRegistryNonce((n) => n + 1);
    }).catch(() => {
      if (!isMountedRef.current) return;
      providerDiagnosticsRef.current.mistral = {
        selectedModel: detectVibeActiveModel({ cwd: workspaceRoot }).modelId,
        resolvedCommand: null,
        availabilityStatus: "unavailable",
      };
      setRegistryNonce((n) => n + 1);
    });
  }, [appendSystemEvent, busy, workspaceRoot]);

  const setWorkspaceDefaultProviderWithNotice = useCallback((providerId: ProviderId) => {
    const provider = findProvider(providerRegistry, providerId);
    if (!provider) {
      appendErrorEvent("Provider unavailable", `Unknown provider: ${providerId}`);
      return;
    }

    try {
      const nextConfig = setProviderWorkspaceDefault(providerWorkspaceConfig, providerId);
      saveProviderWorkspaceConfig(workspaceRoot, nextConfig);
      setProviderWorkspaceConfig(nextConfig);
      setScreen("main");
      const routeConfigured = isProviderRouteConfigured(providerId);
      appendSystemEvent(
        "Provider default updated",
        provider.routeMode === "launch-only"
          ? `${provider.displayName} is now the workspace default external CLI. Active chat route remains ${activeRouteProvider?.displayName ?? "OpenAI"} / ${model}.`
          : provider.routeMode === "in-codexa" && routeConfigured
          ? `${provider.displayName} is now the workspace default provider. Active chat route remains ${activeRouteProvider?.displayName ?? "OpenAI"} / ${model}.`
          : `${provider.displayName} is set as the workspace default, but in-Codexa routing is not configured yet. Active chat route remains ${activeRouteProvider?.displayName ?? "OpenAI"} / ${model}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save provider workspace config.";
      appendErrorEvent("Provider default failed", message);
    }
  }, [activeRouteProvider, appendErrorEvent, appendSystemEvent, model, providerRegistry, providerWorkspaceConfig, workspaceRoot]);

  const handleProviderAction = useCallback((providerId: ProviderId, action: ProviderPickerAction, selectedLocalBackend?: LocalBackendId) => {
    if (action === "cancel") {
      modelPickerOpenRef.current = false;
      setScreen("main");
      return;
    }

    if (action === "set-default") {
      setWorkspaceDefaultProviderWithNotice(providerId);
      return;
    }

    const provider = findProvider(providerRegistry, providerId);
    if (!provider) {
      setScreen("main");
      appendErrorEvent("Provider unavailable", `Unknown provider: ${providerId}`);
      return;
    }

    if (action === "use-in-codexa") {
      if (!isProviderRoutableInCodexa(providerId)) {
        const message = provider.isDefault
          ? `${provider.displayName} is set as the workspace default, but in-Codexa routing is not configured yet.`
          : `${provider.displayName} in-Codexa routing is not configured yet.`;
        if (providerRouteErrorsRef.current[providerId] !== message) {
          appendSystemEvent("Provider route unavailable", message);
          providerRouteErrorsRef.current[providerId] = message;
        }
        return;
      }

      if (providerId === "local") {
        const localBackend = selectedLocalBackend ?? providerWorkspaceConfig.providers?.local?.localBackend ?? "lm-studio";
        if (localBackendCheckInFlightRef.current.has(localBackend)) return;
        const preferredConfig = setLocalBackendPreference(providerWorkspaceConfig, localBackend);
        saveProviderWorkspaceConfig(workspaceRoot, preferredConfig);
        setProviderWorkspaceConfig(preferredConfig);
        void probeLocalBackend(localBackend).then((validation) => {
          if (!isMountedRef.current) return;
          if (validation.diagnostics) {
            providerDiagnosticsRef.current["local"] = validation.diagnostics as Record<string, string | number | boolean | null>;
          }
          if (validation.status !== "ready") {
            const message = validation.message ?? "Local provider unavailable.";
            providerRouteErrorsRef.current["local"] = message;
            setRegistryNonce((n) => n + 1);
            return;
          }
          delete providerRouteErrorsRef.current["local"];
          const selectedModel = typeof validation.diagnostics?.selectedModel === "string" && validation.diagnostics.selectedModel.trim()
            ? validation.diagnostics.selectedModel.trim()
            : provider.currentModel;
          setRegistryNonce((n) => n + 1);
          intendedInputModeRef.current = "chat/input";
          intendedFocusTargetRef.current = FOCUS_IDS.composer;
          setScreen("main");
          void setModelAndReasoningWithNotice(
            selectedModel as AvailableModel,
            (providerWorkspaceConfig.providers?.local?.currentReasoning ?? activeProviderRoute.reasoning ?? reasoningLevel) as ReasoningLevel,
            "local",
            undefined,
            localBackend,
          );
        }).catch(() => undefined);
        return;
      }

      const workspaceProviderConfig = providerWorkspaceConfig.providers?.[providerId];
      const activeRoute = providerWorkspaceConfig.activeRoute;
      const isCurrentActive = activeRoute?.providerId === providerId;

      // A "real" model is one that isn't a generic placeholder label from registry.ts
      const isRealModel = provider.currentModel &&
                         !provider.currentModel.endsWith("default") &&
                         provider.currentModel !== "Google default";

      const providerReasoning = workspaceProviderConfig?.currentReasoning
        ?? (isCurrentActive ? activeRoute?.reasoning : undefined)
        ?? reasoningLevel;

      if (isRealModel || isCurrentActive) {
        let geminiSelection: import("./core/providerRuntime/types.js").GeminiModelSelection | undefined;
        if (providerId === "google") {
          if (isCurrentActive && activeRoute?.modelSelection) {
            geminiSelection = activeRoute.modelSelection;
          } else if (workspaceProviderConfig?.currentModel) {
            geminiSelection = { kind: "manual", modelId: workspaceProviderConfig.currentModel };
          } else {
            geminiSelection = { kind: "auto", family: "gemini-3" };
          }
        }

        intendedInputModeRef.current = "chat/input";
        intendedFocusTargetRef.current = FOCUS_IDS.composer;
        setScreen("main");
        void setModelAndReasoningWithNotice(
          (workspaceProviderConfig?.currentModel ?? provider.currentModel) as AvailableModel,
          providerReasoning as ReasoningLevel,
          providerId,
          geminiSelection,
        );
        return;
      }

      // No clear model to use, open the picker.
      void ensureProviderModels(providerId);
      setPendingRouteProviderId(providerId);
      modelPickerOpenRef.current = true;
      intendedInputModeRef.current = "model-picker";
      intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
      setScreen("model-picker");
      return;
    }

    if (action === "select-model") {
      if (providerId === "openai" && !modelCapabilities) {
        void refreshModelCapabilities(false, false);
      }
      void ensureProviderModels(providerId);
      setPendingRouteProviderId(providerId);
      modelPickerOpenRef.current = true;
      intendedInputModeRef.current = "model-picker";
      intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
      setScreen("model-picker");
      return;
    }

    if (action === "refresh-models") {
      if (!isProviderRoutableInCodexa(providerId)) {
        const message = provider.isDefault
          ? `${provider.displayName} is set as the workspace default, but in-Codexa routing is not configured yet.`
          : `${provider.displayName} in-Codexa routing is not configured yet.`;
        if (providerRouteErrorsRef.current[providerId] !== message) {
          appendSystemEvent("Provider route unavailable", message);
          providerRouteErrorsRef.current[providerId] = message;
        }
        return;
      }

      if (providerId === "openai") {
        void refreshModelCapabilities(true, true);
        appendSystemEvent("Model discovery", `Refreshing models for ${provider.displayName}.`);
      } else {
        const runtime = getProviderRuntime(providerId);
        if (runtime.refreshModels) {
          appendSystemEvent("Model discovery", providerId === "anthropic"
            ? "Refreshing Claude capabilities..."
            : `Refreshing models for ${provider.displayName}...`);
          if (providerId === "local") {
            markProviderAvailability("local", "checking", "refresh-models");
          }
          void runtime.refreshModels({
            cwd: workspaceRoot,
            localConfig: providerId === "local" ? providerWorkspaceConfig.providers?.local : undefined,
          }).then((discovery) => {
            persistProviderDiscovery(discovery);
            if (discovery.diagnostics) {
              providerDiagnosticsRef.current[providerId] = discovery.diagnostics as Record<string, string | number | boolean | null>;
            }
            if (discovery.status === "ready") {
              delete providerRouteErrorsRef.current[providerId];
            } else if (discovery.message) {
              providerRouteErrorsRef.current[providerId] = discovery.message;
            }
            appendSystemEvent(
              "Model discovery",
              discovery.status === "ready"
                ? discovery.message ?? `Loaded ${discovery.models.length} models for ${provider.displayName} (${discovery.models[0]?.source ?? "fallback"}).`
                : discovery.message ?? `${provider.displayName} model routing is not configured yet.`,
            );
            setRegistryNonce((n) => n + 1);
          });
        } else {
          const discovery = discoverProviderModels(providerId);
          appendSystemEvent(
            "Model discovery",
            discovery.status === "ready"
              ? `Loaded ${discovery.models.length} configured models for ${provider.displayName}.`
              : discovery.message ?? `${provider.displayName} model routing is not configured yet.`,
          );
        }
      }
      return;
    }

    if (action === "run-diagnostics") {
      if (providerId !== "google" && providerId !== "local") {
        appendErrorEvent("Provider diagnostics unavailable", `Diagnostics are not implemented for ${provider.displayName}.`);
        return;
      }

      setScreen("main");
      if (providerId === "local") {
        appendSystemEvent("Local diagnostics", "Running Local provider diagnostics...");
        void runLocalDiagnostics({
          localConfig: providerWorkspaceConfig.providers?.local,
        }).then((message) => {
          if (!isMountedRef.current) return;
          const discovery = discoverProviderModels("local");
          if (discovery.diagnostics) {
            providerDiagnosticsRef.current["local"] = discovery.diagnostics as Record<string, string | number | boolean | null>;
          }
          if (discovery.status === "ready") {
            delete providerRouteErrorsRef.current["local"];
          } else if (discovery.message) {
            providerRouteErrorsRef.current["local"] = discovery.message;
          }
          appendSystemEvent("Local diagnostics", message);
          setRegistryNonce((n) => n + 1);
        }).catch((error) => {
          if (!isMountedRef.current) return;
          appendErrorEvent("Local diagnostics failed", error instanceof Error ? error.message : String(error));
        });
        return;
      }

      appendSystemEvent("Gemini diagnostics", "Running Gemini diagnostics...");
      const geminiCommandPath = providerWorkspaceConfig.providers?.google?.geminiCommandPath ?? runtimeConfig.geminiCommandPath;
      void runGeminiDiagnostics({
        cwd: workspaceRoot,
        runtime: geminiCommandPath ? { ...resolvedRuntimeConfig, geminiCommandPath } : resolvedRuntimeConfig,
        configuredPath: geminiCommandPath,
        selectedModel: activeProviderRoute.providerId === "google"
          ? activeProviderRoute.modelId
          : providerWorkspaceConfig.providers?.google?.currentModel ?? "gemini-3-flash-preview",
        selectedReasoning: activeProviderRoute.providerId === "google"
          ? activeProviderRoute.reasoning ?? reasoningLevel
          : providerWorkspaceConfig.providers?.google?.currentReasoning ?? reasoningLevel,
      }).then((message) => {
        if (!isMountedRef.current) return;
        appendSystemEvent("Gemini diagnostics", message);
      }).catch((error) => {
        if (!isMountedRef.current) return;
        const message = error instanceof Error ? error.message : "Gemini diagnostics failed.";
        appendErrorEvent("Gemini diagnostics failed", message);
      });
      return;
    }

    // Do a real executable preflight before launching any external provider.
    // A missing CLI is a setup state, not a launch error the user should have
    // to decode after Codexa has already handed over the terminal.
    if (action === "launch" && provider.launchCommand?.executable && !providerLaunchBypassRef.current) {
      void commandExistsOnPath(provider.launchCommand.executable).then((available) => {
        if (!isMountedRef.current) return;
        if (!available) {
          setProviderSetup(providerId);
          setScreen("provider-setup");
          return;
        }
        providerLaunchBypassRef.current = true;
        providerActionRef.current?.(providerId, action);
      }).catch(() => {
        if (!isMountedRef.current) return;
        setProviderSetup(providerId);
        setScreen("provider-setup");
      });
      return;
    }
    providerLaunchBypassRef.current = false;

    if (busyRef.current) {
      appendSystemEvent("Busy", "Finish the current run before launching a provider CLI.");
      return;
    }

    setScreen("main");
    appendSystemEvent(
      "Provider launch",
      `Suspending Codexa and launching ${provider.displayName}${providerId === "mistral" ? ` / ${provider.currentModel}` : ""}. Codexa will resume when the external CLI exits.`,
    );

    const launchOptions = {
      cwd: workspaceRoot,
      stdin,
      beforeLaunch: () => {
        terminalControl.setMouseReporting(false, "src/app.tsx:providerLaunch.disableMouse");
        stdout.write("\n");
      },
      afterLaunch: () => {
        terminalControl.setMouseReporting(false, "src/app.tsx:providerLaunch.keepMouseNative");
      },
    };
    const launchPromise = providerId === "mistral"
      ? launchMistralVibeCli(provider, launchOptions)
      : launchProviderCli(provider, launchOptions);

    void launchPromise.then((result) => {
      if (!isMountedRef.current) return;
      if (providerId === "mistral" && (result.status === "missing-command" || result.status === "spawn-error")) {
        appendErrorEvent("Mistral Vibe launch failed", result.message);
      } else {
        appendSystemEvent("Provider launch", result.message);
      }
    }).catch((error) => {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : "Provider launch failed.";
      appendErrorEvent("Provider launch failed", message);
    });
  }, [
    activeProviderRoute,
    appendErrorEvent,
    appendSystemEvent,
    ensureProviderModels,
    providerRegistry,
    probeLocalBackend,
    providerWorkspaceConfig.providers,
    markProviderAvailability,
    modelCapabilities,
    reasoningLevel,
    refreshModelCapabilities,
    resolvedRuntimeConfig,
    runtimeConfig.geminiCommandPath,
    setWorkspaceDefaultProviderWithNotice,
    stdin,
    stdout,
    terminalControl,
    workspaceRoot,
  ]);

  useEffect(() => {
    providerActionRef.current = handleProviderAction;
    return () => {
      providerActionRef.current = null;
    };
  }, [handleProviderAction]);

  const runProviderSetup = useCallback((providerId: ProviderId) => {
    const provider = findProvider(providerRegistry, providerId);
    const windows = process.platform === "win32";
    const plan = getProviderSetupPlan(providerId, windows);

    // Providers with user-supplied commands cannot be safely installed by
    // Codexa. The prompt still gives them a retry path after manual setup.
    if (!plan.installCommand) {
      providerLaunchBypassRef.current = true;
      setProviderSetup(null);
      setScreen("provider-picker");
      providerActionRef.current?.(providerId, "launch");
      return;
    }

    setProviderSetup(null);
    setScreen("main");
    const command = `${plan.installCommand}${plan.setupCommand ? `; ${plan.setupCommand}` : ""}`;
    const child = windows
      ? spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$ErrorActionPreference='Stop'; ${command}`,
      ], { cwd: workspaceRoot, stdio: "inherit" })
      : spawn("sh", ["-lc", command.replace(/; /g, " && ")], {
        cwd: workspaceRoot,
        stdio: "inherit",
      });

    child.once("error", (error) => {
      appendErrorEvent("Mistral Vibe setup failed", error.message);
    });
    child.once("close", (code) => {
      if (code === 0) {
        appendSystemEvent(`${provider?.displayName ?? providerId} setup`, "Installation and setup finished. Reopen the provider picker to launch it.");
      } else if (code !== null) {
        appendErrorEvent(`${provider?.displayName ?? providerId} setup failed`, `The setup process exited with code ${code}.`);
      }
    });
  }, [appendErrorEvent, appendSystemEvent, providerRegistry, workspaceRoot]);

  const openModelPicker = useCallback(() => {
    // While a route switch is validating, keep the pending id so the picker
    // shows the target provider instead of snapping back to the stale route.
    if (!modelSelectionInFlightRef.current) {
      setPendingRouteProviderId(null);
    }
    traceInputDebug("model_picker_open_request", getInputDebugSnapshot({
      handler: "openModelPicker",
      currentScreen: screen,
    }));

    const gate = guardConfigMutation("model", busy);
    if (!gate.allowed) {
      traceInputDebug("model_picker_open_blocked", getInputDebugSnapshot({
        handler: "openModelPicker",
        reason: "busy",
      }));
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the model.");
      return;
    }

    if (screen === "model-picker") {
      modelPickerOpenRef.current = true;
      intendedInputModeRef.current = "model-picker";
      intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
      traceInputDebug("model_picker_open_duplicate", getInputDebugSnapshot({
        handler: "openModelPicker",
        focusTarget: FOCUS_IDS.modelPicker,
      }));
      focusManager.focus(FOCUS_IDS.modelPicker);
      return;
    }

    // Kick off discovery if we don't already have capabilities. The helper is
    // single-flight, so repeated picker opens while discovery is in progress
    // subscribe to the existing promise instead of spawning duplicate jobs or
    // log entries. Open the picker immediately; it renders a loading state
    // until the promise resolves and state updates commit the model list.
    modelPickerOpenRef.current = true;
    const targetProviderId = pendingRouteProviderId ?? activeProviderRoute.providerId;
    if (targetProviderId === "openai" && !modelCapabilities) {
      traceInputDebug("model_picker_loading_trigger", getInputDebugSnapshot({
        handler: "openModelPicker",
      }));
      void refreshModelCapabilities(false, false);
    }
    void ensureProviderModels(targetProviderId);

    intendedInputModeRef.current = "model-picker";
    intendedFocusTargetRef.current = FOCUS_IDS.modelPicker;
    setScreen("model-picker");
    traceInputDebug("model_picker_opened", getInputDebugSnapshot({
      handler: "openModelPicker",
      nextScreen: "model-picker",
      focusTarget: FOCUS_IDS.modelPicker,
    }));
  }, [activeProviderRoute.providerId, appendSystemEvent, busy, ensureProviderModels, focusManager, getInputDebugSnapshot, modelCapabilities, pendingRouteProviderId, refreshModelCapabilities, screen]);

  const openModePicker = useCallback(() => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the mode.");
      return;
    }

    setScreen("mode-picker");
  }, [appendSystemEvent, busy]);

  const openReasoningPicker = useCallback(() => {
    const gate = guardConfigMutation("reasoning", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the reasoning level.");
      return;
    }

    if (!currentModelCapability?.supportedReasoningLevels?.length) {
      if (!modelCapabilitiesBusy) {
        void refreshModelCapabilities(true, true);
      }
      appendSystemEvent(
        "Reasoning unavailable",
        `Codex has not provided reasoning metadata for ${model}. No guessed reasoning levels will be shown.`,
      );
      return;
    }

    setScreen("reasoning-picker");
  }, [appendSystemEvent, busy, currentModelCapability, model, modelCapabilitiesBusy, refreshModelCapabilities]);

  const openThemePicker = useCallback(() => {
    const gate = guardConfigMutation("theme", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing the theme.");
      return;
    }

    setScreen("theme-picker");
  }, [appendSystemEvent, busy]);

  const openSettingsPanel = useCallback(() => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing settings.");
      return;
    }

    setScreen("settings-panel");
  }, [appendSystemEvent, busy]);

  const openAuthPanel = useCallback(() => {
    if (busy) {
      appendSystemEvent("Busy", "Finish the current run before opening auth guidance.");
      return;
    }

    setScreen("auth-panel");
  }, [appendSystemEvent, busy]);

  const openPermissionsPanel = useCallback(() => {
    const gate = guardConfigMutation("mode", busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before changing runtime policy.");
      return;
    }

    setScreen("permissions-panel");
  }, [appendSystemEvent, busy]);

  const openPermissionsApprovalPicker = useCallback(() => {
    setScreen("permissions-approval-picker");
  }, []);

  const openPermissionsSandboxPicker = useCallback(() => {
    setScreen("permissions-sandbox-picker");
  }, []);

  const openPermissionsNetworkPicker = useCallback(() => {
    setScreen("permissions-network-picker");
  }, []);

  const openPermissionsAddWritableRoot = useCallback(() => {
    setScreen("permissions-add-writable-root");
  }, []);

  const openPermissionsRemoveWritableRoot = useCallback(() => {
    if (runtimeConfig.policy.writableRoots.length === 0) {
      appendSystemEvent("Runtime policy", "No writable roots are configured.");
      return;
    }

    setScreen("permissions-remove-writable-root");
  }, [appendSystemEvent, runtimeConfig.policy.writableRoots.length]);

  const handlePermissionsPanelAction = useCallback((action: PermissionsPanelAction) => {
    switch (action) {
      case "approval-policy":
        openPermissionsApprovalPicker();
        return;
      case "sandbox":
        openPermissionsSandboxPicker();
        return;
      case "network":
        openPermissionsNetworkPicker();
        return;
      case "writable-roots-summary":
        appendSystemEvent(
          "Runtime policy",
          `Writable roots:\n${formatWritableRootsMessage(runtimeConfig.policy.writableRoots)}`,
        );
        return;
      case "writable-roots-add":
        openPermissionsAddWritableRoot();
        return;
      case "writable-roots-remove":
        openPermissionsRemoveWritableRoot();
        return;
      case "writable-roots-clear":
        clearWritableRootsWithNotice();
        return;
      default:
        return;
    }
  }, [
    appendSystemEvent,
    clearWritableRootsWithNotice,
    openPermissionsAddWritableRoot,
    openPermissionsApprovalPicker,
    openPermissionsNetworkPicker,
    openPermissionsRemoveWritableRoot,
    openPermissionsSandboxPicker,
    runtimeConfig.policy.writableRoots,
  ]);

  const resetComposer = useCallback(() => {
    dispatchSession({ type: "RESET_INPUT" });
  }, [dispatchSession]);

  const resetToHomeScreen = useCallback((seedEvents: TimelineEvent[] = []) => {
    dispatchSession({
      type: "CLEAR_TRANSCRIPT",
      seedEvents,
    });
    setConversationChars(0);
    setScreen("main");
    resetComposer();
    intendedFocusTargetRef.current = FOCUS_IDS.composer;
    focusManager.focus(FOCUS_IDS.composer);
  }, [dispatchSession, focusManager, resetComposer]);

  const finalizePromptRun = useCallback((
    runId: number,
    turnId: number,
    status: "completed" | "failed" | "canceled",
    message?: string,
    response?: string,
    persistedResponse?: string,
  ) => {
    if (!isCurrentRun(activeRunIdRef.current, runId)) {
      appDiagLog(`FINALIZE_RUN_BOUNDARY: ignored stale runId=${runId} turnId=${turnId} status=${status} activeRunId=${activeRunIdRef.current}`);
      return false;
    }
    perf.mark("finalize_start");

    const lifecycle = activeRunLifecycleRef.current;
    const timing = activeRunTimingRef.current?.runId === runId
      ? activeRunTimingRef.current
      : null;
    const finalMonotonicMs = performance.now();
    const durationMs = timing
      ? Math.max(0, Math.round(finalMonotonicMs - timing.submitMonotonicMs))
      : 0;
    renderDebug.traceEvent("run", "finalizeTiming", {
      runId,
      turnId,
      status,
      promptSubmitEpochMs: timing?.submitEpochMs,
      promptSubmitMonotonicMs: timing?.submitMonotonicMs,
      finalRenderMonotonicMs: finalMonotonicMs,
      elapsedWallMs: durationMs,
    });
    const cleanup = cleanupRef.current;
    cleanupRef.current = null;
    activeRunLifecycleRef.current = null;
    activeRunTimingRef.current = null;
    activeRunIdRef.current = null;
    activeTurnIdRef.current = null;
    appDiagLog([
      "FINALIZE_RUN_BOUNDARY:",
      `provider=${activeProviderRoute.providerId}`,
      `runId=${runId}`,
      `turnId=${turnId}`,
      `status=${status}`,
      `responseProvided=${response !== undefined}`,
      `responseLength=${response?.length ?? 0}`,
      `messagePresent=${Boolean(message?.trim())}`,
      `composerUnlockReason=finalizePromptRun:${status}`,
    ].join(" "));
    focusManager.focus(FOCUS_IDS.composer);
    appDiagLog(`COMPOSER_ACTIVE_AGAIN: reason=finalizePromptRun:${status} activeRunCleared=true focusTarget=${FOCUS_IDS.composer}`);
    cleanup?.();
    const safeMessage = message ? sanitizeTerminalOutput(message) : undefined;
    // When response is undefined, signal the reducer to preserve streamed content as-is.
    const safeResponse = response != null
      ? sanitizeTerminalOutput(response, { preserveTabs: false, tabSize: 2 })
      : undefined;
    const shouldParseActionRequired = lifecycle?.parseActionRequired ?? true;
    const parsed = status === "completed" && safeResponse?.trim()
      ? shouldParseActionRequired
        ? extractAssistantActionRequired(safeResponse)
        : { content: safeResponse, question: null as string | null }
      : { content: safeResponse, question: null as string | null };
    const safePersistedResponse = persistedResponse != null
      ? sanitizeTerminalOutput(persistedResponse, { preserveTabs: false, tabSize: 2 })
      : undefined;
    const conversationResponse = selectPersistedAssistantResponse(parsed.content, safePersistedResponse);
    if (status === "completed" && conversationResponse?.trim()) {
      appendConversationMessage({ role: "assistant", content: conversationResponse });
    }
    appDiagLog([
      "FINALIZE_RUN_PAYLOAD:",
      `provider=${activeProviderRoute.providerId}`,
      `runId=${runId}`,
      `turnId=${turnId}`,
      `status=${status}`,
      `safeResponseLength=${safeResponse?.length ?? 0}`,
      `parsedContentLength=${parsed.content?.length ?? 0}`,
      `assistantAppendCalledExpected=${Boolean(parsed.content?.trim())}`,
      `finalRunState=${status}`,
    ].join(" "));
    dispatchSession({
      type: "FINALIZE_RUN",
      runId,
      turnId,
      status,
      message: safeMessage,
      response: parsed.content,
      durationMs,
      responsePresentation: lifecycle?.responsePresentation,
      question: status === "completed" ? parsed.question : null,
      assistantFactory: () => ({
        id: createEventId(),
        type: "assistant",
        createdAt: Date.now(),
        content: parsed.content?.trim() ? parsed.content : "",
        contentChunks: [],
        turnId,
      }),
    });
    perf.mark("finalize_done");
    perf.setMeta("content_length", parsed.content?.length ?? 0);
    perf.setMeta("status", status);
    perf.setMeta("elapsed_wall_ms", durationMs);
    const perfSession = perf.getSession();
    if (perfSession) perf.persistSession(perfSession);

    if (status === "completed") {
      lifecycle?.onCompleted?.({
        response: parsed.content ?? "",
        turnId,
        runId,
      });
    } else if (status === "failed") {
      lifecycle?.onFailed?.({
        message: safeMessage ?? "Run failed",
        turnId,
        runId,
      });
    } else {
      lifecycle?.onCanceled?.({
        turnId,
        runId,
      });
    }

    return true;
  }, [activeProviderRoute.providerId, appendConversationMessage, dispatchSession, focusManager]);

  const cancelActiveRun = useCallback((retainHistory = true) => {
    const runId = activeRunIdRef.current;
    if (runId === null) return false;
    const promptTurnId = activeTurnIdRef.current;

    if (!isCurrentRun(activeRunIdRef.current, runId)) {
      return false;
    }

    const shellEvent = activeEvents.find((event) => event.type === "shell" && event.id === runId) as ShellEvent | undefined;
    const runEvent = activeEvents.find((event) => event.type === "run" && event.id === runId) as RunEvent | undefined;

    if (retainHistory && runEvent) {
      return finalizePromptRun(runId, runEvent.turnId, "canceled");
    }

    const cleanup = cleanupRef.current;
    const lifecycle = activeRunLifecycleRef.current;
    cleanupRef.current = null;
    activeRunLifecycleRef.current = null;
    activeRunTimingRef.current = null;
    activeRunIdRef.current = null;
    activeTurnIdRef.current = null;
    focusManager.focus(FOCUS_IDS.composer);
    cleanup?.();

    if (retainHistory) {
      if (shellEvent) {
        activeRunLifecycleRef.current = null;
        activeRunTimingRef.current = null;
        dispatchSession({
          type: "FINALIZE_SHELL",
          shellId: runId,
          finalEvent: { ...shellEvent, status: "failed", exitCode: -1, durationMs: null },
        });
      } else {
        dispatchSession({ type: "REMOVE_ACTIVE_RUNTIME", runId, turnId: promptTurnId });
        const runEvent = activeEvents.find((event) => event.type === "run" && event.id === runId) as RunEvent | undefined;
        if (runEvent) {
          void finalizePromptRun(runId, runEvent.turnId, "canceled");
        } else {
          if (promptTurnId !== null) {
            lifecycle?.onCanceled?.({ turnId: promptTurnId, runId });
          }
          dispatchSession({ type: "REMOVE_ACTIVE_RUNTIME", runId, turnId: promptTurnId });
        }
      }
    } else {
      if (promptTurnId !== null) {
        lifecycle?.onCanceled?.({ turnId: promptTurnId, runId });
      }
      if (uiState.kind === "SHELL_RUNNING") {
        dispatchSession({ type: "UI_ACTION", action: { type: "SHELL_FINISHED", shellId: runId } });
      } else if (promptTurnId !== null) {
        dispatchSession({ type: "UI_ACTION", action: { type: "RUN_CANCELED", turnId: promptTurnId } });
      }
      dispatchSession({ type: "REMOVE_ACTIVE_RUNTIME", runId, turnId: promptTurnId });
      return true;
    }

    if (uiState.kind === "SHELL_RUNNING") {
      dispatchSession({ type: "UI_ACTION", action: { type: "SHELL_FINISHED", shellId: runId } });
    } else if (promptTurnId !== null) {
      dispatchSession({ type: "UI_ACTION", action: { type: "RUN_CANCELED", turnId: promptTurnId } });
    }

    return true;
  }, [activeEvents, dispatchSession, finalizePromptRun, focusManager, uiState.kind]);

  const handleCancel = useCallback(() => {
    if (busy) {
      cancelActiveRun(true);
      return;
    }
    if (planFlow.kind === "collecting_feedback") {
      setPlanFlow((current) => cancelPlanFeedback(current));
      return;
    }
    if (planFlow.kind === "awaiting_action") {
      setPlanFlow(resetPlanFlow());
      appendSystemEvent("Plan review", "Plan review canceled. No changes were made.");
      return;
    }
    if (uiState.kind === "AWAITING_USER_ACTION" || uiState.kind === "ERROR") {
      dispatchSession({ type: "UI_ACTION", action: { type: "DISMISS_TRANSIENT" } });
      resetComposer();
    }
  }, [appendSystemEvent, busy, cancelActiveRun, dispatchSession, planFlow.kind, resetComposer, uiState.kind]);

  const handleQuit = useCallback(() => {
    saveActiveConversation();
    cancelActiveRun(false);
    exit();
  }, [cancelActiveRun, exit, saveActiveConversation]);

  const handleCopy = useCallback(async () => {
    // Build a full conversation transcript from all user prompts and assistant
    // responses in staticEvents, paired by turnId and sorted chronologically.
    type TurnPair = { createdAt: number; prompt: string; response: string | null };
    const turns = new Map<number, TurnPair>();

    for (const event of staticEvents) {
      if (event.type === "user") {
        const existing = turns.get(event.turnId);
        if (!existing) {
          turns.set(event.turnId, { createdAt: event.createdAt, prompt: event.prompt, response: null });
        }
      } else if (event.type === "assistant") {
        const existing = turns.get(event.turnId);
        if (existing) {
          existing.response = event.content;
        }
      }
    }

    if (turns.size === 0) {
      // After /clear, the conversation is empty and that's expected.
      // Don't show "Copy unavailable" error - maintain clean post-clear state.
      // Only show this error if the user tries to copy on a fresh session, not post-clear.
      return;
    }

    // Sort turns by creation time and format as a readable dialogue.
    const lines: string[] = [];
    const sorted = [...turns.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const turn of sorted) {
      lines.push(`You: ${turn.prompt.trim()}`);
      if (turn.response?.trim()) {
        lines.push("");
        lines.push(`Codexa: ${turn.response.trim()}`);
      }
      lines.push("");
    }
    const transcript = lines.join("\n").trimEnd();

    const ok = await copyToClipboard(transcript);
    const turnWord = turns.size === 1 ? "1 turn" : `${turns.size} turns`;
    appendSystemEvent(
      "Clipboard",
      ok
        ? `Copied full conversation (${turnWord}) to clipboard.`
        : "Clipboard unavailable.",
    );
  }, [appendSystemEvent, staticEvents]);

  const savePlanFile = useCallback((planContent: string): string | null => {
    const filePath = savePlan(planContent, workspaceRoot);
    if (!filePath) {
      appendErrorEvent(
        "Plan file unavailable",
        "The generated plan could not be saved.",
      );
    }
    return filePath;
  }, [appendErrorEvent, workspaceRoot]);

  const handleViewPlanFile = useCallback((planFilePath: string | null) => {
    if (!planFilePath) {
      appendErrorEvent("Plan file unavailable", "There is no saved plan file to view for this review.");
      return;
    }

    const contents = readPlan(planFilePath);
    if (contents === null) {
      appendErrorEvent("Plan file unavailable", `The saved plan file is no longer available: ${planFilePath}`);
      return;
    }

    const sanitized = normalizePlanReviewMarkdown(contents, workspaceRoot);
    appendSystemEvent("Plan file", [`Path: ${planFilePath}`, "", sanitized].join("\n"));
  }, [appendErrorEvent, appendSystemEvent, workspaceRoot]);

  // ─── Stable composer-input callbacks ──────────────────────────────────────────
  // These use refs so the function identity never changes, avoiding
  // unnecessary downstream work even though the memo comparator on
  // MemoizedBottomComposer already skips callback checks.
  const handleChangeInput = useCallback((value: string, nextCursor: number) => {
    const safeValue = sanitizeTerminalInput(value);
    dispatchSession({ type: "SET_INPUT", value: safeValue, cursor: Math.min(nextCursor, safeValue.length) });
  }, [dispatchSession]);

  const handleRegisterPaste = useCallback((label: string, content: string) => {
    const current = pastedContentRegistryRef.current.get(label) ?? [];
    pastedContentRegistryRef.current.set(label, [...current, content]);
  }, []);

  const handleChangeValue = useCallback((value: string) => {
    const safeValue = sanitizeTerminalInput(value);
    dispatchSession({ type: "SET_INPUT", value: safeValue, cursor: Math.min(cursorRef.current, safeValue.length) });
  }, [dispatchSession]);

  const handleChangeCursor = useCallback((nextCursor: number) => {
    const safeValue = sanitizeTerminalInput(inputValueRef.current);
    dispatchSession({ type: "SET_INPUT", value: safeValue, cursor: Math.min(nextCursor, safeValue.length) });
  }, [dispatchSession]);

  const handleClear = useCallback(() => {
    const clearGeneration = sessionState.clearEpoch + 1;
    const clearBoundaryArmed = clearFrameBoundaryController?.beginClearGeneration(clearGeneration) ?? false;
    renderDebug.traceEvent("terminal", "clearCommandReceived", {
      clearGeneration,
      clearPending: clearBoundaryArmed,
      liveInkInstanceResolved: Boolean(inkInstance),
    });
    cancelActiveRun(false);
    saveActiveConversation();
    void closeLocalHarnessSession(activeConversationRef.current?.metadata.localHarnessSession?.sessionId);
    activeConversationRef.current = null;
    setConversationRouteOverride(null);
    activeTurnIdRef.current = null;
    activeRunLifecycleRef.current = null;
    activeRunTimingRef.current = null;
    resetMistralVibeSession(workspaceRoot);
    setPlanFlow(resetPlanFlow());
    // Row caches are keyed by transcript item keys; drop them with the transcript.
    resetTimelineMeasureCaches();
    renderDebug.traceEvent("terminal", "clearReactStateRequested", {
      clearGeneration,
      clearPending: clearBoundaryArmed,
    });
    resetToHomeScreen(createStartupStaticEvents({
      providerWorkspaceConfig,
    }));
    if (!clearBoundaryArmed) {
      // Fallback path (unexpected Ink mismatch): preserve /clear semantics.
      terminalControl.clearTranscript("src/app.tsx:handleClear:fallback");
      resetInkOutputForFreshFrame({ instance: inkInstance, columns: stdout.columns });
      renderDebug.traceEvent("terminal", "clearBoundaryFallback", {
        clearGeneration,
        liveInkInstanceResolved: Boolean(inkInstance),
      });
    }
  }, [cancelActiveRun, clearFrameBoundaryController, inkInstance, launchContext, providerWorkspaceConfig, resetToHomeScreen, saveActiveConversation, sessionState.clearEpoch, stdout.columns, terminalControl, workspaceRoot]);

  const handleShellExecute = useCallback((command: string) => {
    const safeCommand = sanitizeTerminalInput(command).trim();
    const guardMessage = getShellWorkspaceGuardMessage(safeCommand, workspaceRoot, allowedWritableRoots);
    if (guardMessage) {
      appendErrorEvent("Shell command blocked", guardMessage);
      return;
    }

    const shellId = createEventId();
    const startTime = Date.now();

    const initialEvent: ShellEvent = {
      id: shellId,
      createdAt: startTime,
      type: "shell",
      command: safeCommand,
      lines: [],
      stderrLines: [],
      summary: `Executing shell: ${safeCommand}`,
      status: "running",
      exitCode: null,
      durationMs: null,
    };

    dispatchSession({ type: "SET_ACTIVE_EVENTS", events: [initialEvent] });
    activeRunLifecycleRef.current = null;
    activeRunTimingRef.current = null;
    activeRunIdRef.current = shellId;
    activeTurnIdRef.current = null;
    dispatchSession({ type: "UI_ACTION", action: { type: "SHELL_STARTED", shellId } });

    let pendingStdout: string[] = [];
    let pendingStderr: string[] = [];
    let shellFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushShellLines = () => {
      if (shellFlushTimer) {
        clearTimeout(shellFlushTimer);
        shellFlushTimer = null;
      }

      const stdoutLines = pendingStdout;
      const stderrLines = pendingStderr;
      pendingStdout = [];
      pendingStderr = [];

      if (stdoutLines.length === 0 && stderrLines.length === 0) {
        return;
      }

      startTransition(() => {
        if (stdoutLines.length > 0) {
          dispatchSession({ type: "UPDATE_SHELL_LINES", shellId, stream: "stdout", lines: stdoutLines });
        }
        if (stderrLines.length > 0) {
          dispatchSession({ type: "UPDATE_SHELL_LINES", shellId, stream: "stderr", lines: stderrLines });
        }
      });
    };

    const scheduleShellFlush = () => {
      if (shellFlushTimer) return;
      shellFlushTimer = setTimeout(() => {
        shellFlushTimer = null;
        flushShellLines();
      }, LIVE_UPDATE_FLUSH_MS);
    };

    const runner = runShellCommand(
      safeCommand,
      { cwd: workspaceRoot },
      {
        onStdout: (text) => {
          const lines = sanitizeTerminalLines(text.split(/\r?\n/));
          if (lines.length > 0) {
            pendingStdout.push(...lines);
            scheduleShellFlush();
          }
        },
        onStderr: (text) => {
          const lines = sanitizeTerminalLines(text.split(/\r?\n/));
          if (lines.length > 0) {
            pendingStderr.push(...lines);
            scheduleShellFlush();
          }
        },
      },
    );

    cleanupRef.current = () => {
      if (shellFlushTimer) {
        clearTimeout(shellFlushTimer);
        shellFlushTimer = null;
      }
      runner.cancel();
    };

    void runner.result.then((result) => {
      if (activeRunIdRef.current !== shellId) return;
      flushShellLines();
      activeRunIdRef.current = null;
      cleanupRef.current = null;
      focusManager.focus(FOCUS_IDS.composer);

      const finalEvent: ShellEvent = {
        ...initialEvent,
        lines: sanitizeTerminalLines(result.stdout.split(/\r?\n/)),
        stderrLines: sanitizeTerminalLines(result.stderr.split(/\r?\n/)),
        summary: sanitizeTerminalOutput(summarizeCommandResult(safeCommand, result)),
        status: result.status === "completed" ? "completed" : "failed",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      };

      dispatchSession({ type: "FINALIZE_SHELL", shellId, finalEvent });
    });
  }, [allowedWritableRoots, appendErrorEvent, dispatchSession, focusManager, workspaceRoot]);

  const handleWorkspaceRelaunch = useCallback((targetPath: string) => {
    const gate = guardWorkspaceRelaunch(busy);
    if (!gate.allowed) {
      appendSystemEvent("Busy", gate.message ?? "Finish the current run before relaunching into another workspace.");
      return;
    }

    const relaunchResult = createWorkspaceRelaunchPlan(targetPath, launchContext);
    if (!relaunchResult.ok) {
      appendErrorEvent("Workspace relaunch failed", relaunchResult.message);
      return;
    }

    try {
      const child = spawn(relaunchResult.plan.executable, relaunchResult.plan.args, {
        cwd: relaunchResult.plan.cwd,
        env: relaunchResult.plan.env,
        stdio: "inherit",
      });

      let launched = false;
      child.once("error", (error) => {
        if (launched) return;
        appendErrorEvent("Workspace relaunch failed", error.message);
      });
      child.once("spawn", () => {
        launched = true;
        exit();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown relaunch failure";
      appendErrorEvent("Workspace relaunch failed", message);
    }
  }, [appendErrorEvent, appendSystemEvent, busy, exit, launchContext]);

  const handleHistoryUp = useCallback(() => {
    dispatchSession({ type: "HISTORY_UP" });
  }, [dispatchSession]);

  const handleHistoryDown = useCallback(() => {
    dispatchSession({ type: "HISTORY_DOWN" });
  }, [dispatchSession]);

  const findUserPromptForTurn = useCallback((turnId: number): UserPromptEvent | null => {
    return findUserPrompt([...staticEvents, ...activeEvents], turnId);
  }, [activeEvents, staticEvents]);

  const startPromptRun = useCallback((
    displayPrompt: string,
    providerPrompt: string,
    lifecycle: PromptRunLifecycle = {},
  ) => {
    const submitTiming = lifecycle.submitTiming ?? createPromptRunTiming();
    const safeDisplayPrompt = sanitizeTerminalInput(displayPrompt).trim();
    const safeProviderPrompt = sanitizeTerminalInput(providerPrompt).trim();
    if (!safeDisplayPrompt || !safeProviderPrompt) {
      appendErrorEvent("Prompt blocked", "The prompt only contained non-printable/control characters after sanitization.");
      return false;
    }

    const requestedRuntime = mergeRuntimeConfig(runtimeConfig, lifecycle.runtimeOverride ?? {});
    const requestedMode = requestedRuntime.mode;
    const executionModeDecision = lifecycle.disableModeAutoUpgrade
      ? { mode: requestedMode, autoUpgraded: false }
      : resolveExecutionMode(requestedMode, safeProviderPrompt);
    const effectiveMode = executionModeDecision.mode;
    const runtimeConfigForTurn = {
      ...requestedRuntime,
      mode: effectiveMode,
      model: activeProviderRoute.modelId,
      reasoningLevel: activeProviderRoute.reasoning ?? requestedRuntime.reasoningLevel,
      ...(providerWorkspaceConfig.providers?.openai?.codexCommandPath
        ? { codexCommandPath: providerWorkspaceConfig.providers.openai.codexCommandPath }
        : {}),
    };
    let runtimeForTurn = resolveRuntimeConfig(runtimeConfigForTurn);
    const fastCleanupRun = isClearlySafeGeneratedCleanupRequest(safeProviderPrompt)
      && effectiveMode !== "suggest"
      && runtimeForTurn.policy.sandboxMode !== "read-only";
    if (fastCleanupRun && ["medium", "high", "xhigh"].includes(runtimeForTurn.reasoningLevel)) {
      runtimeForTurn = resolveRuntimeConfig({
        ...runtimeConfigForTurn,
        reasoningLevel: "low",
      });
    }
    if (executionModeDecision.autoUpgraded) {
      appendSystemEvent(
        "Mode auto-upgraded",
        "This prompt looks like a file-editing request, so the run is using Auto instead of Read-only.",
      );
    }
    if (fastCleanupRun) {
      appendSystemEvent(
        "Fast cleanup path",
        "Using a low-latency cleanup profile: shallow inspection, generated artifacts only, no branch/bootstrap setup.",
      );
    }

    if (!provider.run) {
      appendErrorEvent(
        "Backend unavailable",
        `${provider.label} is a planned provider placeholder. Use Codexa Core for runnable execution in v1.`,
      );
      return false;
    }
    const runProvider = provider.run;

    if (activeProviderRoute.providerId === "openai" && backend === "codex-subprocess") {
      const decision = getRunGateDecision(authStatus.state, {
        warnOnUnknown: authStatus.checkedAt > 0,
      });
      if (!decision.allowRun) {
        appendErrorEvent("Authentication required", decision.blockMessage ?? "Please sign in with `codex login`.");
        return false;
      }
      if (decision.warningMessage) {
        appendSystemEvent("Auth warning", decision.warningMessage);
      }
    }

    const turnId = createTurnId();
    const storedConversation = activeConversationRef.current?.messages ?? [];
    // Local models own request-window compaction so they can create a semantic
    // checkpoint before sliding old messages out. Other providers retain the
    // existing tail-selection behavior.
    const conversationHistory = activeProviderRoute.providerId === "local"
      ? [...storedConversation]
      : selectConversationContext(
        storedConversation,
        activeContextMetadata?.contextLength ? activeContextMetadata.contextLength * 4 : undefined,
      );
    const userEvent: UserPromptEvent = {
      id: createEventId(),
      type: "user",
      createdAt: submitTiming.submitEpochMs,
      prompt: safeDisplayPrompt,
      turnId,
    };
    appendConversationMessage({ role: "user", content: safeDisplayPrompt });
    setConversationChars((count) => count + safeProviderPrompt.length);

    const runId = createEventId();
    // A failed or canceled rollover must not reduce the next response's
    // accounting. Each provider run starts with no response text covered.
    rolloverResponseCharsRef.current = 0;
    perf.startSession(String(runId));
    perf.mark("dispatch_start");
    perf.setMeta("fast_cleanup", fastCleanupRun);
    perf.setMeta("reasoning", runtimeForTurn.reasoningLevel);
    activeRunIdRef.current = runId;
    activeTurnIdRef.current = turnId;
    activeRunLifecycleRef.current = lifecycle;
    activeRunTimingRef.current = { ...submitTiming, runId, turnId };
    if (externalCliStatusRef.current === "idle") {
      dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "starting" });
    }
    dispatchSession({
      type: "SUBMIT_PROMPT_RUN",
      historyValue: lifecycle.commitPrompt ? safeDisplayPrompt : undefined,
      turnId,
      runId,
      events: [
        userEvent,
        {
          ...createRunEvent({
            id: runId,
            backendId: backend,
            backendLabel: provider.label,
            runtime: runtimeForTurn,
            prompt: safeProviderPrompt,
            turnId,
            startedAtMs: submitTiming.submitEpochMs,
            responsePresentation: lifecycle.responsePresentation,
            approvedPlan: lifecycle.approvedPlan,
          }),
          summary: "Codexa is starting...",
        },
      ],
    });

    let streamedAssistantContent = "";
    // Plan runs: text streamed since the last tool call. The reducer demotes
    // pre-tool text to prose (chatLifecycle.demoteActivePlanToResponseSegment),
    // so the plan handed to planFlow must be the same trailing section.
    let planSectionContent = "";
    const planSeenToolIds = new Set<string>();
    let legacyProgressSequence = 0;
    let firstRenderFired = false;
    let finalAnswerVisibleFired = false;
    let blockedCleanupFailureSurfaced = false;

    let preRunSnapshot: ReturnType<typeof captureWorkspaceSnapshot> | null = null;
    let finalWorkspacePollDone = false;
    let activityTracker: ReturnType<typeof createWorkspaceActivityTracker> | null = null;

    const liveScheduler = createLiveRenderScheduler({
      assistantFlushMs: LIVE_UPDATE_FLUSH_MS,
      progressOnlyFlushMs: PROGRESS_ONLY_FLUSH_MS,
      flush: (updates: LiveRenderUpdate[]) => {
        if (!isCurrentRun(activeRunIdRef.current, runId)) {
          return;
        }

        if (!firstRenderFired && updates.some((update) => update.type === "assistant")) {
          firstRenderFired = true;
          perf.mark("first_render");
        }

        dispatchSession({
          type: "RUN_APPLY_LIVE_UPDATES",
          turnId,
          runId,
          updates,
          assistantEventFactory: (chunk) => ({
            id: createEventId(),
            type: "assistant",
            createdAt: Date.now(),
            content: "",
            contentChunks: [chunk],
            turnId,
          }),
        });
      },
    });

    const flushLiveUpdates = (): boolean => {
      perf.inc("flushes");
      return liveScheduler.flushNow();
    };

    const traceLiveRunDiagnostics = (status: "completed" | "failed" | "canceled") => {
      const stats = liveScheduler.getStats();
      const now = performance.now();
      renderDebug.traceEvent("run", "liveBatchSummary", {
        runId,
        turnId,
        status,
        promptSubmitEpochMs: submitTiming.submitEpochMs,
        promptSubmitMonotonicMs: submitTiming.submitMonotonicMs,
        finalRenderMonotonicMs: now,
        elapsedWallMs: Math.max(0, Math.round(now - submitTiming.submitMonotonicMs)),
        providerEventsReceived: stats.providerEvents,
        uiFlushes: stats.flushes,
        averageFlushIntervalMs: stats.averageFlushIntervalMs,
        maxFlushIntervalMs: stats.maxFlushIntervalMs,
      });
    };

    let stopProviderRun: (() => void) | undefined;
    let cancelScheduledProviderStart: (() => void) | null = null;
    let providerStartCancelled = false;

    const startProviderRun = () => {
      if (providerStartCancelled || !isCurrentRun(activeRunIdRef.current, runId)) {
        return;
      }

      // Capture the workspace state after the visible run has had a chance to
      // render, so first-prompt filesystem work cannot block initial progress.
      if ((activeProviderRoute.providerId === "openai" && backend === "codex-subprocess")
        || activeProviderRoute.providerId === "local") {
        preRunSnapshot = captureWorkspaceSnapshot(workspaceRoot);
        activityTracker = createWorkspaceActivityTracker({
          rootDir: workspaceRoot,
          initialSnapshot: preRunSnapshot,
          onActivity: (activity) => {
            if (!isCurrentRun(activeRunIdRef.current, runId)) return;
            liveScheduler.enqueue({ type: "activity", activity });
          },
        });
      }

      perf.mark("provider_run_start");
      stopProviderRun = runProvider(
          safeProviderPrompt,
          {
            runtime: runtimeForTurn,
            workspaceRoot,
            projectInstructions,
            runIntent: lifecycle.runIntent ?? "normal",
            conversationHistory,
            localContextCheckpoint: activeProviderRoute.providerId === "local" || activeProviderRoute.providerId === "codexa-native"
              ? activeConversationRef.current?.metadata.localContextCheckpoint
              : undefined,
          },
          {
        onAssistantDelta: (chunk) => {
          const geminiBoundary = activeProviderRoute.providerId === "google";
          appDiagLog(`onAssistantDelta: provider=${activeProviderRoute.providerId} chunk.length=${chunk?.length ?? 0} isEmpty=${!chunk}`);
          if (geminiBoundary) {
            appDiagLog(`GEMINI_APP_BOUNDARY: onAssistantDelta received=yes nonEmpty=${Boolean(chunk)} runId=${runId} turnId=${turnId}`);
          }
          if (!chunk || !isCurrentRun(activeRunIdRef.current, runId)) {
            if (geminiBoundary) {
              appDiagLog(`GEMINI_APP_BOUNDARY: onAssistantDelta assistantAppendCalled=no reason=${!chunk ? "empty-chunk" : "stale-run"} runId=${runId} turnId=${turnId}`);
            }
            return;
          }
          const t0 = performance.now();
          const safeChunk = sanitizeTerminalOutput(chunk, { preserveTabs: false, tabSize: 2 });
          perf.accumulate("sanitize_ms", performance.now() - t0);
          perf.inc("chunks");
          if (!safeChunk) {
            appDiagLog(`onAssistantDelta: safeChunk empty after sanitize → no content queued to liveScheduler`);
            if (geminiBoundary) {
              appDiagLog(`GEMINI_APP_BOUNDARY: onAssistantDelta assistantAppendCalled=no reason=empty-after-sanitize runId=${runId} turnId=${turnId}`);
            }
            return;
          }
          appDiagLog(`onAssistantDelta: ASSISTANT_APPEND_PATH reached — queuing ${safeChunk.length} chars (liveScheduler→RUN_APPLY_LIVE_UPDATES→assistantEvent in activeEvents→FINALIZE_RUN→staticEvents)`);
          dispatchSession({ type: "SET_EXTERNAL_CLI_STATUS", status: "ready" });
          liveScheduler.enqueue({
            type: lifecycle.responsePresentation === "plan" ? "plan" : "assistant",
            chunk: safeChunk,
          });
          streamedAssistantContent += safeChunk;
          if (lifecycle.responsePresentation === "plan") {
            planSectionContent += safeChunk;
          }
          if (geminiBoundary) {
            appDiagLog(`GEMINI_APP_BOUNDARY: onAssistantDelta assistantAppendCalled=yes queuedLength=${safeChunk.length} totalStreamedLength=${streamedAssistantContent.length} runId=${runId} turnId=${turnId}`);
          }
        },
        onFinalAnswerObserved: (response) => {
          if (!isCurrentRun(activeRunIdRef.current, runId) || finalAnswerVisibleFired) return;
          const flushedLiveUpdates = flushLiveUpdates();
          const markFinalAnswerVisible = () => {
            if (!isCurrentRun(activeRunIdRef.current, runId) || finalAnswerVisibleFired) return;
            finalAnswerVisibleFired = true;
            const safeResponse = sanitizeTerminalOutput(response, { preserveTabs: false, tabSize: 2 });
            dispatchSession({
              type: "RUN_MARK_FINAL_ANSWER_OBSERVED",
              runId,
              turnId,
              // Plan runs keep their text in the plan block; the reducer also
              // guards this, but never offer text that would be synthesized
              // into a duplicate response segment.
              response: lifecycle.responsePresentation !== "plan" && safeResponse.trim() ? safeResponse : undefined,
            });
            perf.mark("final_answer_visible");
          };

          if (flushedLiveUpdates) {
            setTimeout(markFinalAnswerVisible, 0);
          } else {
            markFinalAnswerVisible();
          }
        },
        onToolActivity: (activity) => {
          if (!isCurrentRun(activeRunIdRef.current, runId)) return;
          if (lifecycle.responsePresentation === "plan" && !planSeenToolIds.has(activity.id)) {
            // First sight of a tool: mirrors the reducer's insert-only demotion.
            planSeenToolIds.add(activity.id);
            planSectionContent = "";
          }
          liveScheduler.enqueue({ type: "tool", activity });
          if (activity.status === "running") {
            return;
          }
          if (fastCleanupRun && !blockedCleanupFailureSurfaced) {
            const blockedCleanupFailure = getBlockedCleanupFailure(activity);
            if (blockedCleanupFailure) {
              blockedCleanupFailureSurfaced = true;
              flushLiveUpdates();
              traceLiveRunDiagnostics("failed");
              void finalizePromptRun(runId, turnId, "failed", blockedCleanupFailure);
              return;
            }
          }
        },
        onToolApproval: (request) => new Promise<ToolApprovalDecision>((resolve) => {
          toolApprovalResolverRef.current?.("deny");
          toolApprovalResolverRef.current = resolve;
          setToolApproval(request);
          setScreen("tool-approval");
        }),
        onResponse: (response) => {
          const geminiBoundary = activeProviderRoute.providerId === "google";
          appDiagLog(`onResponse: provider=${activeProviderRoute.providerId} response.length=${response?.length ?? 0}`);
          if (geminiBoundary) {
            appDiagLog(`GEMINI_APP_BOUNDARY: onResponse received=yes nonEmpty=${Boolean(response?.trim())} runId=${runId} turnId=${turnId}`);
          }
          if (!isCurrentRun(activeRunIdRef.current, runId)) {
            if (geminiBoundary) {
              appDiagLog(`GEMINI_APP_BOUNDARY: onResponse finalizeCalled=no reason=stale-run runId=${runId} turnId=${turnId}`);
            }
            return;
          }
          perf.mark("response_cb_start");

          // Force one final synchronous workspace poll before finalizing the run.
          // This closes the race condition where the activity tracker's interval
          // hasn't fired yet and late file changes would be missed.
          if (activityTracker && preRunSnapshot) {
            try {
              perf.mark("snapshot_start");
              const finalSnapshot = captureWorkspaceSnapshot(workspaceRoot);
              perf.mark("snapshot_end");
              const lateActivity = diffWorkspaceSnapshots(preRunSnapshot, finalSnapshot);
              if (lateActivity.length > 0) {
                liveScheduler.enqueue({ type: "activity", activity: lateActivity });
              }
            } catch {
              // Non-fatal: best-effort final poll
            } finally {
              finalWorkspacePollDone = true;
            }
          }

          const flushedLiveUpdates = flushLiveUpdates();
          const finalizeResponse = () => {
            if (!isCurrentRun(activeRunIdRef.current, runId)) return;
            const safeResponse = sanitizeTerminalOutput(response, { preserveTabs: false, tabSize: 2 });
            const newlyVisibleResponseChars = Math.max(0, safeResponse.length - rolloverResponseCharsRef.current);
            rolloverResponseCharsRef.current = 0;
            setConversationChars((count) => count + newlyVisibleResponseChars);

            // Validate response quality for write-intent/destructive prompts:
            // If the backend returned filler like "Hello." instead of execution
            // feedback, inject a warning so the user isn't silently misled.
            if (effectiveMode !== "suggest") {
              const hollow = detectHollowResponse(safeProviderPrompt, safeResponse);
              if (hollow.isHollow) {
                const formatted = formatHollowResponse(hollow, safeResponse);
                traceLiveRunDiagnostics("completed");
                void finalizePromptRun(runId, turnId, "completed", undefined, formatted);
                return;
              }
            }

            // If the streamed content matches the sanitized response (after
            // normalizing whitespace), pass undefined so FINALIZE_RUN preserves
            // the already-rendered streamed content — avoiding a visual flash.
            const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();
            const streamedNorm = normalizeWs(streamedAssistantContent);
            const responseNorm = normalizeWs(safeResponse);
            const finalResponse =
              lifecycle.responsePresentation === "plan"
                // The plan is the section streamed after the last tool call;
                // the backend's full response also contains the pre-tool chatter.
                ? (planSectionContent.trim() ? planSectionContent : safeResponse)
                : streamedNorm && (
                  streamedNorm === responseNorm ||
                  (responseNorm.startsWith(streamedNorm) && streamedNorm.length / responseNorm.length > 0.8)
                )
                  ? undefined
                  : safeResponse;
            appDiagLog(`onResponse.finalizeResponse: safeResponse.length=${safeResponse.length} streamedContent.length=${streamedAssistantContent.length} finalResponse=${finalResponse === undefined ? "undefined(use-streamed)" : `${finalResponse.length}chars`}`);
            if (geminiBoundary) {
              const extractionStatus = safeResponse.trim() || streamedAssistantContent.trim()
                ? "assistant-text"
                : "completed-empty-assistant";
              appDiagLog([
                "GEMINI_APP_BOUNDARY:",
                `onResponse finalizeCalled=yes`,
                `extractionStatus=${extractionStatus}`,
                `safeResponseLength=${safeResponse.length}`,
                `streamedAssistantContentLength=${streamedAssistantContent.length}`,
                `finalResponseProvided=${finalResponse !== undefined}`,
                `finalRunState=completed`,
                `reasonComposerBecomesActive=FINALIZE_RUN_COMPLETED`,
                `runId=${runId}`,
                `turnId=${turnId}`,
              ].join(" "));
            }
            traceLiveRunDiagnostics("completed");
            void finalizePromptRun(runId, turnId, "completed", undefined, finalResponse, safeResponse);
          };

          if (flushedLiveUpdates) {
            setTimeout(finalizeResponse, 0);
          } else {
            finalizeResponse();
          }
        },
        onError: (message, rawOutput) => {
          if (!isCurrentRun(activeRunIdRef.current, runId)) return;
          rolloverResponseCharsRef.current = 0;
          const flushedLiveUpdates = flushLiveUpdates();
          const finalizeError = () => {
            if (!isCurrentRun(activeRunIdRef.current, runId)) return;
            const safeMessage = sanitizeTerminalOutput(message);
            const safeRawOutput = sanitizeTerminalOutput(rawOutput ?? "");
            const combinedOutput = [safeMessage, safeRawOutput].filter(Boolean).join("\n");
            const errorMessage = isLikelyAuthFailure(combinedOutput)
              ? [
                "Codexa reported an authentication/session error.",
                "Recovery:",
                "  codex login",
                "",
                `Raw error: ${safeMessage}`,
              ].join("\n")
              : safeMessage;

            if (isLikelyAuthFailure(combinedOutput)) {
              setRuntimeUnauthenticated("Auth/session failure detected in neural link.");
            }

            traceLiveRunDiagnostics("failed");
            void finalizePromptRun(runId, turnId, "failed", errorMessage);
          };

          if (flushedLiveUpdates) {
            setTimeout(finalizeError, 0);
          } else {
            finalizeError();
          }
        },
        onProgress: (update) => {
          perf.inc("progress_updates");
          const safeText = sanitizeTerminalOutput(update.text);
          if (!safeText) return;
          if (isNoiseLine(safeText)) return;
          if (!isCurrentRun(activeRunIdRef.current, runId)) return;
          const safeUpdate: BackendProgressUpdate = {
            id: update.id?.trim() ? update.id : `legacy-progress-${++legacyProgressSequence}`,
            source: update.source,
            text: safeText,
          };
          liveScheduler.enqueue({ type: "progress", update: safeUpdate });
        },
        onLocalContextCheckpoint: (checkpoint) => {
          const current = activeConversationRef.current;
          if (!current || (activeProviderRoute.providerId !== "local" && activeProviderRoute.providerId !== "codexa-native")) return;
          rolloverResponseCharsRef.current = checkpoint.responseCharsCovered ?? 0;
          if (typeof checkpoint.activeWindowChars === "number") {
            setConversationChars(checkpoint.activeWindowChars);
          }
          const next: ConversationRecord = {
            ...current,
            metadata: { ...current.metadata, localContextCheckpoint: checkpoint },
          };
          activeConversationRef.current = next;
          try {
            conversationStore.save(next);
          } catch (error) {
            appDiagLog(`CONVERSATION_STORE: checkpoint save failed: ${error instanceof Error ? error.message : "filesystem error"}`);
          }
        },
        onLocalHarnessSession: (session) => {
          const current = activeConversationRef.current;
          if (!current || activeProviderRoute.providerId !== "local") return;
          const next: ConversationRecord = {
            ...current,
            metadata: { ...current.metadata, localHarnessSession: session },
          };
          activeConversationRef.current = next;
          try {
            conversationStore.save(next);
          } catch (error) {
            appDiagLog(`CONVERSATION_STORE: Local Harness save failed: ${error instanceof Error ? error.message : "filesystem error"}`);
          }
        },
        onContextUsage: (usage) => {
          if (!isCurrentRun(activeRunIdRef.current, runId)) return;
          setConversationChars(Math.max(0, usage.contextTokens * 4));
        },
      },
      );
    };

    cancelScheduledProviderStart = schedulePromptRunStartAfterVisibleCommit(startProviderRun);

    cleanupRef.current = () => {
      providerStartCancelled = true;
      cancelScheduledProviderStart?.();
      flushLiveUpdates();
      // Do one final sync poll before stopping the tracker to capture
      // any last-moment file changes that were in-flight.
      if (activityTracker && preRunSnapshot && !finalWorkspacePollDone) {
        try {
          const cleanupSnapshot = captureWorkspaceSnapshot(workspaceRoot);
          const lastActivity = diffWorkspaceSnapshots(preRunSnapshot, cleanupSnapshot);
          if (lastActivity.length > 0 && isCurrentRun(activeRunIdRef.current, runId)) {
            dispatchSession({ type: "RUN_APPEND_ACTIVITY", runId, activity: lastActivity });
          }
        } catch {
          // Non-fatal
        }
      }
      activityTracker?.stop();
      stopProviderRun?.();
      liveScheduler.cancel();
    };

    return true;
  }, [
    activeContextMetadata,
    appendConversationMessage,
    appendErrorEvent,
    appendSystemEvent,
    authStatus.state,
    finalizePromptRun,
    mode,
    provider,
    projectInstructions,
    dispatchSession,
    setRuntimeUnauthenticated,
    runtimeConfig,
    workspaceRoot,
  ]);

  const handleImportConfirm = useCallback(async () => {
    if (!pendingImport) return;
    const replacements: Array<{ rawPath: string; replacementPath: string }> = [];
    for (const file of pendingImport.files) {
      try {
        const destPath = await importExternalFile(file.srcPath, pendingImport.attachmentsDir);
        if (destPath) {
          replacements.push({ rawPath: file.rawPath, replacementPath: destPath });
        }
      } catch (err: any) {
        appendErrorEvent("Import failed", `Could not import ${path.basename(file.srcPath)}: ${err.message}`);
      }
    }
    const rewrittenPrompt = rewritePromptWithImportedPaths(pendingImport.providerPrompt, replacements);
    setPendingImport(null);
    setScreen("main");
    startPromptRun(pendingImport.prompt, rewrittenPrompt, { submitTiming: createPromptRunTiming(), commitPrompt: true });
  }, [pendingImport, workspaceRoot, startPromptRun, appendErrorEvent]);

  const handleImportCancel = useCallback(() => {
    if (!pendingImport) return;
    dispatchSession({ type: "SET_INPUT", value: pendingImport.prompt, cursor: pendingImport.prompt.length });
    setPendingImport(null);
    setScreen("main");
  }, [pendingImport, dispatchSession]);

  const runPlanGeneration = useCallback((
    state: Extract<PlanFlowState, { kind: "generating" }>,
    displayPrompt: string,
    submitTiming?: PromptRunTiming,
    commitPrompt = false,
  ) => {
    const started = startPromptRun(
      displayPrompt,
      buildPlanningPrompt({
        task: state.originalPrompt,
        constraints: state.constraints,
        currentPlan: state.currentPlan,
        pendingFeedback: state.pendingFeedback,
      }),
      {
        runtimeOverride: {
          mode: "suggest",
          planMode: false,
        },
        disableModeAutoUpgrade: true,
        parseActionRequired: false,
        responsePresentation: "plan",
        runIntent: "plan",
        submitTiming,
        commitPrompt,
        onCompleted: ({ response }) => {
          const nextPlan = response.trim();
          if (!nextPlan) {
            setPlanFlow(resetPlanFlow());
            appendErrorEvent("Plan generation failed", "Plan mode expected a concrete plan, but the response was empty.");
            return;
          }
          const planFilePath = savePlanFile(nextPlan);
          setPlanFlow((current) => finishPlanGeneration(current, nextPlan, planFilePath));
        },
        onFailed: () => {
          setPlanFlow(resetPlanFlow());
        },
        onCanceled: () => {
          setPlanFlow(resetPlanFlow());
        },
      },
    );

    if (!started) {
      setPlanFlow(resetPlanFlow());
    }

    return started;
  }, [appendErrorEvent, savePlanFile, startPromptRun]);

  const startApprovedPlanExecution = useCallback((state: Extract<PlanFlowState, { kind: "awaiting_action" }>) => {
    const submitTiming = createPromptRunTiming();
    setPlanFlow(approvePlanExecution(state));
    const started = startPromptRun(
      state.originalPrompt,
      buildPlanExecutionPrompt({
        task: state.originalPrompt,
        approvedPlan: state.currentPlan,
        constraints: state.constraints,
      }),
      {
        approvedPlan: state.currentPlan,
        runIntent: "approved-execution",
        submitTiming,
        runtimeOverride: {
          mode: state.executionMode,
          planMode: false,
        },
        onCompleted: () => {
          setPlanFlow(resetPlanFlow());
        },
        onFailed: () => {
          setPlanFlow(resetPlanFlow());
        },
        onCanceled: () => {
          setPlanFlow(resetPlanFlow());
        },
      },
    );

    if (!started) {
      setPlanFlow(state);
      return;
    }

    // Approving the plan ends plan mode for the session, not just for this
    // run: otherwise the footer keeps showing PLAN and the next prompt plans
    // again. The run itself already carries the override above. Not routed
    // through setPlanModeWithNotice, which would reset planFlow mid-run.
    updateRuntimeConfig((current) => ({
      ...current,
      mode: state.executionMode,
      planMode: false,
    }));
    saveRuntimeModePreference(state.executionMode, false);
    appendSystemEvent(
      "Plan mode",
      `Plan approved. Plan mode off · ${formatModeLabel(state.executionMode)}.`,
    );
  }, [appendSystemEvent, startPromptRun, updateRuntimeConfig]);

  const handlePlanAction = useCallback((action: PlanActionValue) => {
    if (planFlow.kind !== "awaiting_action") {
      return;
    }

    switch (action) {
      case "implement":
        startApprovedPlanExecution(planFlow);
        return;
      case "revise":
        setPlanFlow(beginPlanFeedback(planFlow, "revise"));
        return;
      case "cancel":
        setPlanFlow(resetPlanFlow());
        appendSystemEvent("Plan review", "Plan review canceled. No changes were made.");
        return;
      default:
        return;
    }
  }, [appendSystemEvent, planFlow, startApprovedPlanExecution]);

  const handlePlanFeedbackSubmit = useCallback((value: string) => {
    if (planFlow.kind !== "collecting_feedback") {
      return;
    }

    const feedback = sanitizeTerminalInput(value).trim();
    if (!feedback) {
      appendSystemEvent("Plan review", "Add a short revision note or constraint before submitting.");
      return;
    }

    const nextState = submitPlanFeedback(planFlow, feedback);
    if (nextState.kind !== "generating") {
      return;
    }

    setPlanFlow(nextState);
    runPlanGeneration(nextState, feedback, createPromptRunTiming());
  }, [appendSystemEvent, planFlow, runPlanGeneration]);

  useEffect(() => {
    if (initialPromptSubmittedRef.current || busy) {
      return;
    }

    const initialPrompt = sanitizeTerminalInput(launchArgs.initialPrompt ?? "").trim();
    if (!initialPrompt) {
      return;
    }

    initialPromptSubmittedRef.current = true;

    const workspaceGuardMessage = getPromptWorkspaceGuardMessage(initialPrompt, workspaceRoot, allowedWritableRoots);
    if (workspaceGuardMessage) {
      appendErrorEvent("Workspace boundary", workspaceGuardMessage);
      return;
    }

    if (planMode) {
      const nextPlanState = startPlanGeneration(initialPrompt, mode);
      setPlanFlow(nextPlanState);
      runPlanGeneration(nextPlanState, initialPrompt, createPromptRunTiming(), true);
      return;
    }

    startPromptRun(initialPrompt, initialPrompt, { submitTiming: createPromptRunTiming(), commitPrompt: true });
  }, [
    allowedWritableRoots,
    appendErrorEvent,
    busy,
    dispatchSession,
    launchArgs.initialPrompt,
    mode,
    planMode,
    runPlanGeneration,
    startPromptRun,
    workspaceRoot,
  ]);

  const handleSubmit = useCallback(() => {
    const submitTiming = createPromptRunTiming();
    perf.mark("submit");
    const value = sanitizeTerminalInput(inputValue).trim();
    if (!value) return;

    // Special perf debug command (not routed through handleCommand)
    if (value === "/perf") {
      const session = perf.getSession();
      const summary = session
        ? perf.buildSummary(session)
        : "No perf data recorded yet. Set CODEXA_PERF=1 and send a prompt first.";
      appendSystemEvent("Perf report", summary);
      dispatchSession({ type: "PUSH_HISTORY", value });
      resetComposer();
      return;
    }

    // ========== COMMAND ROUTING (before AWAITING_USER_ACTION) ==========
    // Shell execution: ! prefix routes directly to the terminal
    if (value.startsWith("!")) {
      if (busy) return;
      const shellCmd = value.slice(1).trim();
      if (!shellCmd) return;
      dispatchSession({ type: "PUSH_HISTORY", value });
      resetComposer();
      handleShellExecute(shellCmd);
      return;
    }

    // Parse slash commands (/ prefix) and question-prefix invalid commands (? prefix)
    const commandResult = handleCommand(value, {
      config: layeredRuntimeConfig,
      runtime: runtimeConfig,
      resolvedRuntime: resolvedRuntimeConfig,
      settings: {
        workspaceDisplayMode,
        terminalTitleMode,
        showBusyLoader,
      },
      workspace: workspaceCommandContext,
      tokensUsed: estimateTokens(conversationChars),
      modelCapabilities: activeRouteModelCapabilities,
      routeStatusMessage,
      activeRouteProviderLabel: activeRouteProvider?.displayName ?? "OpenAI",
      projectInstructions: projectInstructionsLoad,
    });
    const isCommand = commandResult !== null;

    if (isCommand) {
      // Internal commands should NOT be added to PUSH_HISTORY or sent to provider
      resetComposer();

      switch (commandResult.action) {
        case "exit":
          handleQuit();
          return;
        case "clear":
          handleClear();
          return;
        case "resume":
          openResumePicker();
          return;
        case "backend":
          if (commandResult.value) {
            setBackendWithNotice(commandResult.value as AvailableBackend);
          }
          return;
        case "model":
          if (commandResult.value) {
            setModelWithNotice(commandResult.value as AvailableModel);
          }
          return;
        case "mode":
          if (commandResult.value) {
            setModeWithNotice(commandResult.value as AvailableMode);
          } else if (commandResult.message) {
            appendSystemEvent("Mode", commandResult.message);
          }
          return;
        case "reasoning":
          if (commandResult.value) {
            setReasoningWithNotice(commandResult.value as ReasoningLevel);
          }
          return;
        case "plan_mode":
          if (commandResult.value) {
            setPlanModeWithNotice(commandResult.value === "on");
          } else if (commandResult.message) {
            appendSystemEvent("Plan mode", commandResult.message);
          }
          return;
        case "status":
        case "runtime_writable_roots_list":
          if (commandResult.message) {
            appendSystemEvent("Runtime status", commandResult.message);
          }
          return;
        case "route_status":
          if (commandResult.message) {
            appendSystemEvent("Route status", commandResult.message);
          }
          return;
        case "config_status":
          if (commandResult.message) {
            appendSystemEvent("Config", commandResult.message);
          }
          return;
        case "config_trust_status":
          if (commandResult.message) {
            appendSystemEvent("Config trust", commandResult.message);
          }
          return;
        case "config_trust_set":
          if (commandResult.value) {
            setProjectTrustWithNotice(commandResult.value === "on");
          }
          return;
        case "permissions_status":
          if (commandResult.message) {
            appendSystemEvent("Permissions", commandResult.message);
          }
          return;
        case "runtime_approval_policy":
          if (commandResult.value) {
            setApprovalPolicyWithNotice(commandResult.value as RuntimeApprovalPolicy);
          } else if (commandResult.message) {
            appendSystemEvent("Runtime policy", commandResult.message);
          }
          return;
        case "runtime_sandbox_mode":
          if (commandResult.value) {
            setSandboxModeWithNotice(commandResult.value as RuntimeSandboxMode);
          } else if (commandResult.message) {
            appendSystemEvent("Runtime policy", commandResult.message);
          }
          return;
        case "runtime_network_access":
          if (commandResult.value) {
            setNetworkAccessWithNotice(commandResult.value as RuntimeNetworkAccess);
          } else if (commandResult.message) {
            appendSystemEvent("Runtime policy", commandResult.message);
          }
          return;
        case "runtime_writable_roots_add":
          if (commandResult.value) {
            addWritableRootWithNotice(commandResult.value);
          }
          return;
        case "runtime_writable_roots_remove":
          if (commandResult.value) {
            removeWritableRootWithNotice(commandResult.value);
          }
          return;
        case "runtime_writable_roots_clear":
          clearWritableRootsWithNotice();
          return;
        case "runtime_service_tier":
          if (commandResult.value) {
            setServiceTierWithNotice(commandResult.value as RuntimeServiceTier);
          } else if (commandResult.message) {
            appendSystemEvent("Runtime policy", commandResult.message);
          }
          return;
        case "diagnose_github": {
          const remoteUrl = getLocalGitRemoteUrl();
          const repo = parseRepoIdentity(remoteUrl);
          const ghCli = checkGhCli();
          const localGit = checkLocalGitRemote();
          const localGitWrite = checkLocalGitWrite();

          // MCP connector check: since TUI can't call MCP, we mark it as unknown
          // or rely on the agent to fill this in if it's the one running the command.
          const connector: DiagnosticResult = {
            path: "GitHub connector/MCP",
            status: "FAIL",
            evidence: "TUI cannot directly probe MCP",
            blocker: "Run /diagnose through the agent for a full probe",
            recommendedUse: false,
          };

          const recommendedFlow = classifyDiagnostics(repo, ghCli, localGit, localGitWrite, connector);

          // Instead of console.log, we'll format a message for appendSystemEvent
          const tableLines = [
            "Path                | Status  | Evidence                      | Blocker",
            "--------------------|---------|-------------------------------|---------------------------",
            `${ghCli.path.padEnd(20)}| ${ghCli.status.padEnd(8)}| ${(ghCli.evidence || "").substring(0, 30).padEnd(30)}| ${ghCli.blocker || ""}`,
            `${localGit.path.padEnd(20)}| ${localGit.status.padEnd(8)}| ${(localGit.evidence || "").substring(0, 30).padEnd(30)}| ${localGit.blocker || ""}`,
            `${localGitWrite.path.padEnd(20)}| ${localGitWrite.status.padEnd(8)}| ${(localGitWrite.evidence || "").substring(0, 30).padEnd(30)}| ${localGitWrite.blocker || ""}`,
            `${connector.path.padEnd(20)}| ${connector.status.padEnd(8)}| ${(connector.evidence || "").substring(0, 30).padEnd(30)}| ${connector.blocker || ""}`,
          ];

          const summary = [
            ...tableLines,
            "",
            `Resolved repo: ${repo ? `${repo.owner}/${repo.repo}` : "Unknown"}`,
            `Recommended PR flow: ${recommendedFlow}`,
          ].join("\n");

          appendSystemEvent("GitHub Diagnostics", summary);
          return;
        }
        case "runtime_personality":
          if (commandResult.value) {
            setPersonalityWithNotice(commandResult.value as RuntimePersonality);
          } else if (commandResult.message) {
            appendSystemEvent("Runtime policy", commandResult.message);
          }
          return;
        case "auth":
          if (commandResult.value) {
            setAuthPreferenceWithNotice(commandResult.value as AuthPreference);
          }
          return;
        case "diagnose_providers": {
          const lines: string[] = ["Provider CLI diagnostics:"];
          const diags = providerDiagnosticsRef.current;
          const providerIds = ["openai", "anthropic", "codexa-native", "local", "antigravity"] as const;
          const labels: Record<string, string> = {
            openai: "OpenAI/Codex",
            anthropic: "Anthropic/Claude",
            local: "Local OpenAI-compatible",
            "codexa-native": "Codexa Native",
            antigravity: "Antigravity CLI",
          };
          for (const id of providerIds) {
            const diag = diags[id];
            lines.push(`\n  ${labels[id] ?? id}:`);
            if (!diag) {
              lines.push("    No diagnostic data (provider not yet validated).");
              continue;
            }
            const fields: Array<[string, string]> = [
              ["resolvedCommand", "Resolved command"],
              ["executablePath", "Executable path"],
              ["loggedIn", "Logged in"],
              ["authMethod", "Auth method"],
              ["subscriptionType", "Subscription"],
              ["apiProvider", "API provider"],
              ["modelSource", "Model source"],
            ];
            for (const [key, label] of fields) {
              if (diag[key] != null) lines.push(`    ${label}: ${diag[key]}`);
            }
          }
          appendSystemEvent("Provider diagnostics", lines.join("\n"));
          return;
        }
        case "setting_status":
          if (commandResult.message) {
            appendSystemEvent("Settings", commandResult.message);
          }
          return;
        case "setting_workspace_display":
          if (commandResult.value) {
            setWorkspaceDisplayModeWithNotice(commandResult.value as WorkspaceDisplayMode);
          } else if (commandResult.message) {
            appendSystemEvent("Settings", commandResult.message);
          }
          return;
        case "setting_terminal_title":
          if (commandResult.value) {
            setTerminalTitleModeWithNotice(commandResult.value as TerminalTitleMode);
          } else if (commandResult.message) {
            appendSystemEvent("Settings", commandResult.message);
          }
          return;
        case "setting_busy_loader":
          if (commandResult.value) {
            const nextShowBusyLoader = commandResult.value === "true";
            setShowBusyLoader(nextShowBusyLoader);
            appendSystemEvent("Settings", `Busy loader ${nextShowBusyLoader ? "enabled" : "disabled"}.`);
          } else if (commandResult.message) {
            appendSystemEvent("Settings", commandResult.message);
          }
          return;
        case "theme":
          if (commandResult.value) {
            repaintCommittedTheme(commandResult.value);
          }
          return;
        case "themes":
          if (commandResult.message) {
            appendSystemEvent("Themes", commandResult.message);
          }
          return;
        case "login":
          appendSystemEvent("Login guidance", getLoginGuidance());
          return;
        case "logout":
          appendSystemEvent("Logout guidance", getLogoutGuidance());
          return;
        case "auth_status":
          void refreshAuthStatus(true);
          return;
        case "open_backend_picker":
          openBackendPicker();
          return;
        case "open_provider_picker":
          openProviderPicker();
          return;
        case "open_model_picker":
          openModelPicker();
          return;
        case "open_mode_picker":
          openModePicker();
          return;
        case "open_reasoning_picker":
          openReasoningPicker();
          return;
        case "open_settings_panel":
          openSettingsPanel();
          return;
        case "open_theme_picker":
          openThemePicker();
          return;
        case "open_permissions_panel":
          openPermissionsPanel();
          return;
        case "open_auth_panel":
          openAuthPanel();
          return;
        case "verbose_toggle": {
          if (commandResult.message) {
            appendSystemEvent("Debug", commandResult.message);
            return;
          }
          setVerboseMode((current) => !current);
          appendSystemEvent(
            "Verbose mode",
            verboseMode
              ? "Verbose mode disabled — showing concise output."
              : "Verbose mode enabled — showing detailed processing info.",
          );
          return;
        }
        case "copy":
          void handleCopy();
          return;
        case "workspace_relaunch":
          if (commandResult.value) {
            handleWorkspaceRelaunch(commandResult.value);
          }
          return;
        case "workspace":
        case "backends":
          if (commandResult.message) {
            appendSystemEvent("Command", commandResult.message);
          }
          return;
        case "models":
          if (!modelCapabilities) {
            void refreshModelCapabilities(false, true);
          }
          if (commandResult.message) {
            appendSystemEvent("Command", commandResult.message);
          }
          return;
        case "update": {
          const arg = commandResult.value ?? "status";
          if (isLocalDevChannel() && arg !== "check") {
            appendSystemEvent("Update", formatLocalDevUpdateStatus());
            return;
          }
          void (async () => {
            let freshResult = updateCheckResult;
            if (arg === "check" || freshResult === null) {
              try {
                freshResult = await checkForUpdates({ enabled: true });
                setUpdateCheckResult(freshResult);
                if (freshResult.status !== "error") {
                  saveUpdateCheckCache({
                    lastChecked: freshResult.checkedAt,
                    currentVersion: freshResult.currentVersion,
                    latestVersion: freshResult.latestVersion,
                    updateAvailable: freshResult.status === "update-available",
                  });
                }
              } catch {
                freshResult = null;
              }
            }
            if (freshResult?.status === "update-available" && freshResult.latestVersion) {
              setScreen("update-prompt");
            } else {
              appendSystemEvent(
                "Update",
                formatUpdateInstructions(freshResult, getUpdateCommand(globalPackageManager).displayCommand),
              );
            }
          })();
          return;
        }
        case "help":
        case "unknown":
          if (commandResult.message) {
            appendSystemEvent("Command", commandResult.message);
          }
          return;
        default:
          if (commandResult.message) {
            appendSystemEvent("Command", commandResult.message);
          }
          return;
      }
    }

    // ========== NORMAL PROMPT SUBMISSION (after command routing) ==========
    const providerValue = expandPastedContent(value, pastedContentRegistryRef.current);
    // Check for follow-up answer submission
    if (uiState.kind === "AWAITING_USER_ACTION") {
      const originalUserEvent = findUserPromptForTurn(uiState.turnId);
      if (!originalUserEvent) {
        appendErrorEvent("Follow-up unavailable", "The original turn could not be found, so the answer could not be resumed.");
        dispatchSession({ type: "UI_ACTION", action: { type: "DISMISS_TRANSIENT" } });
        return;
      }

      if (busy) return;
      startPromptRun(value, buildFollowUpPrompt({
        originalPrompt: originalUserEvent.prompt,
        assistantQuestion: uiState.question,
        userAnswer: providerValue,
      }), { submitTiming, commitPrompt: true });
      return;
    }

    // Check if app is busy for normal prompts
    if (!isCommand && busy) {
      return;
    }

    // Validate workspace access for normal prompts
    const { violations: outsideViolations, skippedExternalPaths } = findOutsideWorkspacePaths(providerValue, workspaceRoot, allowedWritableRoots);

    if (skippedExternalPaths.length > 0) {
      for (const skipped of skippedExternalPaths) {
        appendSystemEvent("Dependency skipped", `Skipped external dependency source: ${formatSkippedDependencyPath(skipped)}`);
      }
    }

    if (outsideViolations.length > 0) {
      if (runtimeConfig.policy.allowExternalFileImport) {
        const attachmentsDir = resolveCodexaAttachmentDir(workspaceRoot, runtimeConfig.policy.attachmentDir);
        const importFiles: PendingImportFile[] = outsideViolations.map((v) => ({
          srcPath: v.normalizedPath,
          rawPath: v.rawPath,
          destFilename: path.basename(v.normalizedPath),
          isImage: isImageFile(v.normalizedPath),
        }));
        setPendingImport({ prompt: value, providerPrompt: providerValue, files: importFiles, attachmentsDir });
        setScreen("import-confirmation");
        return;
      }
      const workspaceGuardMessage = getPromptWorkspaceGuardMessage(providerValue, workspaceRoot, allowedWritableRoots);
      if (workspaceGuardMessage) {
        appendErrorEvent("Workspace boundary", workspaceGuardMessage);
        return;
      }
    }

    // Submit to provider or plan mode
    if (planMode) {
      const nextPlanState = startPlanGeneration(providerValue, mode);
      setPlanFlow(nextPlanState);
      runPlanGeneration(nextPlanState, value, submitTiming, true);
      return;
    }
    startPromptRun(value, providerValue, { submitTiming, commitPrompt: true });
  }, [
    allowedWritableRoots,
    appendErrorEvent,
    appendSystemEvent,
    busy,
    buildFollowUpPrompt,
    conversationChars,
    dispatchSession,
    findUserPromptForTurn,
    focusManager,
    globalPackageManager,
    handleCopy,
    handleClear,
    handleQuit,
    handleShellExecute,
    handlePlanFeedbackSubmit,
    handleWorkspaceRelaunch,
    inputValue,
    layeredRuntimeConfig,
    modelCapabilities,
    mode,
    openAuthPanel,
    openBackendPicker,
    openProviderPicker,
    openModePicker,
    openModelPicker,
    openPermissionsPanel,
    openResumePicker,
    openReasoningPicker,
    openSettingsPanel,
    planMode,
    refreshAuthStatus,
    repaintCommittedTheme,
    resetComposer,
    resolvedRuntimeConfig,
    runPlanGeneration,
    runtimeConfig,
    addWritableRootWithNotice,
    clearWritableRootsWithNotice,
    removeWritableRootWithNotice,
    setApprovalPolicyWithNotice,
    setAuthPreferenceWithNotice,
    setBackendWithNotice,
    setNetworkAccessWithNotice,
    setModeWithNotice,
    setModelWithNotice,
    setPlanModeWithNotice,
    togglePlanModeWithNotice,
    setPersonalityWithNotice,
    setProjectTrustWithNotice,
    setReasoningWithNotice,
    setSandboxModeWithNotice,
    setServiceTierWithNotice,
    showBusyLoader,
    startPromptRun,
    themeSelection.committedTheme,
    uiState,
    workspaceCommandContext,
    workspaceDisplayMode,
    workspaceRoot,
  ]);

  const modelDisplayName = activeRuntimeDisplay.modelDisplay;
  const composerReasoningLevel = "";
  const headerRuntimeSummary = useMemo(
    () => runtimeDisplayToSummary(activeRuntimeDisplay, runtimeSummary),
    [activeRuntimeDisplay, runtimeSummary],
  );
  const effectiveHeaderConfig = useMemo<HeaderConfig>(() => ({
    ...headerConfig,
    showProvider: true,
    showModel: false,
    showReasoning: false,
    showContext: false,
  }), [headerConfig]);

  // Memoize the composer element so AppShell's memo check (prev.composer ===
  // next.composer) passes during streaming. Without this, a new JSX element is
  // created on every App render, forcing the entire AppShell tree (header +
  // timeline + footer) to re-render on every 25ms streaming flush.
  const composerElement = useMemo(() => {
    if (planFlow.kind === "awaiting_action") {
      if (!hasVisibleTranscriptPlan) {
        return (
          <Text color={activeTheme.textMuted}>
            Plan could not be displayed. Please ask Codexa to regenerate the plan.
          </Text>
        );
      }
      return (
        <PlanActionPicker
          cols={terminalLayout.cols}
          onSelect={handlePlanAction}
          onCancel={handleCancel}
        />
      );
    }
    if (planFlow.kind === "collecting_feedback") {
      return (
        <TextEntryPanel
          focusId={FOCUS_IDS.composer}
          title="Update plan"
          subtitle="Describe what should change. Enter regenerates the plan."
          inputLabel="Update"
          placeholder={planFlow.mode === "revise"
            ? "e.g. keep it to one file and add tests"
            : "e.g. keep it minimal and avoid touching other files"}
          footerHint="Esc to close · Enter to confirm"
          initialValue={initialRevisionText}
          onSubmit={(value) => {
            setInitialRevisionText("");
            handlePlanFeedbackSubmit(value);
          }}
          onCancel={() => setPlanFlow((current) => cancelPlanFeedback(current))}
        />
      );
    }
    return (
      <MemoizedBottomComposer
        key={composerInstanceKey}
        layout={terminalLayout}
        uiState={uiState}
        mode={mode}
        model={modelDisplayName}
        footerModelDisplay={activeRuntimeDisplay.footerModelDisplay}
        themeName={activeThemeName}
        reasoningLevel={composerReasoningLevel}
        contextDisplay={activeRuntimeDisplay.contextDisplay}
        planMode={planMode}
        showBusyLoader={showBusyLoader}
        tokensUsed={estimateTokens(conversationChars)}
        modelSpec={currentModelSpec}
        value={inputValue}
        cursor={cursor}
        onChangeInput={handleChangeInput}
        onRegisterPaste={handleRegisterPaste}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        onChangeValue={handleChangeValue}
        onChangeCursor={handleChangeCursor}
        onHistoryUp={handleHistoryUp}
        onHistoryDown={handleHistoryDown}
        onOpenBackendPicker={openBackendPicker}
        onOpenProviderPicker={openProviderPicker}
        onOpenModelPicker={openModelPicker}
        onOpenModePicker={openModePicker}
        onOpenThemePicker={openThemePicker}
        onOpenAuthPanel={openAuthPanel}
        onTogglePlanMode={togglePlanModeWithNotice}
        onClear={handleClear}
        onCycleMode={cycleModeWithNotice}
        onQuit={handleQuit}
        activeProviderId={activeProviderRoute.providerId}
        externalCliStatus={sessionState.externalCliStatus}
      />
    );
  }, [
    planFlow,
    initialRevisionText,
    handlePlanAction,
    handleCancel,
    handlePlanFeedbackSubmit,
    hasVisibleTranscriptPlan,
    activeTheme.textMuted,
    composerInstanceKey,
    terminalLayout,
    uiState,
    mode,
    modelDisplayName,
    activeRuntimeDisplay.footerModelDisplay,
    activeRuntimeDisplay.contextDisplay,
    activeThemeName,
    composerReasoningLevel,
    planMode,
    showBusyLoader,
    conversationChars,
    currentModelSpec,
    inputValue,
    cursor,
    handleChangeInput,
    handleRegisterPaste,
    handleSubmit,
    handleChangeValue,
    handleChangeCursor,
    handleHistoryUp,
    handleHistoryDown,
    openBackendPicker,
    openProviderPicker,
    openModelPicker,
    openModePicker,
    openThemePicker,
    openAuthPanel,
    togglePlanModeWithNotice,
    handleClear,
    cycleModeWithNotice,
    handleQuit,
    activeProviderRoute.providerId,
    sessionState.externalCliStatus,
  ]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <ThemeProvider theme={activeThemeName} customTheme={customTheme}>
      {shouldMountTranscript && (
        <TranscriptShell
          layout={terminalLayout}
          authState={authStatus.state}
          workspaceLabel={workspaceLabel}
          workspaceRoot={workspaceRoot}
          runtimeSummary={headerRuntimeSummary}
          staticEvents={staticEvents}
          activeEvents={activeEvents}
          uiState={uiState}
          verboseMode={verboseMode}
          clearCount={sessionState.clearCount}
          repaintGeneration={staticRepaintGeneration}
          notice={themeNotice}
          composer={composerElement}
          composerRows={composerRows}
          visible={screen === "main"}
        />
      )}

      {screen !== "main" && (
        <AppShell
          layout={terminalLayout}
          screen={screen}
          authState={authStatus.state}
          workspaceLabel={workspaceLabel}
          workspaceRoot={workspaceRoot}
          runtimeSummary={headerRuntimeSummary}
          staticEvents={staticEvents}
          activeEvents={activeEvents}
          uiState={uiState}
          verboseMode={verboseMode}
          clearCount={sessionState.clearCount}
          headerConfig={effectiveHeaderConfig}
          updateAvailable={
            screen !== "update-prompt" && updateCheckResult?.status === "update-available" && updateCheckResult.latestVersion
              ? {
                latestVersion: updateCheckResult.latestVersion,
                currentVersion: updateCheckResult.currentVersion,
                updateCommand: getUpdateCommand(globalPackageManager).displayCommand,
              }
              : null
          }
          panel={
            <>
              {screen === "backend-picker" && (
                <BackendPicker
                  currentBackend={backend}
                  onSelect={(value) => setBackendWithNotice(value as AvailableBackend)}
                  onCancel={() => setScreen("main")}
                />
              )}

              {screen === "resume-picker" && (
                <ResumePicker
                  conversations={resumeConversations}
                  onSelect={resumeConversation}
                  onCancel={() => setScreen("main")}
                />
              )}

              {screen === "provider-setup" && providerSetup && (
                <ProviderSetupPrompt
                  providerLabel={findProvider(providerRegistry, providerSetup)?.displayName ?? providerSetup}
                  executable={findProvider(providerRegistry, providerSetup)?.launchCommand?.executable ?? providerSetup}
                  installCommand={getProviderSetupPlan(providerSetup, process.platform === "win32").installCommand}
                  setupCommand={getProviderSetupPlan(providerSetup, process.platform === "win32").setupCommand}
                  onInstall={() => runProviderSetup(providerSetup)}
                  onCancel={() => {
                    setProviderSetup(null);
                    setScreen("provider-picker");
                  }}
                />
              )}

            {screen === "provider-picker" && (
              <ProviderPicker
                layout={terminalLayout}
                providers={providerRegistry}
                onAction={handleProviderAction}
                activeLocalBackend={providerWorkspaceConfig.activeRoute?.providerId === "local"
                  ? providerWorkspaceConfig.activeRoute.localBackend ?? "lm-studio"
                  : providerWorkspaceConfig.providers?.local?.localBackend ?? "lm-studio"}
                localBackendStatuses={localBackendStatuses}
                onLocalBackendsOpen={probeLocalBackends}
                onCancel={() => {
                  modelPickerOpenRef.current = false;
                  setPendingRouteProviderId(null);
                  setScreen("main");
                }}
                initialProviderId={pendingRouteProviderId ?? undefined}
              />
            )}

            {screen === "model-picker" && (
              <ModelPickerScreen
                layout={terminalLayout}
                models={modelPickerModels}
                currentModel={modelPickerCurrentModel}
                currentReasoning={modelPickerCurrentReasoning}
                activeProviderLabel={modelPickerProviderLabel}
                isLoading={modelPickerModels.length === 0
                  && ((modelPickerProviderId === "openai" && modelCapabilitiesBusy)
                    || providerModelLoading[modelPickerProviderId]
                    || routeSwitchBusy)}
                emptyMessage={modelPickerEmptyMessage}
                onSelect={(m, r, geminiSelection) => {
                  modelPickerOpenRef.current = false;
                  if (pendingRouteProviderId && pendingRouteProviderId !== activeProviderRoute.providerId) {
                    // Non-active provider: save as provider default without switching the active route.
                    // User must click "Use in Codexa" to validate and activate.
                    persistProviderDefaultModelAndReasoning(pendingRouteProviderId, m, r);
                    appendSystemEvent(
                      "Provider model saved",
                      `${modelPickerProviderLabel} default model set to ${m} with reasoning ${formatReasoningLabel(r)}. Choose "Use in Codexa" to activate this provider.`,
                    );
                    setScreen("provider-picker");
                  } else {
                    void setModelAndReasoningWithNotice(m as AvailableModel, r as ReasoningLevel, modelPickerProviderId, geminiSelection);
                  }
                }}
                onCancel={() => {
                  modelPickerOpenRef.current = false;
                  setPendingRouteProviderId(null);
                  returnToChatMode();
                }}
              />
            )}

            {screen === "mode-picker" && (
              <ModePicker
                currentMode={mode}
                planMode={planMode}
                onSelect={(value) => {
                  if (value === "plan") {
                    setPlanModeWithNotice(true);
                    setScreen("main");
                  }
                  else setModeWithNotice(value as AvailableMode);
                }}
                onCancel={() => setScreen("main")}
              />
            )}

            {screen === "reasoning-picker" && (
              <ReasoningPicker
                currentModel={activeProviderRoute.modelId}
                currentReasoning={activeProviderRoute.reasoning ?? reasoningLevel}
                reasoningLevels={currentReasoningCapabilities}
                defaultReasoning={currentModelCapability?.defaultReasoningLevel ?? null}
                sourceLabel={currentReasoningSourceLabel}
                onSelect={(value) => setReasoningWithNotice(value as ReasoningLevel)}
                onCancel={() => setScreen("main")}
              />
            )}

            {screen === "auth-panel" && (
              <AuthPanel
                focusId={FOCUS_IDS.authPanel}
                provider={provider}
                authPreference={authPreference}
                authStatus={authStatus}
                authStatusBusy={authStatusBusy}
                onSetPreference={(value) => setAuthPreferenceWithNotice(value as AuthPreference)}
                onRefreshAuthStatus={() => {
                  void refreshAuthStatus(false);
                }}
                onClose={() => setScreen("main")}
              />
            )}

            {screen === "permissions-panel" && (
              <PermissionsPanel
                runtime={runtimeConfig}
                resolvedRuntime={resolvedRuntimeConfig}
                onSelect={handlePermissionsPanelAction}
                onCancel={() => setScreen("main")}
              />
            )}

            {screen === "permissions-approval-picker" && (
              <SelectionPanel
                focusId={FOCUS_IDS.permissionsApprovalPicker}
                title="Approval Policy"
                subtitle="Choose how Codexa should handle approval prompts."
                items={AVAILABLE_APPROVAL_POLICIES.map((item) => ({
                  label: item.id === runtimeConfig.policy.approvalPolicy
                    ? `${item.label}  ✓`
                    : item.label,
                  value: item.id,
                }))}
                onSelect={(value) => {
                  setApprovalPolicyWithNotice(value as RuntimeApprovalPolicy);
                  setScreen("permissions-panel");
                }}
                onCancel={() => setScreen("permissions-panel")}
              />
            )}

            {screen === "permissions-sandbox-picker" && (
              <SelectionPanel
                focusId={FOCUS_IDS.permissionsSandboxPicker}
                title="Sandbox Mode"
                subtitle="Choose the effective filesystem sandbox for future runs."
                items={AVAILABLE_SANDBOX_MODES.map((item) => ({
                  label: item.id === runtimeConfig.policy.sandboxMode
                    ? `${item.label}  ✓`
                    : item.label,
                  value: item.id,
                }))}
                onSelect={(value) => {
                  setSandboxModeWithNotice(value as RuntimeSandboxMode);
                  setScreen("permissions-panel");
                }}
                onCancel={() => setScreen("permissions-panel")}
              />
            )}

            {screen === "permissions-network-picker" && (
              <SelectionPanel
                focusId={FOCUS_IDS.permissionsNetworkPicker}
                title="Network Access"
                subtitle="Choose whether network access is enabled for future runs."
                items={AVAILABLE_NETWORK_ACCESS_VALUES.map((item) => ({
                  label: item.id === runtimeConfig.policy.networkAccess
                    ? `${item.label}  ✓`
                    : item.label,
                  value: item.id,
                }))}
                onSelect={(value) => {
                  setNetworkAccessWithNotice(value as RuntimeNetworkAccess);
                  setScreen("permissions-panel");
                }}
                onCancel={() => setScreen("permissions-panel")}
              />
            )}

            {screen === "permissions-add-writable-root" && (
              <TextEntryPanel
                focusId={FOCUS_IDS.permissionsAddWritableRoot}
                title="Add Writable Root"
                subtitle="Enter an absolute path or a path relative to the locked workspace."
                placeholder="relative\\or\\absolute\\path"
                inputLabel="Path"
                footerHint="Esc to close · Enter to confirm"
                onSubmit={(value) => {
                  if (!value.trim()) {
                    appendSystemEvent("Runtime policy", "Writable root path cannot be empty.");
                    return;
                  }
                  addWritableRootWithNotice(value);
                  setScreen("permissions-panel");
                }}
                onCancel={() => setScreen("permissions-panel")}
              />
            )}

            {screen === "permissions-remove-writable-root" && (
              <SelectionPanel
                focusId={FOCUS_IDS.permissionsRemoveWritableRoot}
                title="Remove Writable Root"
                subtitle="Select a configured writable root to remove."
                items={runtimeConfig.policy.writableRoots.map((root) => ({
                  label: root,
                  value: root,
                }))}
                onSelect={(value) => {
                  removeWritableRootWithNotice(value);
                  setScreen("permissions-panel");
                }}
                onCancel={() => setScreen("permissions-panel")}
              />
            )}

            {screen === "theme-picker" && (
              <ThemePicker
                currentTheme={themeSelection.committedTheme}
                onSelect={(value) => {
                  if (themePreviewTimerRef.current) {
                    clearTimeout(themePreviewTimerRef.current);
                    themePreviewTimerRef.current = null;
                  }
                  repaintCommittedTheme(value);
                  setScreen("main");
                  if (value === "custom") {
                    if (!customTheme) {
                      setCustomTheme({ ...THEMES.purple });
                    }
                  }
                }}
                onHighlight={(value) => {
                  if (themePreviewTimerRef.current) clearTimeout(themePreviewTimerRef.current);
                  themePreviewTimerRef.current = null;
                  setThemeSelection((currentTheme) => previewThemeSelection(currentTheme, value));
                }}
                onCancel={() => {
                  if (themePreviewTimerRef.current) clearTimeout(themePreviewTimerRef.current);
                  themePreviewTimerRef.current = null;
                  setThemeSelection((currentTheme) => cancelThemeSelection(currentTheme));
                  setScreen("main");
                }}
              />
            )}

            {screen === "settings-panel" && (
              <SettingsPanel
                focusId={FOCUS_IDS.settingsPanel}
                settings={USER_SETTING_DEFINITIONS}
                values={currentUserSettings}
                onSave={(values) => saveSettingsFromPanel(values as UserSettingValues)}
                onCancel={() => setScreen("main")}
              />
            )}

            {screen === "import-confirmation" && pendingImport && (
              <AttachmentImportPanel
                focusId={FOCUS_IDS.importConfirmationPanel}
                files={pendingImport.files}
                attachmentsDir={pendingImport.attachmentsDir}
                workspaceRoot={workspaceRoot}
                modelSupportsVision={activeRouteProvider?.capabilityProfile?.supportsVision ?? null}
                onConfirm={() => { void handleImportConfirm(); }}
                onCancel={handleImportCancel}
              />
            )}

            {screen === "tool-approval" && toolApproval && (
              <ToolApprovalPanel
                focusId={FOCUS_IDS.toolApprovalPanel}
                request={toolApproval}
                onSelect={(decision) => {
                  const resolve = toolApprovalResolverRef.current;
                  toolApprovalResolverRef.current = null;
                  setToolApproval(null);
                  setScreen("main");
                  resolve?.(decision);
                }}
                onCancelRun={() => {
                  const resolve = toolApprovalResolverRef.current;
                  toolApprovalResolverRef.current = null;
                  setToolApproval(null);
                  setScreen("main");
                  resolve?.("deny");
                  handleCancel();
                }}
              />
            )}

            {screen === "update-prompt" && updateCheckResult?.status === "update-available" && updateCheckResult.latestVersion && (
              <UpdatePromptPanel
                focusId={FOCUS_IDS.updatePrompt}
                currentVersion={updateCheckResult.currentVersion}
                latestVersion={updateCheckResult.latestVersion}
                packageManager={globalPackageManager}
                onSkip={handleSkipUpdateForSession}
                onRestart={exit}
              />
            )}
            {screen === "update-prompt" && updateCheckResult === null && (
              <Box
                borderStyle="round"
                borderColor={activeTheme.borderFocused}
                paddingX={2}
                paddingY={1}
                width="100%"
                marginTop={1}
              >
                <Text color={activeTheme.textMuted}>Checking for Codexa updates...</Text>
              </Box>
            )}
            </>
          }
          mainPanel={null}
          mainPanelMode="viewport"
          composer={composerElement}
          composerRows={composerRows}
          panelHint={null}
        />
      )}
    </ThemeProvider>
  );
}
