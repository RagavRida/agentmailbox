/**
 * Context-Aware Safety & Guardrails Engine
 *
 * Three-layer safety system:
 *   Layer 1 — Automatic trust graph derived from existing thread/participant data
 *   Layer 2 — Explicit override rules (block/allow patterns)
 *   Layer 3 — Payload regex guardrails
 *
 * The system automatically infers trust from existing communication patterns.
 * Explicit rules are an optional escape hatch for hard policy.
 */

import { AgentAddress } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SafetyRule {
  id: string;
  name: string;
  /** pre-send: checked before message creation. pre-receive: checked when an agent polls unread. */
  type: "pre-send" | "pre-receive";
  /** block: reject matching messages. allow: explicitly permit (overrides low trust). */
  action: "allow" | "block";
  /** Glob pattern for sender address. '*' matches all. */
  senderPattern: string;
  /** Glob pattern for recipient address. '*' matches all. */
  recipientPattern: string;
  /** Optional regex tested against JSON-serialized payload. */
  payloadRegex?: string | null;
  createdAt: number;
}

export interface CommunicationEdge {
  from: string;
  to: string;
  messageCount: number;
  threadCount: number;
  lastMessageAt: number;
}

export interface ContextGraph {
  /** Adjacency list: key = "from|to" → edge data */
  edges: Map<string, CommunicationEdge>;
  /** All known agent addresses */
  agents: Set<string>;
}

export interface SafetyVerdict {
  allowed: boolean;
  trustScore: number;
  flags: string[];
  /** Name of the explicit rule that caused a block/allow override, if any. */
  blockedBy?: string;
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Match an agent address against a pattern with simple wildcard support.
 *
 * Supported patterns:
 *   `*`              — matches everything
 *   `*@domain.com`   — matches any agent at domain.com
 *   `agent@*`        — matches agent at any domain
 *   `exact@match`    — exact equality
 *   `prefix*`        — matches addresses starting with prefix
 */
export function matchesPattern(address: string, pattern: string): boolean {
  if (pattern === "*") return true;

  // Exact match (no wildcards)
  if (!pattern.includes("*")) {
    return address.toLowerCase() === pattern.toLowerCase();
  }

  // Convert pattern to regex
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials except *
    .replace(/\*/g, ".*"); // * → .*

  const re = new RegExp(`^${escaped}$`, "i");
  return re.test(address);
}

// ---------------------------------------------------------------------------
// Trust scoring
// ---------------------------------------------------------------------------

/** Decay constant: interactions older than 30 days contribute less. */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute a trust score between 0 and 1 for a sender→recipient pair
 * based on their communication history in the context graph.
 *
 * Factors:
 *   - Thread count (more shared threads = more trust)
 *   - Message frequency (more messages = more trust)
 *   - Recency (recent interactions score higher)
 *   - Bidirectionality (mutual communication scores higher)
 */
export function computeTrustScore(
  graph: ContextGraph,
  from: AgentAddress,
  to: AgentAddress
): number {
  const forwardKey = `${from}|${to}`;
  const reverseKey = `${to}|${from}`;

  const forward = graph.edges.get(forwardKey);
  const reverse = graph.edges.get(reverseKey);

  if (!forward && !reverse) return 0; // No history at all

  const now = Date.now();

  let score = 0;

  // Thread count contribution (0–0.3)
  const totalThreads = (forward?.threadCount ?? 0) + (reverse?.threadCount ?? 0);
  const threadScore = Math.min(totalThreads / 10, 1) * 0.3;
  score += threadScore;

  // Message count contribution (0–0.3)
  const totalMessages =
    (forward?.messageCount ?? 0) + (reverse?.messageCount ?? 0);
  const messageScore = Math.min(totalMessages / 50, 1) * 0.3;
  score += messageScore;

  // Recency contribution (0–0.2)
  const lastForward = forward?.lastMessageAt ?? 0;
  const lastReverse = reverse?.lastMessageAt ?? 0;
  const lastInteraction = Math.max(lastForward, lastReverse);
  const ageMs = now - lastInteraction;
  const recencyFactor = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
  score += recencyFactor * 0.2;

  // Bidirectionality bonus (0–0.2)
  if (forward && reverse) {
    score += 0.2;
  } else if (forward || reverse) {
    score += 0.1;
  }

  return Math.min(score, 1);
}

// ---------------------------------------------------------------------------
// Context graph builder
// ---------------------------------------------------------------------------

/**
 * Build a context graph from raw communication pair data.
 * The `pairs` argument comes from Storage.getAgentCommunicationPairs().
 */
export function buildContextGraph(pairs: CommunicationEdge[]): ContextGraph {
  const edges = new Map<string, CommunicationEdge>();
  const agents = new Set<string>();

  for (const edge of pairs) {
    const key = `${edge.from}|${edge.to}`;
    edges.set(key, edge);
    agents.add(edge.from);
    agents.add(edge.to);
  }

  return { edges, agents };
}

// ---------------------------------------------------------------------------
// Payload guardrails
// ---------------------------------------------------------------------------

/**
 * Test a serialized payload against a regex pattern.
 * Returns true if the pattern matches (meaning the payload should be flagged).
 */
export function payloadMatchesRegex(
  payload: unknown,
  regex: string
): boolean {
  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    const re = new RegExp(regex, "i");
    return re.test(serialized);
  } catch {
    // Invalid regex → treat as non-match (fail open)
    return false;
  }
}

// ---------------------------------------------------------------------------
// Combined evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate safety for a message. Runs all three layers in priority order:
 *
 *   1. Explicit block rules → hard block (403)
 *   2. Explicit allow rules → override low trust
 *   3. Payload regex guardrails → block if matched
 *   4. Automatic trust scoring → flag if low trust
 */
export function evaluateSafety(
  graph: ContextGraph,
  rules: SafetyRule[],
  hookType: "pre-send" | "pre-receive",
  from: AgentAddress,
  to: AgentAddress,
  payload: unknown
): SafetyVerdict {
  const flags: string[] = [];

  // Filter rules to the relevant hook type
  const activeRules = rules.filter((r) => r.type === hookType);

  // --- Layer 1: Explicit block rules ---
  for (const rule of activeRules) {
    if (rule.action !== "block") continue;
    const senderMatch = matchesPattern(from, rule.senderPattern);
    const recipientMatch = matchesPattern(to, rule.recipientPattern);
    if (senderMatch && recipientMatch) {
      // If the rule also has a payload regex, only block if payload matches
      if (rule.payloadRegex) {
        if (payloadMatchesRegex(payload, rule.payloadRegex)) {
          return {
            allowed: false,
            trustScore: 0,
            flags: [`blocked by rule: ${rule.name}`, "payload_regex_match"],
            blockedBy: rule.name,
          };
        }
        // Payload didn't match → this block rule doesn't apply
        continue;
      }
      return {
        allowed: false,
        trustScore: 0,
        flags: [`blocked by rule: ${rule.name}`],
        blockedBy: rule.name,
      };
    }
  }

  // --- Layer 2: Explicit allow rules ---
  let explicitlyAllowed = false;
  for (const rule of activeRules) {
    if (rule.action !== "allow") continue;
    const senderMatch = matchesPattern(from, rule.senderPattern);
    const recipientMatch = matchesPattern(to, rule.recipientPattern);
    if (senderMatch && recipientMatch) {
      explicitlyAllowed = true;
      flags.push(`explicitly allowed by rule: ${rule.name}`);
      break;
    }
  }

  // --- Layer 3: Payload regex guardrails (standalone, not attached to a rule) ---
  for (const rule of activeRules) {
    if (rule.action !== "block" || !rule.payloadRegex) continue;
    // We already checked address-matching block rules above.
    // This handles catch-all payload rules (sender/recipient = *)
    if (
      rule.senderPattern === "*" &&
      rule.recipientPattern === "*" &&
      payloadMatchesRegex(payload, rule.payloadRegex)
    ) {
      return {
        allowed: false,
        trustScore: 0,
        flags: [`payload blocked by guardrail: ${rule.name}`],
        blockedBy: rule.name,
      };
    }
  }

  // --- Layer 4: Automatic trust scoring ---
  const trustScore = computeTrustScore(graph, from, to);

  if (!graph.agents.has(from)) flags.push("unknown_sender");
  if (!graph.agents.has(to)) flags.push("unknown_recipient");
  if (trustScore === 0) flags.push("first_contact");
  if (trustScore > 0 && trustScore < 0.5) flags.push("low_trust");

  // Explicit allow overrides low trust
  if (explicitlyAllowed) {
    return { allowed: true, trustScore: Math.max(trustScore, 0.5), flags };
  }

  // Default: allow with flags (graduated response)
  return { allowed: true, trustScore, flags };
}
