import type { AvailableMode } from "../config/settings.js";

export type PlanFeedbackMode = "revise" | "constraints";

export interface PlanFeedbackRequest {
  mode: PlanFeedbackMode;
  text: string;
}

interface PlanFlowContext {
  originalPrompt: string;
  executionMode: AvailableMode;
  constraints: string[];
  planFilePath: string | null;
}

export type PlanFlowState =
  | { kind: "idle" }
  | (PlanFlowContext & {
    kind: "generating";
    currentPlan: string | null;
    pendingFeedback: PlanFeedbackRequest | null;
  })
  | (PlanFlowContext & {
    kind: "awaiting_action";
    currentPlan: string;
  })
  | (PlanFlowContext & {
    kind: "collecting_feedback";
    currentPlan: string;
    mode: PlanFeedbackMode;
  })
  | (PlanFlowContext & {
    kind: "executing";
    currentPlan: string;
  });

export type PlanGeneratingState = Extract<PlanFlowState, { kind: "generating" }>;
export type PlanAwaitingActionState = Extract<PlanFlowState, { kind: "awaiting_action" }>;
export type PlanCollectingFeedbackState = Extract<PlanFlowState, { kind: "collecting_feedback" }>;
export type PlanExecutingState = Extract<PlanFlowState, { kind: "executing" }>;

export function createInitialPlanFlowState(): PlanFlowState {
  return { kind: "idle" };
}

/**
 * The mode an approved plan executes under. Plan mode is orthogonal to the
 * execution mode, so a session in `suggest` (read-only sandbox) can enter plan
 * mode; approving the plan is an explicit request to write, so lift it to
 * `auto-edit`. Write-capable modes are kept as-is.
 */
export function resolvePlanExecutionMode(mode: AvailableMode): AvailableMode {
  return mode === "suggest" ? "auto-edit" : mode;
}

export function startPlanGeneration(originalPrompt: string, executionMode: AvailableMode): PlanGeneratingState {
  return {
    kind: "generating",
    originalPrompt,
    executionMode: resolvePlanExecutionMode(executionMode),
    constraints: [],
    planFilePath: null,
    currentPlan: null,
    pendingFeedback: null,
  };
}

export function finishPlanGeneration(
  state: PlanFlowState,
  currentPlan: string,
  planFilePath: string | null,
): PlanFlowState {
  if (state.kind !== "generating") {
    return state;
  }

  return {
    kind: "awaiting_action",
    originalPrompt: state.originalPrompt,
    executionMode: state.executionMode,
    constraints: state.constraints,
    currentPlan,
    planFilePath,
  };
}

export function beginPlanFeedback(state: PlanFlowState, mode: PlanFeedbackMode): PlanFlowState {
  if (state.kind !== "awaiting_action") {
    return state;
  }

  return {
    kind: "collecting_feedback",
    originalPrompt: state.originalPrompt,
    executionMode: state.executionMode,
    constraints: state.constraints,
    currentPlan: state.currentPlan,
    planFilePath: state.planFilePath,
    mode,
  };
}

export function submitPlanFeedback(state: PlanFlowState, text: string): PlanFlowState {
  if (state.kind !== "collecting_feedback") {
    return state;
  }

  const nextConstraints = state.mode === "constraints"
    ? [...state.constraints, text]
    : state.constraints;

  return {
    kind: "generating",
    originalPrompt: state.originalPrompt,
    executionMode: state.executionMode,
    constraints: nextConstraints,
    planFilePath: state.planFilePath,
    currentPlan: state.currentPlan,
    pendingFeedback: {
      mode: state.mode,
      text,
    },
  };
}

export function cancelPlanFeedback(state: PlanFlowState): PlanFlowState {
  if (state.kind !== "collecting_feedback") {
    return state;
  }

  return {
    kind: "awaiting_action",
    originalPrompt: state.originalPrompt,
    executionMode: state.executionMode,
    constraints: state.constraints,
    currentPlan: state.currentPlan,
    planFilePath: state.planFilePath,
  };
}

export function approvePlanExecution(state: PlanFlowState): PlanFlowState {
  if (state.kind !== "awaiting_action") {
    return state;
  }

  return {
    kind: "executing",
    originalPrompt: state.originalPrompt,
    executionMode: state.executionMode,
    constraints: state.constraints,
    currentPlan: state.currentPlan,
    planFilePath: state.planFilePath,
  };
}

export function resetPlanFlow(): PlanFlowState {
  return createInitialPlanFlowState();
}
