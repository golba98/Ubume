import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useFocus, useInput, useStdin } from "ink";
import { formatContextCompact } from "../../core/providerRuntime/contextMetadata.js";
import type { ModelSpec } from "../../core/models/modelSpecs.js";
import type { ExternalCliStatus, UIState } from "../../session/types.js";
import { FOCUS_IDS } from "../input/focus.js";
import {
  createInputViewport,
  deleteInputBackward,
  deleteInputForward,
  getComposerBodyWidth,
  insertInputText,
  moveCursorLeft,
  moveCursorRight,
  normalizeInputText,
  normalizeCursorOffset,
} from "../input/inputBuffer.js";
import { getModeDisplaySpec } from "../render/modeDisplay.js";
import { ActivityIndicator } from "./ActivityIndicator.js";
import { measureRunFooterRows, MemoizedRunFooter } from "./RunFooter.js";
import { THEMES, useTheme } from "../theme.js";
import { clampVisualText, getShellWidth, type Layout } from "../layout.js";
import { getTextWidth, splitTextAtColumn } from "../render/textLayout.js";
import { useThrottledValue } from "../useThrottledValue.js";
import { sanitizeTerminalOutput } from "../../core/terminal/terminalSanitize.js";
import { getStdinDebugState, traceInputDebug } from "../../core/debug/inputDebug.js";
import * as renderDebug from "../../core/perf/renderDebug.js";
import { AnimatedStatusText } from "./AnimatedStatusText.js";
import { isAnimatedBusyState } from "./busyStatusAnimation.js";
import { Spinner } from "./Spinner.js";
import { getSlashCommandSuggestions, type CommandSuggestion } from "../input/slashCommands.js";
import {
  createPastedContentToken,
  deleteAdjacentPastedContent,
  isLargePaste,
  moveAcrossPastedContent,
} from "../input/pastedContent.js";

// ─── Types & constants ────────────────────────────────────────────────────────

type ComposerPersona = "idle" | "busy" | "answer" | "error";
type DeleteIntent = "backspace" | "delete";

const BRACKETED_PASTE_START = /(?:\u001B)?\[200~/;
const BRACKETED_PASTE_END = /(?:\u001B)?\[201~/;
const DELETE_ESCAPE_SEQUENCE = /^\u001b\[3(?:;\d+)?~$/;
const BACKTAB_ESCAPE_SEQUENCE = /(?:\u001b\[Z|\u001b\[1;2Z|\u001b\[9;2u|\u001b\[27;2;9~)/;
const CTRL_M_ESCAPE_SEQUENCE = /^\u001b\[(?:109|13);5u$/;
const CTRL_ALT_P_ESCAPE_SEQUENCE = /(?:\x1b\x10|\x1b\[112;[78]u)/;
const MAX_VISIBLE_INPUT_ROWS = 5;
const PASTE_CHUNK_CANDIDATE_MIN = 64;
const PASTE_CHUNK_SETTLE_MS = 12;

function resolveDeleteIntentFromRawInput(raw: string): DeleteIntent | null {
  if (raw === "\b" || raw === "\x08" || raw === "\u007f" || raw === "\u001b\u007f") {
    return "backspace";
  }

  if (DELETE_ESCAPE_SEQUENCE.test(raw)) {
    return "delete";
  }

  return null;
}

function formatApprox(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ─── Exported helpers ────────────────────────────────────────────────────────

export function getTokenBarDisplay(tokensUsed: number, modelSpec: ModelSpec) {
  if (modelSpec.status !== "verified") {
    return {
      usedText: "Context",
      limitText: "Unknown",
      percentage: null as number | null,
      isEstimatedLimit: false,
      hasKnownLimit: false,
    };
  }
  const isEstimated = modelSpec.isEstimated === true;
  const pct = modelSpec.contextWindow > 0
    ? Math.min(100, Math.floor((tokensUsed / modelSpec.contextWindow) * 100))
    : 0;
  return {
    usedText: tokensUsed.toLocaleString("en-US"),
    limitText: isEstimated
      ? `~${formatContextCompact(modelSpec.contextWindow)}`
      : modelSpec.contextWindow.toLocaleString("en-US"),
    percentage: pct,
    isEstimatedLimit: isEstimated,
    hasKnownLimit: true,
  };
}

interface BottomComposerProps {
  layout: Layout;
  uiState: UIState;
  themeName?: string;
  mode?: string;
  model?: string;
  footerModelDisplay?: string;
  reasoningLevel?: string;
  contextDisplay?: string;
  planMode?: boolean;
  showBusyLoader?: boolean;
  tokensUsed?: number;
  modelSpec?: ModelSpec;
  value: string;
  cursor: number;
  onChangeInput: (value: string, cursor: number) => void;
  onRegisterPaste?: (label: string, content: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onChangeValue: (value: string) => void;
  onChangeCursor: (cursor: number) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onOpenBackendPicker: () => void;
  onOpenProviderPicker?: () => void;
  onOpenModelPicker: () => void;
  onOpenModePicker: () => void;
  onOpenThemePicker: () => void;
  onOpenAuthPanel: () => void;
  onTogglePlanMode: () => void;
  onClear: () => void;
  onCycleMode: () => void;
  onQuit: () => void;
  activeProviderId?: string;
  externalCliStatus?: ExternalCliStatus;
}

export interface BottomComposerMeasureParams {
  layout: Layout;
  uiState: UIState;
  mode?: string;
  model?: string;
  reasoningLevel?: string;
  tokensUsed?: number;
  modelSpec?: ModelSpec;
  value: string;
  cursor: number;
}

export function isBacktabSequence(raw: string): boolean {
  return BACKTAB_ESCAPE_SEQUENCE.test(raw);
}

export interface CommandSuggestionState {
  showSuggestions: boolean;
  reserveSuggestionRow: boolean;
  suggestions: readonly CommandSuggestion[];
}

const FALLBACK_MODEL_SPEC: ModelSpec = {
  status: "unknown",
  contextWindow: null,
  maxOutputTokens: null,
  sourceUrl: "",
  verifiedAt: null,
  error: null,
};

export function getComposerPersona(uiState: UIState): ComposerPersona {
  if (isAnimatedBusyState(uiState.kind)) {
    return "busy";
  }
  if (uiState.kind === "AWAITING_USER_ACTION") {
    return "answer";
  }
  if (uiState.kind === "ERROR") {
    return "error";
  }
  return "idle";
}

export function shouldRenderBusyFooter(layout: Layout, uiState: UIState): boolean {
  return false;
}

export function getComposerToFooterGapRows(layout: Layout): number {
  return 0;
}

export function getCommandSuggestionState({
  value,
  allowCommands,
  inputLocked,
}: {
  value: string;
  allowCommands: boolean;
  inputLocked: boolean;
}): CommandSuggestionState {
  const isCmdPrefix = allowCommands && value.startsWith("/");
  const cmdPrefix = value.split(" ")[0]?.toLowerCase() ?? "";
  const canSuggest = !inputLocked && isCmdPrefix && !value.includes(" ");
  const matchingSuggestions = canSuggest ? getSlashCommandSuggestions(cmdPrefix) : [];
  const exactMatch = matchingSuggestions.find((command) => command.cmd === cmdPrefix);
  const exactMatchAliases = exactMatch && "aliases" in exactMatch ? exactMatch.aliases : undefined;
  const suppressExactMatch = exactMatch ? !(exactMatchAliases?.length ?? 0) : true;
  const suggestions = matchingSuggestions.filter((command) => !(suppressExactMatch && command.cmd === cmdPrefix));

  return {
    showSuggestions: canSuggest,
    reserveSuggestionRow: matchingSuggestions.length > 0,
    suggestions,
  };
}

export function measureBottomComposerRows({
  layout,
  uiState,
  value,
  cursor,
}: BottomComposerMeasureParams): number {
  if (shouldRenderBusyFooter(layout, uiState)) {
    return measureRunFooterRows();
  }

  const persona = getComposerPersona(uiState);
  const inputLocked = persona === "busy";
  const allowCommands = persona !== "answer";
  const composerWidth = getShellWidth(layout.cols);
  const composerBodyWidth = getComposerBodyWidth(composerWidth);
  const promptWidth = Math.max(4, composerBodyWidth - getTextWidth("❯ "));
  const normalizedValue = normalizeInputText(value);
  const normalizedCursor = normalizeCursorOffset(normalizedValue, cursor);
  const promptViewport = createInputViewport({
    text: normalizedValue,
    cursorOffset: normalizedCursor,
    width: promptWidth,
    maxVisibleRows: MAX_VISIBLE_INPUT_ROWS,
    scrollRow: 0,
  });
  const commandSuggestionState = getCommandSuggestionState({
    value: normalizedValue,
    allowCommands,
    inputLocked,
  });

  const bottomPadding = layout.mode === "compact" ? 0 : 1;
  const footerGapRows = getComposerToFooterGapRows(layout);
  const visibleStatusLine = getVisibleComposerStatusLine({
    uiState,
    value: normalizedValue,
    allowCommands,
  });
  const transientStatusRows = visibleStatusLine.length > 0 ? 1 : 0;

  const visiblePromptRows = inputLocked ? 1 : promptViewport.visibleRows.length;

  return (
    visiblePromptRows
    + 2
    + (commandSuggestionState.reserveSuggestionRow ? 1 : 0)
    + footerGapRows
    + transientStatusRows
    + 1
    + bottomPadding
  );
}

function getExternalCliLabel(providerId: string): string | null {
  if (providerId === "google") return "Gemini CLI";
  if (providerId === "anthropic") return "Claude Code";
  if (providerId === "openai") return "Codex CLI";
  return null;
}

function getProviderReadyLabel(providerId: string): string | null {
  if (providerId === "google") return "Gemini";
  if (providerId === "anthropic") return "Claude";
  if (providerId === "openai") return "Codex";
  return null;
}

function getStatusLine(
  uiState: UIState,
  activeProviderId?: string,
  runElapsedSeconds?: number,
  externalCliStatus?: ExternalCliStatus,
): string | null {
  if (uiState.kind === "THINKING") {
    const cliLabel = activeProviderId ? getExternalCliLabel(activeProviderId) : null;
    if (cliLabel && externalCliStatus !== "ready") {
      const elapsed = runElapsedSeconds ?? 0;
      const timerStr = elapsed > 0 ? `  ${formatElapsed(elapsed)}` : "";
      if (elapsed >= 15) return `Still waiting for ${cliLabel}${timerStr}`;
      if (elapsed >= 5) return `${cliLabel} is still starting. The upstream CLI can take a moment${timerStr}`;
      return `Starting ${cliLabel}${timerStr}`;
    }
    return "✧ Codexa is thinking";
  }
  if (uiState.kind === "RESPONDING") {
    const readyLabel = activeProviderId ? getProviderReadyLabel(activeProviderId) : null;
    if (readyLabel) return `✧ ${readyLabel} ready`;
    return "✧ Codexa is thinking";
  }
  if (uiState.kind === "ANSWER_VISIBLE") return "✧ Codexa response complete";
  if (uiState.kind === "SHELL_RUNNING") return "✧ Codexa is running command";
  if (uiState.kind === "AWAITING_USER_ACTION") return "✧ waiting for your answer";
  if (uiState.kind === "ERROR") return uiState.message;
  return null;
}

export function getVisibleComposerStatusLine({
  uiState,
  value,
  allowCommands,
  activeProviderId,
  runElapsedSeconds,
  externalCliStatus,
}: {
  uiState: UIState;
  value: string;
  allowCommands: boolean;
  activeProviderId?: string;
  runElapsedSeconds?: number;
  externalCliStatus?: ExternalCliStatus;
}): string {
  const persona = getComposerPersona(uiState);
  const rawStatusLine = getStatusLine(uiState, activeProviderId, runElapsedSeconds, externalCliStatus) ?? "";
  const isCommandDraft = allowCommands && value.startsWith("/");

  if (rawStatusLine.length === 0 || persona === "answer" || isCommandDraft) {
    return "";
  }

  return rawStatusLine;
}

function getPlaceholder(persona: ComposerPersona): string {
  switch (persona) {
    case "answer":
      return "Type your answer...";
    case "error":
      return "Ask again or use /command";
    case "busy":
      return "";
    case "idle":
    default:
      return "Ask Codexa, run !shell, or use /command";
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

function renderFooterRuntime(displayStr: string, theme: any) {
  // e.g. "Claude Code CLI / Sonnet 4.6 (Low)"
  const slashIndex = displayStr.indexOf("/");
  if (slashIndex === -1) {
    return <Text color={theme.model} wrap="truncate">{displayStr}</Text>;
  }
  const providerPart = displayStr.substring(0, slashIndex).trim();
  let remaining = displayStr.substring(slashIndex + 1).trim();

  const parenIndex = remaining.indexOf("(");
  if (parenIndex === -1) {
    return (
      <Box flexDirection="row" overflow="hidden">
        <Text color={theme.provider}>{providerPart}</Text>
        <Text color={theme.textMuted}>{" / "}</Text>
        <Text color={theme.model}>{remaining}</Text>
      </Box>
    );
  }

  const modelPart = remaining.substring(0, parenIndex).trim();
  let reasoningPart = remaining.substring(parenIndex + 1).trim();
  if (reasoningPart.endsWith(")")) {
    reasoningPart = reasoningPart.substring(0, reasoningPart.length - 1).trim();
  }

  return (
    <Box flexDirection="row" overflow="hidden">
      <Text color={theme.provider}>{providerPart}</Text>
      <Text color={theme.textMuted}>{" / "}</Text>
      <Text color={theme.model}>{modelPart}</Text>
      <Text color={theme.textMuted}>{" ("}</Text>
      <Text color={theme.accentMuted}>{reasoningPart}</Text>
      <Text color={theme.textMuted}>{")"}</Text>
    </Box>
  );
}

export function BottomComposer({
  layout,
  uiState,
  themeName = "purple",
  mode = "",
  model = "",
  footerModelDisplay,
  reasoningLevel = "",
  contextDisplay,
  planMode = false,
  showBusyLoader = true,
  tokensUsed = 0,
  modelSpec = FALLBACK_MODEL_SPEC,
  value,
  cursor,
  onChangeInput,
  onRegisterPaste,
  onSubmit,
  onCancel,
  onChangeValue,
  onChangeCursor,
  onHistoryUp,
  onHistoryDown,
  onOpenBackendPicker,
  onOpenProviderPicker = () => undefined,
  onOpenModelPicker,
  onOpenModePicker,
  onOpenThemePicker,
  onOpenAuthPanel,
  onTogglePlanMode,
  onClear,
  onCycleMode,
  onQuit,
  activeProviderId = "",
  externalCliStatus,
}: BottomComposerProps) {
  renderDebug.useRenderDebug("Composer", {
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
    uiStateKind: uiState.kind,
    themeName,
    runtimeMode: mode,
    model,
    reasoningLevel,
    planMode,
    tokensUsed,
    modelSpecStatus: modelSpec.status,
    value,
    cursor,
  });
  renderDebug.useLifecycleDebug("Composer", {
    uiStateKind: uiState.kind,
    cols: layout.cols,
    rows: layout.rows,
    mode: layout.mode,
  });
  renderDebug.traceLayoutValidity("Composer", {
    cols: layout.cols,
    rows: layout.rows,
  });

  const { stdin } = useStdin();
  const inheritedTheme = useTheme();
  // The composer is memoized and also rendered across the main/overlay shell
  // boundary. Resolve the explicit active theme name here so the runtime row
  // (provider, model, reasoning and context) cannot retain a stale inherited
  // token set during a theme transition. Custom themes remain sourced from the
  // provider because their merged tokens are supplied there.
  const theme = themeName === "custom"
    ? inheritedTheme
    : (THEMES[themeName] ?? inheritedTheme);
  const { cols, mode: layoutMode } = layout;
  const crampedViewport = layout.rows <= 24;
  const { isFocused } = useFocus({ id: FOCUS_IDS.composer, autoFocus: true });
  const [cursorVisible, setCursorVisible] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollRow, setScrollRow] = useState(0);
  const persona = getComposerPersona(uiState);
  const [runElapsedSeconds, setRunElapsedSeconds] = useState(0);

  useEffect(() => {
    if (uiState.kind !== "THINKING") {
      setRunElapsedSeconds(0);
      return;
    }
    setRunElapsedSeconds(0);
    const interval = setInterval(() => {
      setRunElapsedSeconds((s) => s + 1);
    }, 1_000);
    return () => clearInterval(interval);
  }, [uiState.kind]);

  const inputLocked = persona === "busy";
  const allowCommands = persona !== "answer";
  const allowHistory = persona === "idle" || persona === "error";
  const promptPrefix = "❯ ";
  const composerWidth = getShellWidth(cols);
  const composerBodyWidth = getComposerBodyWidth(composerWidth);
  const promptWidth = Math.max(4, composerBodyWidth - getTextWidth(promptPrefix));
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  const lastPropsValueRef = useRef(value);
  const lastPropsCursorRef = useRef(cursor);
  const pasteBufferRef = useRef<string | null>(null);
  const pasteChunkBufferRef = useRef<string | null>(null);
  const pasteChunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteIntentRef = useRef<DeleteIntent | null>(null);
  const backtabEventTickRef = useRef(false);
  const ctrlMEventTickRef = useRef(false);
  const ctrlAltPEventTickRef = useRef(false);
  const mouseEventTickRef = useRef(false);
  const backtabEventTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrlMEventTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrlAltPEventTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseEventTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleRawInput = (chunk: Buffer | string) => {
      const raw = typeof chunk === "string" ? chunk : chunk.toString();
      const intent = resolveDeleteIntentFromRawInput(raw);
      if (intent) {
        deleteIntentRef.current = intent;
      }

      if (isBacktabSequence(raw)) {
        backtabEventTickRef.current = true;
        if (backtabEventTimeoutRef.current) clearTimeout(backtabEventTimeoutRef.current);
        backtabEventTimeoutRef.current = setTimeout(() => {
          backtabEventTickRef.current = false;
        }, 64);
      }

      // Ctrl+M is not consistently surfaced as input="m" with key.ctrl.
      // Terminals using CSI-u style modified key reporting often emit
      // ESC[109;5u or ESC[13;5u instead. We also support Ctrl+O as a
      // reliable cross-terminal alternative for opening the model picker.
      if (CTRL_M_ESCAPE_SEQUENCE.test(raw)) {
        ctrlMEventTickRef.current = true;
        if (ctrlMEventTimeoutRef.current) clearTimeout(ctrlMEventTimeoutRef.current);
        ctrlMEventTimeoutRef.current = setTimeout(() => {
          ctrlMEventTickRef.current = false;
        }, 64);
      }

      // ESC ^P or CSI u style modified key reporting for Ctrl+Alt+P.
      if (CTRL_ALT_P_ESCAPE_SEQUENCE.test(raw)) {
        ctrlAltPEventTickRef.current = true;
        if (ctrlAltPEventTimeoutRef.current) clearTimeout(ctrlAltPEventTimeoutRef.current);
        ctrlAltPEventTimeoutRef.current = setTimeout(() => {
          ctrlAltPEventTickRef.current = false;
        }, 64);
      }

      // Explicitly detect terminal mouse reporting escape sequences to swallow
      // the fragments (e.g. "[<0;26;24M") that Ink's readline parser sequentially
      // emits after stripping the ESC prefix.
      if (/\u001b\[<(\d+);(\d+);(\d+)([Mm])/.test(raw) || /\u001b\[M/.test(raw)) {
        mouseEventTickRef.current = true;
        if (mouseEventTimeoutRef.current) clearTimeout(mouseEventTimeoutRef.current);
        mouseEventTimeoutRef.current = setTimeout(() => {
          mouseEventTickRef.current = false;
        }, 32);
      }
    };

    stdin.on("data", handleRawInput);
    return () => {
      stdin.off("data", handleRawInput);
      if (backtabEventTimeoutRef.current) clearTimeout(backtabEventTimeoutRef.current);
      if (ctrlMEventTimeoutRef.current) clearTimeout(ctrlMEventTimeoutRef.current);
      if (mouseEventTimeoutRef.current) clearTimeout(mouseEventTimeoutRef.current);
      if (pasteChunkTimerRef.current) clearTimeout(pasteChunkTimerRef.current);
    };
  }, [stdin]);

  // Sync from props only when props actually change from an external source
  // or after a render cycle has confirmed our local change.
  useEffect(() => {
    if (value !== lastPropsValueRef.current || cursor !== lastPropsCursorRef.current) {
      valueRef.current = value;
      cursorRef.current = cursor;
      lastPropsValueRef.current = value;
      lastPropsCursorRef.current = cursor;
    }
  }, [cursor, value]);

  const commandSuggestionState = getCommandSuggestionState({
    value,
    allowCommands,
    inputLocked,
  });
  const { showSuggestions, suggestions } = commandSuggestionState;
  const suggestionText = suggestions
    .map((suggestion, index) => `${index === selectedIndex ? "›" : "·"} ${suggestion.cmd}`)
    .join("   ");

  const rawStatusLine = getVisibleComposerStatusLine({ uiState, value, allowCommands, activeProviderId, runElapsedSeconds, externalCliStatus });
  const showStatusLine = rawStatusLine.length > 0;
  const showTransientStatusRow = showStatusLine || inputLocked;
  const footerGapRows = getComposerToFooterGapRows(layout);

  const promptViewport = useMemo(
    () => createInputViewport({
      text: value,
      cursorOffset: normalizeCursorOffset(value, cursor),
      width: promptWidth,
      maxVisibleRows: MAX_VISIBLE_INPUT_ROWS,
      scrollRow,
    }),
    [cursor, promptWidth, scrollRow, value],
  );
  const placeholderText = clampVisualText(getPlaceholder(persona), Math.max(1, promptWidth - 1));

  useEffect(() => {
    setSelectedIndex(0);
  }, [value]);

  useEffect(() => {
    if (promptViewport.scrollRow !== scrollRow) {
      setScrollRow(promptViewport.scrollRow);
    }
  }, [promptViewport.scrollRow, scrollRow]);

  const commitInputChange = (nextValue: string, nextCursor: number) => {
    const normalizedValue = normalizeInputText(nextValue);
    const normalizedCursor = normalizeCursorOffset(normalizedValue, nextCursor);

    // Update refs immediately to avoid race conditions with fast input events
    valueRef.current = normalizedValue;
    cursorRef.current = normalizedCursor;
    lastPropsValueRef.current = normalizedValue;
    lastPropsCursorRef.current = normalizedCursor;

    onChangeInput(normalizedValue, normalizedCursor);
  };

  const insertText = (text: string) => {
    if (!text) return;
    const next = insertInputText({
      value: valueRef.current,
      cursorOffset: cursorRef.current,
      text,
    });
    commitInputChange(next.value, next.cursorOffset);
  };

  const insertPaste = (text: string) => {
    const pastedText = normalizeInputText(text);
    if (isLargePaste(pastedText)) {
      const label = createPastedContentToken(pastedText);
      onRegisterPaste?.(label, pastedText);
      insertText(label);
      return;
    }
    insertText(pastedText);
  };

  const flushPasteChunks = () => {
    const buffered = pasteChunkBufferRef.current;
    pasteChunkBufferRef.current = null;
    pasteChunkTimerRef.current = null;
    if (buffered) insertPaste(buffered);
  };

  const bufferPasteChunk = (text: string) => {
    pasteChunkBufferRef.current = `${pasteChunkBufferRef.current ?? ""}${text}`;
    if (pasteChunkTimerRef.current) clearTimeout(pasteChunkTimerRef.current);
    pasteChunkTimerRef.current = setTimeout(flushPasteChunks, PASTE_CHUNK_SETTLE_MS);
  };

  const handlePastedInput = (chunk: string) => {
    let remaining = chunk;

    while (remaining.length > 0) {
      if (pasteBufferRef.current !== null) {
        const endMatch = BRACKETED_PASTE_END.exec(remaining);
        if (!endMatch) {
          pasteBufferRef.current += remaining;
          return;
        }

        pasteBufferRef.current += remaining.slice(0, endMatch.index);
        const pastedText = normalizeInputText(pasteBufferRef.current);
        pasteBufferRef.current = null;
        insertPaste(pastedText);
        remaining = remaining.slice(endMatch.index + endMatch[0].length);
        continue;
      }

      const startMatch = BRACKETED_PASTE_START.exec(remaining);
      if (!startMatch) {
        // Ink/readline may consume bracketed-paste delimiters and deliver the
        // payload as one or more input events. Coalesce burst chunks before
        // applying the large-paste threshold so multi-kilobyte pastes cannot
        // leak into the composer as several smaller raw fragments.
        if (pasteChunkBufferRef.current !== null || remaining.length >= PASTE_CHUNK_CANDIDATE_MIN) {
          bufferPasteChunk(remaining);
        } else {
          insertText(normalizeInputText(remaining));
        }
        return;
      }

      const prefix = remaining.slice(0, startMatch.index);
      if (prefix) {
        insertText(normalizeInputText(prefix));
      }

      pasteBufferRef.current = "";
      remaining = remaining.slice(startMatch.index + startMatch[0].length);
    }
  };

  useInput((input, key) => {
    if (mouseEventTickRef.current) {
      return;
    }

    if (backtabEventTickRef.current) {
      backtabEventTickRef.current = false;
      if (backtabEventTimeoutRef.current) {
        clearTimeout(backtabEventTimeoutRef.current);
        backtabEventTimeoutRef.current = null;
      }
      onCycleMode();
      return;
    }


    // Ink exposes Shift+Tab directly on terminals whose parser understands the
    // active keyboard protocol. Keep this path in addition to raw-sequence
    // detection so the shortcut works in VTE, Kitty, and Windows terminals.
    if (key.tab && key.shift) {
      onCycleMode();
      return;
    }

    if (ctrlMEventTickRef.current) {
      ctrlMEventTickRef.current = false;
      if (ctrlMEventTimeoutRef.current) {
        clearTimeout(ctrlMEventTimeoutRef.current);
        ctrlMEventTimeoutRef.current = null;
      }
      if (!inputLocked) {
        traceInputDebug("model_picker_shortcut_received", {
          handler: "BottomComposer.useInput",
          source: "ctrl-m-csi-u",
          inputLocked,
          allowCommands,
          isFocused,
          stdin: getStdinDebugState(stdin),
        });
        onOpenModelPicker();
      }
      return;
    }

    if (ctrlAltPEventTickRef.current) {
      ctrlAltPEventTickRef.current = false;
      if (ctrlAltPEventTimeoutRef.current) {
        clearTimeout(ctrlAltPEventTimeoutRef.current);
        ctrlAltPEventTimeoutRef.current = null;
      }
      if (!inputLocked && allowCommands) {
        onOpenProviderPicker();
      }
      return;
    }

    if (key.ctrl) {
      switch (input) {
        case "q":
        case "c":
          onQuit();
          return;
      }
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (inputLocked) {
      return;
    }

    if (allowCommands && key.ctrl) {
      switch (input) {
        case "b": onOpenBackendPicker(); return;
        case "p":
          if (key.meta) {
            onOpenProviderPicker();
          }
          return;
        case "m": onOpenModelPicker(); return;
        case "o":
          traceInputDebug("ctrl_o_received", {
            handler: "BottomComposer.useInput",
            source: "ctrl-o",
            inputLocked,
            allowCommands,
            isFocused,
            stdin: getStdinDebugState(stdin),
          });
          onOpenModelPicker();
          return;
        case "t": onOpenThemePicker(); return;
        case "a": onOpenAuthPanel(); return;
        case "l": onClear(); return;
        case "y": onCycleMode(); return;
      }
    }

    if (allowCommands && key.ctrl && key.return) {
      onOpenModelPicker();
      return;
    }

    if (key.ctrl && (input === "j" || input === "\n")) {
      insertText("\n");
      return;
    }

    if (key.upArrow) {
      if (showSuggestions && suggestions.length > 0) {
        setSelectedIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (allowHistory) onHistoryUp();
      return;
    }

    if (key.downArrow) {
      if (showSuggestions && suggestions.length > 0) {
        setSelectedIndex((current) => Math.min(suggestions.length - 1, current + 1));
        return;
      }
      if (allowHistory) onHistoryDown();
      return;
    }

    if ((key.tab || key.rightArrow) && showSuggestions && suggestions.length > 0) {
      const selected = suggestions[selectedIndex]?.cmd;
      if (selected) {
        commitInputChange(`${selected} `, selected.length + 1);
        return;
      }
    }

    if (key.return) {
      if (showSuggestions && suggestions.length > 0) {
        const selected = suggestions[selectedIndex];
        const trimmedValue = value.trim().toLowerCase();
        const selectedAliases = selected && "aliases" in selected ? selected.aliases : undefined;
        const isExactPrimary = selected ? trimmedValue === selected.cmd : false;
        const isExactAlias = selectedAliases?.some((alias) => alias === trimmedValue) ?? false;
        if (selected && !isExactPrimary && !isExactAlias) {
          const selectedCmd = selected.cmd;
          commitInputChange(`${selectedCmd} `, selectedCmd.length + 1);
          return;
        }
        if (selected) {
          onSubmit();
          return;
        }
      }

      if (!value.trim()) return;
      onSubmit();
      return;
    }

    if (key.leftArrow) {
      const nextCursor = moveAcrossPastedContent(valueRef.current, cursorRef.current, "left")
        ?? moveCursorLeft(valueRef.current, cursorRef.current);
      commitInputChange(valueRef.current, nextCursor);
      return;
    }

    if (key.rightArrow) {
      const nextCursor = moveAcrossPastedContent(valueRef.current, cursorRef.current, "right")
        ?? moveCursorRight(valueRef.current, cursorRef.current);
      commitInputChange(valueRef.current, nextCursor);
      return;
    }

    if (key.backspace || input === "\b" || (input === "\u007f" && !key.delete)) {
      deleteIntentRef.current = null;
      const next = deleteAdjacentPastedContent(valueRef.current, cursorRef.current, "backward") ?? deleteInputBackward({
        value: valueRef.current,
        cursorOffset: cursorRef.current,
      });
      commitInputChange(next.value, next.cursorOffset);
      return;
    }

    if (key.delete || (input === "\u007f" && key.delete)) {
      const deleteIntent = deleteIntentRef.current;
      deleteIntentRef.current = null;

      if (deleteIntent === "backspace") {
        const next = deleteInputBackward({
          value: valueRef.current,
          cursorOffset: cursorRef.current,
        });
        commitInputChange(next.value, next.cursorOffset);
        return;
      }

      const next = deleteAdjacentPastedContent(valueRef.current, cursorRef.current, "forward") ?? deleteInputForward({
        value: valueRef.current,
        cursorOffset: cursorRef.current,
      });
      commitInputChange(next.value, next.cursorOffset);
      return;
    }

    if (!key.ctrl && !key.meta && !key.escape && input && input.length > 0 && input !== "\u007f" && input !== "\b") {
      handlePastedInput(input);
    }
  }, { isActive: isFocused });

  const tokenDisplay = getTokenBarDisplay(tokensUsed, modelSpec);
  const reasoningSuffix = reasoningLevel ? ` (${reasoningLevel})` : "";
  const footerRuntimeDisplay = footerModelDisplay ?? `${model}${reasoningSuffix}`;
  const isAnswerMode = persona === "answer";
  const showBusyFooter = shouldRenderBusyFooter(layout, uiState);
  const promptPrefixColor = inputLocked ? theme.textDim : theme.text;
  const lockedInputText = promptViewport.visibleRows[0]?.text ?? " ";

  // The prompt line is shared between bordered and non-bordered layouts.
  const promptLine = (
    <Box flexDirection="row" width="100%">
      <Text color={promptPrefixColor} bold={!inputLocked}>{promptPrefix}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {value.length === 0 && !inputLocked ? (
          <Box width="100%" overflow="hidden">
            <Text backgroundColor={cursorVisible && isFocused ? theme.text : undefined} color={cursorVisible && isFocused ? theme.surface : undefined}>{" "}</Text>
            <Text color={theme.textDim}>{placeholderText}</Text>
          </Box>
        ) : inputLocked ? (
          <Box key="busy-locked-input" width="100%" overflow="hidden">
            <Text color={theme.textDim}>{lockedInputText || " "}</Text>
          </Box>
        ) : (
          promptViewport.visibleRows.map((row, index) => {
            const visibleCursorRow = promptViewport.cursorRow - promptViewport.scrollRow;
            const isCursorRow = index === visibleCursorRow;
            const segments = isCursorRow
              ? splitTextAtColumn(row.text, promptViewport.cursorColumn)
              : null;

            return (
              <Box key={`${row.start}-${row.end}-${index}`} width="100%" overflow="hidden">
                {isCursorRow && segments ? (
                  <>
                    <Text color={theme.text}>{segments.before}</Text>
                    <Text backgroundColor={cursorVisible && isFocused ? theme.text : undefined} color={cursorVisible && isFocused ? theme.surface : undefined}>
                      {segments.current || " "}
                    </Text>
                    <Text color={theme.text}>{segments.after}</Text>
                  </>
                ) : (
                  <Text color={theme.text}>{row.text || " "}</Text>
                )}
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );

  if (showBusyFooter) {
    return <MemoizedRunFooter uiState={uiState} showBusyLoader={showBusyLoader} onCancel={onCancel} onQuit={onQuit} />;
  }

  return (
    <Box flexDirection="column" paddingBottom={layoutMode === "compact" ? 0 : 1} width="100%">
      {isAnswerMode ? (
        // Answer mode: Highlighted prompt
        <Box
          flexDirection="column"
          width="100%"
          paddingX={1}
          paddingY={0}
          borderStyle="round"
          borderColor={theme.warning}
        >
          {promptLine}
        </Box>
      ) : (
        // Normal mode: clean prompt in rounded border
        <Box
          flexDirection="column"
          width="100%"
          paddingX={1}
          paddingY={0}
          borderStyle="round"
          borderColor={theme.border}
        >
          {promptLine}
        </Box>
      )}

      {commandSuggestionState.reserveSuggestionRow && (
        <Box paddingLeft={1} marginTop={0} width="100%" overflow="hidden">
          <Text color={theme.textDim} wrap="truncate">{suggestionText || " "}</Text>
        </Box>
      )}

      {footerGapRows > 0 && (
        <Box height={footerGapRows} />
      )}

      {showTransientStatusRow && (
        <Box paddingX={1} marginTop={0} height={1} width="100%" justifyContent="space-between" overflow="hidden">
          <>
            <Box flexShrink={1} flexGrow={1} overflow="hidden" flexDirection="row">
              {!!getExternalCliLabel(activeProviderId ?? "") && uiState.kind === "THINKING" && (
                <>
                  <Spinner color={theme.accent} />
                  <Text>{" "}</Text>
                </>
              )}
              <AnimatedStatusText
                baseText={rawStatusLine}
                isActive={!getExternalCliLabel(activeProviderId ?? "") && inputLocked && showBusyLoader}
                isError={persona === "error"}
              />
            </Box>
            {inputLocked && (
              <Box flexShrink={0}>
                <Text color={theme.textDim}>Esc cancel  Ctrl+C quit</Text>
              </Box>
            )}
          </>
        </Box>
      )}

      <Box paddingLeft={1} paddingRight={1} marginTop={0} width="100%" justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1} overflow="hidden" flexDirection="row">
          {renderFooterRuntime(footerRuntimeDisplay, theme)}
          {planMode ? (
            <Text color={theme.accent}>{"  · PLAN"}</Text>
          ) : mode ? (
            <Text color={getModeDisplaySpec(mode, theme).ringColor}>
              {`  · ${getModeDisplaySpec(mode, theme).label}`}
            </Text>
          ) : null}
        </Box>
        <Box flexShrink={0}>
          {contextDisplay ? (
            <Box flexDirection="row">
              <Text color={theme.textMuted}>Context: </Text>
              <Text color={theme.context}>{contextDisplay}</Text>
            </Box>
          ) : tokenDisplay.hasKnownLimit ? (
            <Box flexDirection="row">
              <Text color={theme.textMuted}>Context: </Text>
              <Text color={theme.context}>{tokenDisplay.usedText}</Text>
              <Text color={theme.textDim}>
                {" / "}{tokenDisplay.limitText}
                {tokenDisplay.percentage !== null ? ` · ${tokenDisplay.isEstimatedLimit ? "~" : ""}${tokenDisplay.percentage}%` : ""}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="row">
              <Text color={theme.textMuted}>Context: </Text>
              <Text color={theme.textDim}>Unknown</Text>
            </Box>
          )}
        </Box>
      </Box>

    </Box>
  );
}

// Helper to extract the relevant uiState kind for comparison
function getUiStateKey(uiState: UIState): string {
  // Only re-render when the kind changes to a different persona-relevant state
  // THINKING/RESPONDING/AWAITING_USER_ACTION are all "busy" states
  // We don't need to re-render for every streaming update within RESPONDING
  if (isAnimatedBusyState(uiState.kind)) {
    return "busy";
  }
  if (uiState.kind === "AWAITING_USER_ACTION") {
    return "answer";
  }
  if (uiState.kind === "ERROR") {
    return "error";
  }
  return "idle";
}

// ─── Memoized export ─────────────────────────────────────────────────────────

// Memoize to prevent re-renders during streaming when props haven't meaningfully changed
export const MemoizedBottomComposer = memo(BottomComposer, (prev, next) => {
  // Always re-render if the uiState kind changes to a different persona
  const prevKey = getUiStateKey(prev.uiState);
  const nextKey = getUiStateKey(next.uiState);
  if (prevKey !== nextKey) return false;
  
  // Re-render if input-related props change
  if (prev.value !== next.value) return false;
  if (prev.cursor !== next.cursor) return false;
  
  // Re-render if display props change
  if (prev.mode !== next.mode) return false;
  if (prev.model !== next.model) return false;
  if (prev.footerModelDisplay !== next.footerModelDisplay) return false;
  if (prev.reasoningLevel !== next.reasoningLevel) return false;
  if (prev.contextDisplay !== next.contextDisplay) return false;
  if (prev.planMode !== next.planMode) return false;
  if (prev.showBusyLoader !== next.showBusyLoader) return false;
  if (prev.tokensUsed !== next.tokensUsed) return false;
  
  // Re-render if layout changes
  if (prev.layout.cols !== next.layout.cols) return false;
  if (prev.layout.rows !== next.layout.rows) return false;
  if (prev.layout.mode !== next.layout.mode) return false;
  if (prev.themeName !== next.themeName) return false;
  
  if (prev.modelSpec?.status !== next.modelSpec?.status) return false;
  if (prev.modelSpec?.contextWindow !== next.modelSpec?.contextWindow) return false;
  
  // Re-render if active provider changes (affects status line text)
  if (prev.activeProviderId !== next.activeProviderId) return false;

  // Skip re-render - streaming updates within RESPONDING don't affect composer
  return true;
});
