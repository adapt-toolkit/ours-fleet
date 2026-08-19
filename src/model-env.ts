import type { ResolvedRole } from './config.js';

/**
 * Which environment variable a harness reads to pin the model it RUNS.
 *
 * This is not a convenience: for `claude-code` it is the only channel that
 * reaches the ACP backend at all. `buildLaunch` (tmux) passes `--model`, but
 * `buildAcpLaunch` launches the ACP adapter with no model argument, and that
 * adapter resolves its model in this order — ANTHROPIC_MODEL, then
 * `settings.model`, then a resumed session's live model, then its first
 * catalogue entry. A role's declared model was therefore invisible to every
 * ACP role, and a fleet-wide `defaults.env.ANTHROPIC_MODEL` silently outranked
 * an explicitly requested one.
 */
export const MODEL_ENV_BY_HARNESS: Readonly<Record<string, string>> = {
  'claude-code': 'ANTHROPIC_MODEL',
};

/** The model-pin variable for a harness, or undefined if it pins no model by env. */
export function modelEnvVar(harness: string | undefined): string | undefined {
  return harness === undefined ? undefined : MODEL_ENV_BY_HARNESS[harness];
}

export interface RoleModelEnvInput {
  harness: string;
  /** Already resolved by `resolveRoleModel` — may come from the fleet default. */
  model: string | undefined;
  /** True when the role (or `--model`) named a model, including `model: null`. */
  modelWasExplicit: boolean;
  defaultsEnv?: Record<string, string>;
  roleEnv?: Record<string, string>;
  authProxyBaseUrl?: string;
}

export interface RoleModelEnv {
  env: Record<string, string>;
  /**
   * The model the harness will actually run. Equal to `env[pin]` for a harness
   * that pins by env, so anything reporting this value reports the runtime.
   */
  model: string | undefined;
}

/**
 * Resolve a role's environment and its runtime model TOGETHER, so the two can
 * never disagree.
 *
 * Precedence, highest first:
 *   1. an explicit `model:` / `--model` on the role
 *   2. the role's own `env:` pin
 *   3. the fleet `defaults.model`
 *   4. the fleet `defaults.env` pin
 *
 * Inheriting the fleet default remains correct when the role names no model
 * (2, 3, 4); an explicitly named one wins (1). Where both are explicit and they
 * disagree, there is no defensible winner, so this refuses rather than picking
 * one silently — the silence is what let a day of "Fable" work run on Opus.
 *
 * `model: null` explicitly asks for no fleet-chosen model, so it also clears an
 * inherited pin instead of leaving one in place to act as a hidden default.
 */
export function resolveRoleModelEnv(
  input: RoleModelEnvInput,
  describe: (message: string) => Error = message => new Error(message),
): RoleModelEnv {
  const env: Record<string, string> = {
    ...(input.defaultsEnv ?? {}),
    ...(input.roleEnv ?? {}),
    ...(input.authProxyBaseUrl ? { ANTHROPIC_BASE_URL: input.authProxyBaseUrl } : {}),
  };
  const pin = modelEnvVar(input.harness);
  if (!pin) return { env, model: input.model };

  const rolePin = input.roleEnv?.[pin];
  if (input.modelWasExplicit) {
    if (rolePin !== undefined && rolePin !== input.model)
      throw describe(
        `model '${input.model ?? '(none)'}' contradicts env.${pin} '${rolePin}'; `
        + `remove one — ${pin} is what the harness actually runs`);
    if (input.model === undefined) delete env[pin];
    else env[pin] = input.model;
    return { env, model: input.model };
  }
  // Not explicit: a role-level pin is the most specific thing said about this
  // role, so it decides — and the reported model follows it.
  if (rolePin !== undefined) return { env, model: rolePin };
  if (input.model !== undefined) env[pin] = input.model;
  return { env, model: input.model ?? env[pin] };
}

/**
 * The model a role will actually run, read back from the environment it was
 * resolved with. Use this wherever a model is reported to a human.
 */
export function effectiveRoleModel(role: ResolvedRole): string | undefined {
  const pin = modelEnvVar(role.harness);
  return (pin ? role.env?.[pin] : undefined) ?? role.model;
}

/**
 * Move a role's env pin onto a new model. Anything that changes the model a
 * role runs after resolution — model-chain recovery is the live example — must
 * go through this, or it changes only the label.
 */
export function repinModelEnv(
  role: ResolvedRole, model: string | undefined,
): Record<string, string> | undefined {
  const pin = modelEnvVar(role.harness);
  if (!pin) return role.env;
  const env = { ...(role.env ?? {}) };
  if (model === undefined) delete env[pin];
  else env[pin] = model;
  return Object.keys(env).length ? env : undefined;
}

/**
 * Last line of defence, at the exact point a child's environment is composed:
 * refuse to launch a role whose child would run a model other than the one the
 * role declares and the banner reports. A spawn that cannot keep those two in
 * agreement must fail loudly, not start and be believed.
 */
export function assertModelPinReachesChild(
  role: ResolvedRole, childEnv: Record<string, string | undefined>,
): void {
  const pin = modelEnvVar(role.harness);
  if (!pin || role.model === undefined) return;
  const actual = childEnv[pin];
  if (actual === role.model) return;
  throw new Error(
    `[${role.name}] refusing to launch: role model is '${role.model}' but the child's `
    + `${pin} is ${actual === undefined ? 'unset' : `'${actual}'`} — the session would run a `
    + 'different model than the one reported');
}
