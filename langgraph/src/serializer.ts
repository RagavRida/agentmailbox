import type { SerializerProtocol } from "@langchain/langgraph-checkpoint";

/**
 * LangGraph's serializer returns `[type: string, bytes: Uint8Array]`.
 * agentsmcp's JSON wire format can't carry binary, so we base64-encode
 * the bytes and keep the type tag alongside.
 */

export interface SerializedTyped {
  type: string;
  data: string; // base64
}

export async function dumpToBase64(
  serde: SerializerProtocol,
  value: unknown
): Promise<SerializedTyped> {
  const [type, bytes] = await serde.dumpsTyped(value);
  return { type, data: bytesToBase64(bytes) };
}

export async function loadFromBase64<T = unknown>(
  serde: SerializerProtocol,
  s: SerializedTyped
): Promise<T> {
  const bytes = base64ToBytes(s.data);
  return (await serde.loadsTyped(s.type, bytes)) as T;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Buffer is available everywhere we run (Node 18+).
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
