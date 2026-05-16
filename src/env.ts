/**
 * Internal helper for the env-var rename from AGENTMAILBOX_* to AGENTSMCP_*.
 * Reads the new name first; falls back to the legacy name and warns once.
 *
 * Legacy names are scheduled for removal in 0.4.0 — this helper exists to
 * give users one minor version to migrate.
 */

const warned = new Set<string>();

export function readEnv(
  newName: string,
  legacyName: string
): string | undefined {
  const fresh = process.env[newName];
  if (fresh !== undefined && fresh !== "") return fresh;

  const legacy = process.env[legacyName];
  if (legacy !== undefined && legacy !== "") {
    if (!warned.has(legacyName)) {
      warned.add(legacyName);
      process.stderr.write(
        `[agentsmcp] ${legacyName} is deprecated; prefer ${newName}. ` +
          `The legacy name will be removed in 0.4.0.\n`
      );
    }
    return legacy;
  }
  return undefined;
}
