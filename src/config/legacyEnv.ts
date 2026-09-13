const LEGACY_ENV_PREFIX = "CODEXA_";
const ENV_PREFIX = "UBUME_";
// Codexa remains the name of the native model family, so its variables are not aliased.
const MODEL_FAMILY_ENV = /^CODEXA_(NATIVE|CUPY|NUMPY)_/;

/**
 * Pre-rename `CODEXA_*` variables keep working: copy each one into its
 * `UBUME_*` name unless that name is already set. Mutates `env` in place.
 */
export function applyLegacyEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || MODEL_FAMILY_ENV.test(key)) continue;
    const ubumeKey = `${ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[ubumeKey] === undefined) env[ubumeKey] = value;
  }
}
