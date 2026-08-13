/**
 * Capability tokens declared by THIS source tree.
 *
 * Semver cannot answer "does this artifact support X": version bumps land in a
 * separate release commit, so every build cut between two releases carries the
 * previous version while already containing new behaviour. A token is added in
 * the same commit as the feature it names, travels inside the built artifact
 * (dist/build-info.json), and is therefore the only honest answer to that
 * question — for this process and for any other install on the host.
 *
 * Add a token when a change makes previously-invalid configuration valid, or
 * otherwise changes what an operator's fleet.yaml is allowed to say. Never
 * remove one without also rejecting the configuration it admitted.
 */
/** `monitor.interrupt: after_tool` — cancel at the next tool boundary (#67). */
export const CAP_MONITOR_INTERRUPT_AFTER_TOOL = 'monitor.interrupt.after_tool';

export const CAPABILITIES = [
  CAP_MONITOR_INTERRUPT_AFTER_TOOL,
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Does this build declare `token`? */
export const hasCapability = (token: string): boolean =>
  (CAPABILITIES as readonly string[]).includes(token);
