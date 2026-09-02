export const MIN_DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const MAX_DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/**
 * Output-token budget for a Local model that advertises no cap of its own.
 *
 * Reasoning models spend output tokens thinking before they answer; a flat
 * 8K budget on a 131K-context model was hit entirely inside the reasoning
 * channel, ending the turn with no answer at all. Scale with the context
 * window (a quarter of it), bounded so small windows keep the old default
 * and huge windows do not request absurd completions.
 */
export function resolveDefaultMaxOutputTokens(contextWindow: number | undefined): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return MIN_DEFAULT_MAX_OUTPUT_TOKENS;
  const scaled = Math.floor(contextWindow / 4);
  return Math.max(MIN_DEFAULT_MAX_OUTPUT_TOKENS, Math.min(MAX_DEFAULT_MAX_OUTPUT_TOKENS, scaled));
}
