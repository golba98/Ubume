import type { AvailableBackend } from "../../config/settings.js";
import type { ResolvedRuntimeConfig } from "../../config/runtimeConfig.js";
import type { ProjectInstructions } from "../workspace/projectInstructions.js";
import type { RunProgressSource, RunToolActivity } from "../../session/types.js";
import type { ConversationContextCheckpoint, ConversationMessage } from "../workspace/conversationStore.js";

export interface BackendProgressUpdate {
  id: string;
  source: RunProgressSource;
  text: string;
}

export type ToolApprovalDecision = "allow-once" | "allow-for-run" | "deny";

export interface ToolApprovalRequest {
  tool: string;
  signature: string;
  command?: string;
  paths: string[];
}

export type BackendAuthState = "delegated" | "api-key-required" | "coming-soon";

export interface BackendRunHandlers {
  onResponse: (response: string) => void;
  onError: (message: string, rawOutput?: string) => void;
  /** Called with each new structured thinking/progress update while the process is still running. */
  onProgress?: (update: BackendProgressUpdate) => void;
  /** Called with each new assistant content delta while the process is still running. */
  onAssistantDelta?: (chunk: string) => void;
  /** Called when the backend indicates the final assistant answer is complete and visible. */
  onFinalAnswerObserved?: (response: string) => void;
  /** Called when the backend starts or finishes a tool/shell action during a run. */
  onToolActivity?: (activity: RunToolActivity) => void;
  /** Requests consent before a local model performs a mutating action. */
  onToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
  /** Persists invisible rolling memory used only by Local context-window rollover. */
  onLocalContextCheckpoint?: (checkpoint: ConversationContextCheckpoint) => void;
  /** Called around backend child-process lifecycle boundaries. */
  onProcessLifecycle?: (event: "before-spawn" | "spawned" | "exit" | "error" | "cleanup") => void;
  /** Lightweight hooks used only by headless benchmark diagnostics. */
  benchmarkHooks?: {
    onProviderPromptPrepared?: (context: { policy: "raw" | "wrapped"; characterCount: number }) => void;
    onProviderPrepStart?: () => void;
    onProviderPrepComplete?: () => void;
    onCodexProcessSpawned?: (context: { executable: string; argv: string[] }) => void;
    onFirstStdout?: (observed?: boolean) => void;
    onFirstStderr?: (observed?: boolean) => void;
    onCodexProcessExit?: (exitCode: number | null) => void;
    onCleanupStart?: () => void;
    onCleanupComplete?: (context: { skipped: boolean }) => void;
  };
}

export interface BackendProvider {
  id: AvailableBackend;
  label: string;
  description: string;
  authState: BackendAuthState;
  authLabel: string;
  statusMessage: string;
  supportsModels: (model: string) => boolean;
  run?: (
    prompt: string,
    options: {
      runtime: ResolvedRuntimeConfig;
      workspaceRoot: string;
      projectInstructions?: ProjectInstructions | null;
      promptPolicy?: "raw" | "wrapped";
      runIntent?: "normal" | "plan" | "approved-execution";
      conversationHistory?: readonly ConversationMessage[];
      localContextCheckpoint?: ConversationContextCheckpoint;
    },
    handlers: BackendRunHandlers,
  ) => () => void;
}
