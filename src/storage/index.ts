import { SqliteStorage } from "./sqlite";
import { Storage, StorageOptions } from "./interface";

export type { Storage, StorageOptions } from "./interface";
export { SqliteStorage } from "./sqlite";

function normalize(opts: string | StorageOptions): StorageOptions {
  return typeof opts === "string" ? { url: opts } : opts;
}

/**
 * Construct a {@link Storage} adapter from a connection string or options
 * object. Today only SQLite is implemented — pass a file path or
 * `":memory:"`. The `postgres://` branch is reserved for a follow-up release.
 *
 * Callers should treat the return value as the {@link Storage} interface;
 * the concrete class is not part of the public API and may change.
 */
export function createStorage(opts: string | StorageOptions): Storage {
  const { url } = normalize(opts);
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    throw new Error(
      "postgres storage is not yet implemented — pin agentmailbox <0.3 and use SQLite, or watch the roadmap for the postgres adapter"
    );
  }
  return new SqliteStorage(url);
}
