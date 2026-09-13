import React from "react";
import { Box, Text } from "ink";
import { FOCUS_IDS } from "../input/focus.js";
import { SelectionPanel } from "./SelectionPanel.js";

interface ProviderSetupPromptProps {
  providerLabel: string;
  executable: string;
  installCommand: string | null;
  setupCommand: string;
  onInstall: () => void;
  onCancel: () => void;
}

export function ProviderSetupPrompt({
  providerLabel,
  executable,
  installCommand,
  setupCommand,
  onInstall,
  onCancel,
}: ProviderSetupPromptProps) {
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text color="yellow" bold>{providerLabel} is not ready</Text>
        <Text color="gray">Ubume could not find `{executable}` on this computer.</Text>
        <Text color="gray">
          {installCommand
            ? `Install it and open ${providerLabel}'s sign-in/setup flow?`
            : `Install ${providerLabel} manually, then retry the launch?`}
        </Text>
        <Text color="gray">Credentials stay in the provider’s own CLI and are not stored by Ubume.</Text>
        {installCommand && <Text color="gray">Setup command: {setupCommand}</Text>}
      </Box>
      <SelectionPanel
        focusId={FOCUS_IDS.providerSetup}
        title={`Set up ${providerLabel}`}
        subtitle="Enter starts installation and setup · Esc cancels"
        items={installCommand ? [
          { label: `Install ${providerLabel} and sign in`, value: "install" },
          { label: "Cancel", value: "cancel" },
        ] : [
          { label: "I installed it — retry launch", value: "retry" },
          { label: "Cancel", value: "cancel" },
        ]}
        onSelect={(value) => value === "install" || value === "retry" ? onInstall() : onCancel()}
        onCancel={onCancel}
      />
    </Box>
  );
}
