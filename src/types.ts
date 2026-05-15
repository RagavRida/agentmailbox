export type AgentAddress = string;

export interface Agent {
  id: AgentAddress;
  createdAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  from: AgentAddress;
  to: AgentAddress;
  cc?: AgentAddress[];
  bcc?: AgentAddress[];
  replyTo?: AgentAddress;
  payload: unknown;
  contextSnapshot: Record<string, unknown>;
  timestamp: number;
}

export interface ThreadContext {
  snapshot: Record<string, unknown>;
  threadSummary: string;
  recentMessages: Message[];
  tokenCount: number;
}

export interface ContextFrame {
  id: string;
  threadId: string;
  from: AgentAddress;
  to: AgentAddress;
  cc?: AgentAddress[];
  bcc?: AgentAddress[];
  replyTo?: AgentAddress;
  timestamp: number;
  payload: unknown;
  context: ThreadContext;
}

export interface Thread {
  id: string;
  participants: AgentAddress[];
  silentParticipants: AgentAddress[];
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface Mailbox {
  agentId: AgentAddress;
  threads: string[];
  unreadCount: number;
}

export interface SendOptions {
  threadId?: string;
  contextSnapshot?: Record<string, unknown>;
  cc?: AgentAddress[];
  bcc?: AgentAddress[];
  replyTo?: AgentAddress;
}

export interface ReceiveResult {
  messages: ContextFrame[];
  context: {
    snapshot: Record<string, unknown>;
    threadSummary: string;
    recentMessages: Message[];
  };
}

export interface ParticipantRole {
  agentId: AgentAddress;
  role: "to" | "cc" | "bcc";
  joinedAt: number;
}
