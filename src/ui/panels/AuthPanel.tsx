import React from "react";
import { Box, Text, useFocus, useInput } from "ink";
import { AUTH_PREFERENCES, formatAuthPreferenceLabel } from "../../config/settings.js";
import type { CodexAuthProbeResult } from "../../core/auth/codexAuth.js";
import { getAuthStateLabel } from "../../core/auth/codexAuth.js";
import type { BackendProvider } from "../../core/providers/types.js";
import { clampVisualText, usePanelLayout } from "../layout.js";
import { useTheme } from "../theme.js";

interface AuthPanelProps {
  focusId: string;
  provider: BackendProvider;
  authPreference: string;
  authStatus: CodexAuthProbeResult;
  authStatusBusy: boolean;
  onSetPreference: (value: string) => void;
  onRefreshAuthStatus: () => void;
  onClose: () => void;
}

export function AuthPanel({
  focusId,
  provider,
  authPreference,
  authStatus,
  authStatusBusy,
  onSetPreference,
  onRefreshAuthStatus,
  onClose,
}: AuthPanelProps) {
  const theme = useTheme();
  const panelLayout = usePanelLayout();
  const compact = panelLayout?.mode === "compact" || (panelLayout?.availableRows ?? 24) < 16;
  const contentWidth = Math.max(1, (panelLayout?.availableCols ?? 80) - 4);
  const { isFocused } = useFocus({ id: focusId, autoFocus: true });

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === "q") {
      onClose();
      return;
    }

    const numeric = Number.parseInt(input, 10);
    if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= AUTH_PREFERENCES.length) {
      onSetPreference(AUTH_PREFERENCES[numeric - 1]!.id);
    }

    if (input.toLowerCase() === "r") {
      onRefreshAuthStatus();
    }
  }, { isActive: isFocused });

  const authStateLabel = getAuthStateLabel(authStatus.state);
  const authStateColor =
    authStatus.state === "authenticated"
      ? theme.success
      : authStatus.state === "unauthenticated"
        ? theme.error
        : theme.warning;
  const checkedAtLabel = authStatus.checkedAt > 0
    ? new Date(authStatus.checkedAt).toLocaleTimeString()
    : "not checked yet";

  if (compact) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.borderFocused}
        flexDirection="column"
        paddingX={1}
        width="100%"
      >
        <Text color={theme.accent} bold>Auth and subscription guidance</Text>
        <Text color={theme.textMuted} wrap="truncate">
          {clampVisualText(`${provider.label} · ${provider.authLabel} · ${authStateLabel}`, contentWidth)}
        </Text>
        <Text color={theme.textDim} wrap="truncate">
          {clampVisualText(`Probe: ${authStatus.rawSummary || "No probe output yet"}`, contentWidth)}
        </Text>
        {AUTH_PREFERENCES.map((item, index) => (
          <Text key={item.id} color={item.id === authPreference ? theme.success : theme.text}>
            {index + 1}. {item.label} {item.id === authPreference ? "✓" : ""}
          </Text>
        ))}
        <Text color={theme.textDim}>1-{AUTH_PREFERENCES.length} change · R refresh · Esc close</Text>
        {authStatusBusy && <Text color={theme.warning}>Checking auth status...</Text>}
        {authStatus.recommendedAction && (
          <Text color={theme.textDim} wrap="truncate">
            {clampVisualText(`Next: ${authStatus.recommendedAction}`, contentWidth)}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.borderFocused}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      marginTop={1}
      width="100%"
    >
      <Text color={theme.accent} bold>
        Auth and subscription guidance
      </Text>
      <Text color={theme.textMuted}>Current backend: {provider.label}</Text>
      <Text color={theme.textMuted}>Current preference: {formatAuthPreferenceLabel(authPreference)}</Text>
      <Text color={theme.info}>Backend auth: {provider.authLabel}</Text>
      <Text color={authStateColor}>Runtime auth state: {authStateLabel}</Text>
      <Text color={theme.textDim}>Last checked: {checkedAtLabel}</Text>
      <Text color={theme.textDim}>Probe summary: {authStatus.rawSummary || "No probe output yet"}</Text>
      <Text color={theme.text}>
        This UI securely bridges to the Ubume neural network. It does not collect or store your ChatGPT credentials.
      </Text>
      <Text color={theme.text}>{provider.statusMessage}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.info}>Commands:</Text>
        <Text color={theme.text}>  /login        guided ChatGPT sign-in steps</Text>
        <Text color={theme.text}>  /logout       guided sign-out steps</Text>
        <Text color={theme.text}>  /auth status  refresh Ubume authentication</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {AUTH_PREFERENCES.map((item, index) => (
          <Text key={item.id} color={item.id === authPreference ? theme.success : theme.text}>
            {index + 1}. {item.label} {item.id === authPreference ? "✓" : ""}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.textDim}>
          Press 1-{AUTH_PREFERENCES.length} to change preference, R to refresh status, Esc to close.
        </Text>
      </Box>
      {authStatusBusy && (
        <Box marginTop={1}>
          <Text color={theme.warning}>Checking auth status...</Text>
        </Box>
      )}
      {authStatus.recommendedAction && (
        <Box marginTop={1}>
          <Text color={theme.textDim}>Next step: {authStatus.recommendedAction}</Text>
        </Box>
      )}
    </Box>
  );
}
