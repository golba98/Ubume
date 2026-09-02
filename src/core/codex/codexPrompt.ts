import type { AvailableMode } from "../../config/settings.js";
import type { ResolvedRuntimeConfig } from "../../config/runtimeConfig.js";
import type { ProjectInstructions } from "../workspace/projectInstructions.js";

// ─── Write-intent detection ───────────────────────────────────────────────────

const WRITE_INTENT_PATTERNS = [
  /\b(create|make|build|implement|add|generate|write|scaffold|fix|edit|update|refactor|cleanup|clean up|delete|remove|prune|purge)\b/i,
  /\b(file|files|folder|folders|directory|directories|artifact|artifacts|generated|cache|caches|build|dist|coverage|app|component|script|cli|project|test|tests|bug|feature)\b/i,
  /\b(py|python|ts|tsx|js|jsx|json|md|html|css|sql|yaml|yml|toml)\b/i,
];

const GENERATED_CLEANUP_ACTION_PATTERN = /\b(cleanup|clean up|delete|remove|prune|purge)\b/i;
const GENERATED_CLEANUP_SAFE_TARGET_PATTERN =
  /\b(clearly safe|safe generated|generated|cache|caches|cached|build artifacts?|temporary|temp|tmp|dist|coverage|out|\.cache|node_modules)\b/i;
const BROAD_DESTRUCTIVE_CLEANUP_PATTERN =
  /\b(delete|remove|cleanup|clean up|wipe|purge|prune)\s+(everything|entire|whole|repo|repository|workspace|project)\b/i;
const BROAD_ALL_FILES_CLEANUP_PATTERN =
  /\b(delete|remove|cleanup|clean up|wipe|purge|prune)\s+all\s+(?!generated|clearly safe|safe generated)(files|folders|directories|contents)\b/i;
const FORCEFUL_DELETE_PATTERN = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/[fsq]|format|nuke|wipe)\b/i;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionModeDecision {
  mode: AvailableMode;
  autoUpgraded: boolean;
}

export interface PlanningPromptParams {
  task: string;
  constraints?: readonly string[];
  currentPlan?: string | null;
  pendingFeedback?: {
    mode: "revise" | "constraints";
    text: string;
  } | null;
}

export interface PlanExecutionPromptParams {
  task: string;
  approvedPlan: string;
  constraints?: readonly string[];
}

export interface CodexPromptOptions {
  projectInstructions?: ProjectInstructions | null;
}

// ─── Prompt utility functions ─────────────────────────────────────────────────

const TERMINAL_RESPONSE_INSTRUCTIONS = [
  "Final answer style for this terminal UI:",
  "- Keep answers compact unless the user asks for detail.",
  "- Prefer terminal-native section labels like Purpose:, Main parts:, Result:, and Next:.",
  "- Reference local files with short relative paths such as src/App.tsx, not Markdown links.",
  "- Do not include absolute local paths like C:/Users/... or file://... unless the user explicitly asks for them.",
  "- Preserve useful file references, but avoid web-style local Markdown links in final answers.",
  "- Answer simple questions simply and do not over-explain.",
];

export function promptHasWriteIntent(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;

  const hits = WRITE_INTENT_PATTERNS.reduce(
    (count, pattern) => (pattern.test(normalized) ? count + 1 : count),
    0,
  );

  return hits >= 2;
}

export function isClearlySafeGeneratedCleanupRequest(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;

  if (BROAD_DESTRUCTIVE_CLEANUP_PATTERN.test(normalized)) return false;
  if (BROAD_ALL_FILES_CLEANUP_PATTERN.test(normalized)) return false;
  if (FORCEFUL_DELETE_PATTERN.test(normalized)) return false;

  return GENERATED_CLEANUP_ACTION_PATTERN.test(normalized)
    && GENERATED_CLEANUP_SAFE_TARGET_PATTERN.test(normalized);
}

export function resolveExecutionMode(
  requestedMode: AvailableMode,
  prompt: string,
): ExecutionModeDecision {
  if (requestedMode !== "suggest") {
    return { mode: requestedMode, autoUpgraded: false };
  }

  if (promptHasWriteIntent(prompt)) {
    return { mode: "auto-edit", autoUpgraded: true };
  }

  return { mode: requestedMode, autoUpgraded: false };
}

export function enrichFileCreationPrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) return prompt;

  const fileCreationMatch = /^(?:make|create|generate|add|write)\s+(?:a\s+|an\s+|new\s+)?(?:text\s+|markdown\s+|js\s+|ts\s+|python\s+)?(?:file|script|document)\s*(?:about|saying|for|called|named|with)?\s*(.*)$/i.exec(normalized);
  
  if (!fileCreationMatch) {
    return prompt;
  }
  
  const description = fileCreationMatch[1]?.trim();
  if (!description) {
    return [
      prompt,
      "",
      "System Instructions for File Creation:",
      "- The user requested a new file but didn't specify a name.",
      "- Infer a sensible default filename (like 'untitled.txt' or 'scratch.md') and add content if context implies it. Do not create an empty file without an extension.",
    ].join("\n");
  }

  const explicitExact = /^(?:called|named|save as)\s+['"]?([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)['"]?$/i.test(description);
  const hasExtension = /\.[a-zA-Z0-9]{1,5}(\s|$)/.test(description);
  const hasQuotes = /['"]([^'"]+)['"]/.test(description);
  
  if (explicitExact || hasExtension || hasQuotes) {
    return [
      prompt,
      "",
      "System Instructions for File Creation:",
      "- The user provided an explicit filename (detected via quotes, extension, or direct naming).",
      "- Create the file exactly as designated.",
    ].join("\n");
  }

  return [
    prompt,
    "",
    "System Instructions for File Creation:",
    "- The request is a natural-language description, NOT a literal filename.",
    "- DO NOT use the entire sentence as the filename (e.g., do not create 'how much i love rean go').",
    "- Infer intent and generate a short, sensible filename (e.g., 'rean-love-note.txt', 'project-ideas.md').",
    "- Include an appropriate file extension.",
    "- The request implies content, so generate appropriate starter content. DO NOT create an empty file.",
  ].join("\n");
}

export function buildPlanningPrompt({
  task,
  constraints = [],
  currentPlan = null,
  pendingFeedback = null,
}: PlanningPromptParams): string {
  const sections = [
    "Plan-only turn.",
    "Do not implement the task, do not claim to have edited files, and do not describe completed changes.",
    "Produce a concise, repo-aware implementation plan in Markdown.",
    "Include these sections in order: Files, Steps, Assumptions, Risks.",
    "Under Files, list the files you expect to create, modify, or delete when they can be inferred.",
    "Under Steps, give concrete implementation steps.",
    "Under Assumptions, capture reasonable inferences you are making.",
    "Under Risks, note obvious risks, confirmations, or scope boundaries.",
    "Keep the plan focused and actionable. Do not ask for approval inside the plan.",
    "Your final message must contain only the plan. Do any exploration and commentary before your last tool call; do not add a preamble, summary, or closing remarks around the plan.",
    "",
    "Task:",
    task.trim(),
  ];

  if (constraints.length > 0) {
    sections.push("", "Active constraints:");
    for (const constraint of constraints) {
      sections.push(`- ${constraint}`);
    }
  }

  if (currentPlan?.trim()) {
    sections.push("", "Current approved draft plan:", currentPlan.trim());
  }

  if (pendingFeedback?.text.trim()) {
    const label = pendingFeedback.mode === "revise" ? "Revision request" : "Additional constraints";
    sections.push("", `${label}:`, pendingFeedback.text.trim());
  }

  return sections.join("\n");
}

export function buildPlanExecutionPrompt({
  task,
  approvedPlan,
  constraints = [],
}: PlanExecutionPromptParams): string {
  const sections = [
    "The user approved the following plan. Implement it now.",
    "Do the work in the workspace instead of re-planning.",
    "Only pause if you discover a genuinely blocking issue.",
    "",
    "Original task:",
    task.trim(),
    "",
    "Approved plan:",
    approvedPlan.trim(),
  ];

  if (constraints.length > 0) {
    sections.push("", "Additional constraints:");
    for (const constraint of constraints) {
      sections.push(`- ${constraint}`);
    }
  }

  return sections.join("\n");
}

// ─── Hollow response detection ───────────────────────────────────────────────

export type HollowResponseKind = "greeting" | "filler" | "clarification" | "short-no-action" | "none";

export interface HollowResponseResult {
  isHollow: boolean;
  kind: HollowResponseKind;
  reason: string;
}

const GREETING_PATTERNS = [
  /^(hello|hi|hey|sure|okay|ok|got it|understood|of course|absolutely|certainly|great|sounds good)[.!]?\s*$/i,
  /^i('m| am) (ready|here|available|happy to help)[.!]?\s*$/i,
  /^how can i (help|assist) (you )?(today|now)?[?!]?\s*$/i,
];

const FILLER_PATTERNS = [
  /^(thanks|thank you|no problem|you're welcome|will do|on it|noted)[.!]?\s*$/i,
];

const CLARIFICATION_PATTERNS = [
  /^(can you|could you|what|which|where|please)\b.+\b(clarify|specify|provide|tell me|explain|mean)\b.*[?.]?\s*$/i,
];

const ACTION_CONFIRMATION_PATTERNS = [
  /\b(created?|wrote|written|updated?|modified?|added?|deleted?|removed?|changed?|fixed?|built?|generated?|scaffolded?|refactored?)\b/i,
  /\b(file|files|function|class|component|module|directory|folder)\b/i,
  /```/,
  /\[QUESTION\]:/,
];

export function detectHollowResponse(prompt: string, response: string): HollowResponseResult {
  const trimmed = response.trim();
  const hasWriteIntent = promptHasWriteIntent(prompt);

  // Only flag hollow responses when the prompt actually asked the backend to do something.
  // A user saying "Hello" and getting "Hello" back is perfectly normal.
  if (!hasWriteIntent) {
    return { isHollow: false, kind: "none", reason: "" };
  }

  if (!trimmed) {
    return { isHollow: true, kind: "filler", reason: "Empty response" };
  }

  for (const pattern of GREETING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { isHollow: true, kind: "greeting", reason: "Generic greeting" };
    }
  }

  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { isHollow: true, kind: "filler", reason: "Filler acknowledgment" };
    }
  }

  for (const pattern of CLARIFICATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { isHollow: true, kind: "clarification", reason: "Clarification question" };
    }
  }

  if (trimmed.length < 80) {
    const hasConfirmation = ACTION_CONFIRMATION_PATTERNS.some((p) => p.test(trimmed));
    if (!hasConfirmation) {
      return { isHollow: true, kind: "short-no-action", reason: "Short response with no action confirmation" };
    }
  }

  return { isHollow: false, kind: "none", reason: "" };
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function resolvePromptRuntime(
  modeOrRuntime: AvailableMode | Pick<ResolvedRuntimeConfig, "mode" | "policy" | "planMode">,
  runtimePolicy?: {
    approvalPolicy: string;
    sandboxMode: string;
    planMode?: boolean;
  },
): { mode: AvailableMode; sandboxMode: string; planMode: boolean } {
  if (typeof modeOrRuntime === "string") {
    return {
      mode: modeOrRuntime,
      sandboxMode: runtimePolicy?.sandboxMode ?? "workspace-write",
      planMode: runtimePolicy?.planMode ?? false,
    };
  }

  return {
    mode: modeOrRuntime.mode,
    sandboxMode: modeOrRuntime.policy.sandboxMode,
    planMode: modeOrRuntime.planMode,
  };
}

function formatProjectInstructionsSection(projectInstructions: ProjectInstructions | null | undefined): string[] {
  const content = projectInstructions?.content.trim();
  if (!content) {
    return [];
  }
  const sourcePath = projectInstructions?.path ?? "unknown";

  return [
    "Project instructions:",
    `Loaded from: ${sourcePath}`,
    content,
    "",
  ];
}

export function buildCodexPrompt(
  prompt: string,
  modeOrRuntime: AvailableMode | Pick<ResolvedRuntimeConfig, "mode" | "policy" | "planMode">,
  runtimePolicy?: {
    approvalPolicy: string;
    sandboxMode: string;
    planMode?: boolean;
  },
  options: CodexPromptOptions = {},
): string {
  const enrichedPrompt = enrichFileCreationPrompt(prompt);
  const { mode, sandboxMode, planMode } = resolvePromptRuntime(modeOrRuntime, runtimePolicy);
  const projectInstructionsSection = formatProjectInstructionsSection(options.projectInstructions);
  const readOnlySandbox = sandboxMode === "read-only";
  const planModeInstructions = planMode
    ? [
      "Planning mode is enabled for this session.",
      "Start by giving a concise, repo-aware plan for how you will handle the task.",
      "After the plan, continue the task normally under the current mode and runtime permissions.",
      "Do not treat planning mode as a permission change and do not silently switch execution modes.",
    ]
    : [];

  if (readOnlySandbox) {
    return [
      "The user request below is the task to handle now.",
      "Do not reply with generic readiness or ask what they want changed if the request is already specific.",
      ...planModeInstructions,
      "Runtime permissions are read-only for this turn.",
      "Inspect files and answer carefully, but do not claim to have edited files unless you actually could.",
      "Default to best-effort continuation instead of stopping for clarification.",
      "If a detail is missing but non-critical, make the most reasonable assumption and state it briefly.",
      "If multiple paths are possible, choose one sensible path and continue.",
      "Only ask a blocking follow-up question if proceeding would likely use the wrong file, wrong command, destructive behavior, or produce fundamentally incorrect output.",
      "If you are truly blocked on one critical missing fact, end the response with exactly one line in this format: [QUESTION]: <your question>",
      ...TERMINAL_RESPONSE_INSTRUCTIONS,
      "",
      ...projectInstructionsSection,
      "Task:",
      enrichedPrompt,
    ].join("\n");
  }

  if (mode === "suggest") {
    return [
      "The user request below is the task to handle now.",
      "Do not reply with generic readiness or ask what they want changed if the request is already specific.",
      ...planModeInstructions,
      "The current permissions allow workspace edits, but this turn is still in suggest mode.",
      "Inspect the repo and answer carefully without making file changes in this turn.",
      "Default to best-effort continuation instead of stopping for clarification.",
      "If a detail is missing but non-critical, make the most reasonable assumption and state it briefly.",
      "If multiple paths are possible, choose one sensible path and continue.",
      "Only ask a blocking follow-up question if proceeding would likely use the wrong file, wrong command, destructive behavior, or produce fundamentally incorrect output.",
      "If you are truly blocked on one critical missing fact, end the response with exactly one line in this format: [QUESTION]: <your question>",
      ...TERMINAL_RESPONSE_INSTRUCTIONS,
      "",
      ...projectInstructionsSection,
      "Task:",
      enrichedPrompt,
    ].join("\n");
  }

  const autonomyLine =
    mode === "full-auto"
      ? "Act with strong autonomy: inspect the repo, create or update files directly, and run checks when helpful."
      : "Act like a coding agent: inspect the repo, create or update files directly, and prefer real workspace edits over large pasted code blocks.";
  const generatedCleanupInstructions = isClearlySafeGeneratedCleanupRequest(prompt)
    ? [
      "Fast generated-file cleanup guidance:",
      "- Start with a shallow workspace inspection and act decisively.",
      "- Delete only conventional generated artifacts, caches, temporary folders, dependency installs, and build outputs inside the workspace.",
      "- Skip ambiguous, user-authored, source, config, docs, lock, and project files.",
      "- Attempt each safe cleanup target once.",
      "- If deletion is blocked by access denied, permission denied, a locked/in-use file, EACCES, EPERM, EBUSY, or Git lock metadata, stop immediately and report the blocked path and cause.",
      "- Do not retry, force-delete, change permissions, run setup/bootstrap commands, or continue broad analysis after a clear blocked-delete failure.",
      "- Do not do branch, bootstrap, package install, or repo setup work for this cleanup.",
      "- Summarize exactly what was removed and what was skipped.",
    ]
    : [];

  return [
    "The user request below is the task to handle now.",
    "Do not reply with generic readiness or ask what they want changed if the request is already specific.",
    ...planModeInstructions,
    ...generatedCleanupInstructions,
    "If the request is actionable, make the change in the workspace before responding.",
    "You are running inside the user's current workspace with write access.",
    autonomyLine,
    "Default to best-effort continuation instead of stopping for clarification.",
    "If a detail is missing but non-critical, make the most reasonable assumption and state it briefly.",
    "If multiple paths are possible, choose one sensible path and continue.",
    "Only ask a blocking follow-up question if proceeding would likely use the wrong file, wrong command, destructive behavior, or produce fundamentally incorrect output.",
    "If you are truly blocked on one critical missing fact, end the response with exactly one line in this format: [QUESTION]: <your question>",
    "After doing the work, summarize what changed.",
    ...TERMINAL_RESPONSE_INSTRUCTIONS,
    "",
    ...projectInstructionsSection,
    "Task:",
    enrichedPrompt,
  ].join("\n");
}
