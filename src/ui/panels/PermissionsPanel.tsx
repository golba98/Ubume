import type { ResolvedRuntimeConfig, RuntimeConfig } from "../../config/runtimeConfig.js";
import {
  formatApprovalPolicyLabel,
  formatNetworkAccessLabel,
  formatSandboxModeLabel,
} from "../../config/runtimeConfig.js";
import { FOCUS_IDS } from "../input/focus.js";
import { SelectionPanel } from "./SelectionPanel.js";

export type PermissionsPanelAction =
  | "approval-policy"
  | "sandbox"
  | "network"
  | "writable-roots-summary"
  | "writable-roots-add"
  | "writable-roots-remove"
  | "writable-roots-clear";

interface PermissionsPanelProps {
  runtime: RuntimeConfig;
  resolvedRuntime: ResolvedRuntimeConfig;
  onSelect: (action: PermissionsPanelAction) => void;
  onCancel: () => void;
}

function formatRootsSummary(count: number): string {
  return count === 1 ? "1 configured" : `${count} configured`;
}

export function PermissionsPanel({
  runtime,
  resolvedRuntime,
  onSelect,
  onCancel,
}: PermissionsPanelProps) {
  const items = [
    {
      label: `Approval policy  ${formatApprovalPolicyLabel(resolvedRuntime.policy.approvalPolicy)} (configured: ${formatApprovalPolicyLabel(runtime.policy.approvalPolicy)})`,
      value: "approval-policy",
    },
    {
      label: `Sandbox mode  ${formatSandboxModeLabel(resolvedRuntime.policy.sandboxMode)} (configured: ${formatSandboxModeLabel(runtime.policy.sandboxMode)})`,
      value: "sandbox",
    },
    {
      label: `Network access  ${formatNetworkAccessLabel(resolvedRuntime.policy.networkAccess)} (configured: ${formatNetworkAccessLabel(runtime.policy.networkAccess)})`,
      value: "network",
    },
    {
      label: `Writable roots  ${formatRootsSummary(runtime.policy.writableRoots.length)}`,
      value: "writable-roots-summary",
    },
    {
      label: "Add writable root",
      value: "writable-roots-add",
    },
    {
      label: "Remove writable root",
      value: "writable-roots-remove",
    },
    {
      label: "Clear writable roots",
      value: "writable-roots-clear",
    },
  ] satisfies Array<{ label: string; value: PermissionsPanelAction }>;

  return (
    <SelectionPanel
      focusId={FOCUS_IDS.permissionsPanel}
      title="Permissions"
      subtitle="Ubume policy guards. Recommended for local coding: On request + Workspace write."
      items={items}
      limit={items.length}
      onSelect={(value) => onSelect(value as PermissionsPanelAction)}
      onCancel={onCancel}
    />
  );
}
