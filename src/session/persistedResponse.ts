export function selectPersistedAssistantResponse(
  renderedResponse: string | undefined,
  completeResponse: string | undefined,
): string | undefined {
  return completeResponse ?? renderedResponse;
}
