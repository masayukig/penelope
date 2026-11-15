// The shape of a sub-agent's name (docs/sandbox-api.md, "`agent` の欄"),
// shared by the runner, which gives the names, and the backend, which checks
// them. It is used as a directory under /sources/self/ and under HOME, so it
// is one path segment.

/** Lower-case letters, digits and `-`, starting with a letter or a digit, up to 63 characters, and not `main`. */
export const SUB_AGENT_NAME = /^(?!main$)[a-z0-9][a-z0-9-]{0,62}$/;

/** Whether `value` is a name a sub-agent may have. */
export function isSubAgentName(value: unknown): value is string {
  return typeof value === "string" && SUB_AGENT_NAME.test(value);
}
