export { AgentMailbox, AgentMailboxConfig } from "./agentmailbox";
export { createStorage, SqliteStorage } from "./storage";
export type { Storage, StorageOptions } from "./storage";
export { createServer } from "./server";
export { assembleContext } from "./context";
export * from "./types";

/**
 * @deprecated Renamed to {@link SqliteStorage}. The class is also now async —
 * every method returns a Promise. Prefer {@link createStorage} for new code.
 * This alias will be removed in 0.3.0.
 */
export { SqliteStorage as AgentMailboxStorage } from "./storage";
