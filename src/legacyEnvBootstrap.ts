// Side-effect module: entry points import this first so legacy CODEXA_* variables are
// aliased before any other module reads process.env at load time.
import { applyLegacyEnvAliases } from "./config/legacyEnv.js";

applyLegacyEnvAliases();
