#!/usr/bin/env node
import { timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { createStorage, Storage } from "./storage";
import { Compressor, NoopCompressor } from "./compression";
import { assembleContext } from "./context";
import { readEnv } from "./env";
import {
  createRateLimiter,
  RateLimiterHandle,
  RateLimitConfig,
} from "./ratelimit";
import {
  cloudAuth,
  enforceAgentCap,
  enforceMessageCap,
  recordMessageSent,
} from "./cloud/middleware";
import {
  createUser,
  createAdditionalKey,
  revokeKey,
  listKeys,
  getUser,
  getPlanLimits,
  PgPoolLike,
  AuthError,
  findOrCreateGitHubUser,
  signSession,
  verifySession,
} from "./cloud/auth";
import { PostgresStorage } from "./storage/postgres";
import {
  AgentAddress,
  AgentCard,
  AgentCardSkill,
  ContextFrame,
  Message,
  ParticipantRole,
  Thread,
} from "./types";

const DEFAULT_CLOUD_RATE_LIMITS: RateLimitConfig = {
  maxAgentsPerIp: 10,
  maxMessagesPerDay: 500,
  maxRequestsPerMinute: 60,
};

const DEFAULT_CLOUD_CORS_ORIGINS = [
  // Live marketing site + legacy alias
  "https://agentmailbox.vercel.app",
  "https://freqooo.vercel.app",
  // Dev origin
  "http://localhost:5173",
  // Legacy .com placeholders kept for backward compatibility with any
  // references that pre-date the .vercel.app rename.
  "https://dashboard.agentsmcp.com",
  "https://agentsmcp.com",
];

let cachedPackageVersion: string | null = null;
function getPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8")
    ) as { version?: string };
    cachedPackageVersion = pkg.version ?? "unknown";
  } catch {
    cachedPackageVersion = "unknown";
  }
  return cachedPackageVersion;
}

function getBaseUrl(req: Request): string {
  const fromEnv = readEnv("AGENTSMCP_BASE_URL", "AGENTMAILBOX_BASE_URL");
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

const SERVER_SKILLS: AgentCardSkill[] = [
  {
    id: "send-message",
    name: "Send Message",
    description:
      "Send a message to another agent with optional CC/BCC recipients and context snapshot",
    inputSchema: {
      type: "object",
      required: ["from", "to", "payload"],
      properties: {
        from: { type: "string", minLength: 1 },
        to: { type: "string", minLength: 1 },
        payload: {},
        contextSnapshot: { type: "object", additionalProperties: true },
        threadId: { type: "string" },
        cc: { type: "array", items: { type: "string", minLength: 1 } },
        bcc: { type: "array", items: { type: "string", minLength: 1 } },
        replyTo: { type: "string", minLength: 1 },
      },
    },
    outputSchema: {
      type: "object",
      required: ["messageId", "threadId", "deliveredTo"],
      properties: {
        messageId: { type: "string" },
        threadId: { type: "string" },
        deliveredTo: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    id: "receive-messages",
    name: "Receive Messages",
    description:
      "Get unread messages with full thread context (snapshot, summary, recent messages)",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      required: ["messages"],
      properties: {
        messages: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    id: "sync-thread",
    name: "Sync Thread",
    description: "Rejoin a thread and get the full assembled context frame",
    inputSchema: {
      type: "object",
      required: ["threadId"],
      properties: { threadId: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      required: ["context"],
      properties: { context: { type: "object" } },
    },
  },
  {
    id: "reply-all",
    name: "Reply All",
    description: "Reply to every visible participant on a thread",
    inputSchema: {
      type: "object",
      required: ["from", "threadId", "payload"],
      properties: {
        from: { type: "string", minLength: 1 },
        threadId: { type: "string", minLength: 1 },
        payload: {},
        contextSnapshot: { type: "object", additionalProperties: true },
      },
    },
    outputSchema: {
      type: "object",
      required: ["messageId", "threadId", "deliveredTo"],
      properties: {
        messageId: { type: "string" },
        threadId: { type: "string" },
        deliveredTo: { type: "array", items: { type: "string" } },
      },
    },
  },
];

function buildServerCard(baseUrl: string, authRequired: boolean): AgentCard {
  return {
    name: "AgentMailbox",
    description:
      "Context-sync protocol for AI agents. Durable threads with cold-restart, context compression, and email-like semantics (TO/CC/BCC/ReplyAll).",
    url: baseUrl,
    version: getPackageVersion(),
    capabilities: {
      messaging: true,
      threading: true,
      contextCompression: true,
      coldRestart: true,
      multiAgent: true,
    },
    skills: SERVER_SKILLS,
    provider: {
      organization: "AgentMailbox",
      url: "https://github.com/RagavRida/agentsmcp",
    },
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
    authentication: authRequired ? "required" : "none",
  };
}

const RegisterSchema = z.object({
  agentId: z.string().min(1),
});

const SendSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  payload: z.unknown(),
  contextSnapshot: z.record(z.unknown()).optional(),
  threadId: z.string().optional(),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  replyTo: z.string().min(1).optional(),
});

const ReplyAllSchema = z.object({
  from: z.string().min(1),
  threadId: z.string().min(1),
  payload: z.unknown(),
  contextSnapshot: z.record(z.unknown()).optional(),
});

const MarkReadSchema = z.object({
  threadId: z.string().min(1),
});

function stripBccFromMessage(m: Message, requester: AgentAddress): Message {
  if (m.from === requester) return m;
  if (!m.bcc || m.bcc.length === 0) return m;
  const { bcc: _bcc, ...rest } = m;
  return rest;
}

function stripBccFromMessages(
  messages: Message[],
  requester: AgentAddress
): Message[] {
  return messages.map((m) => stripBccFromMessage(m, requester));
}

function stripBccFromFrame(
  frame: ContextFrame,
  requester: AgentAddress
): ContextFrame {
  const stripped: ContextFrame = { ...frame };
  if (frame.from !== requester && frame.bcc) delete stripped.bcc;
  stripped.context = {
    ...frame.context,
    recentMessages: stripBccFromMessages(frame.context.recentMessages, requester),
  };
  return stripped;
}

function stripBccFromThread(t: Thread, requester: AgentAddress): Thread {
  return {
    ...t,
    silentParticipants: requester && t.silentParticipants.includes(requester)
      ? t.silentParticipants
      : [],
    messages: stripBccFromMessages(t.messages, requester),
  };
}

function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CreateServerOptions {
  apiKey?: string;
  /**
   * Compressor used to fold older messages into a structured summary.
   * Defaults to {@link NoopCompressor} — keeps zero-config installs
   * working without any LLM dependency.
   */
  compressor?: Compressor;
  /**
   * Compress only once this many older (beyond the verbatim window)
   * messages have accumulated since the last summary. Defaults to 20.
   */
  compressionThreshold?: number;
  /**
   * Enable hosted-tier behaviour: trust-proxy, CORS, per-IP/per-agent rate
   * limits, and the /usage/:identifier endpoint. Defaults to the value of
   * the `CLOUD_MODE` env var. Self-hosted users leave this off.
   */
  cloudMode?: boolean;
  /** Override the default cloud-tier limits when cloudMode is on. */
  rateLimits?: Partial<RateLimitConfig>;
  /** Override the default cloud-tier CORS origins. */
  corsOrigins?: string[];
}

export interface CreateServerResult {
  app: express.Express;
  storage: Storage;
  ready: Promise<void>;
  rateLimiter?: RateLimiterHandle;
}

export function createServer(
  dbPath = "agentmailbox.db",
  opts: CreateServerOptions = {}
): CreateServerResult {
  const storage = createStorage(dbPath);
  const ready = storage.init();

  const apiKey =
    opts.apiKey ?? readEnv("AGENTSMCP_API_KEY", "AGENTMAILBOX_API_KEY") ?? "";
  const compressor = opts.compressor ?? new NoopCompressor();
  const compressionThreshold = opts.compressionThreshold;

  const cloudMode =
    opts.cloudMode ??
    ((readEnv("CLOUD_MODE", "AGENTSMCP_CLOUD_MODE") ?? "")
      .toLowerCase()
      .match(/^(1|true|yes|on)$/) !== null);

  const app = express();

  if (cloudMode) {
    // App Runner / any HTTPS-fronted load balancer forwards client IP via
    // X-Forwarded-For. Required for the rate limiter to see real client IPs.
    app.set("trust proxy", true);

    app.use(
      cors({
        origin: opts.corsOrigins ?? DEFAULT_CLOUD_CORS_ORIGINS,
        credentials: true,
      })
    );
  }

  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Agent Cards (A2A v1.0). Public discovery — no auth, per spec.
  app.get("/.well-known/agent-card.json", (req: Request, res: Response) => {
    return res.status(200).json(buildServerCard(getBaseUrl(req), Boolean(apiKey)));
  });

  app.get(
    "/.well-known/agent-card/:agentId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const agentId = req.params.agentId;
        const agent = await storage.getAgent(agentId);
        if (!agent) return res.status(404).json({ error: "agent not found" });

        const baseUrl = getBaseUrl(req);
        const mailbox = await storage.getMailbox(agentId);
        const card: AgentCard = {
          name: agentId,
          description: `Registered agent on this AgentMailbox instance (${mailbox.threads.length} thread(s)).`,
          url: `${baseUrl}/mailbox/${encodeURIComponent(agentId)}`,
          version: getPackageVersion(),
          capabilities: {
            messaging: true,
            threading: true,
            coldRestart: true,
          },
          provider: {
            organization: "AgentMailbox",
            url: "https://github.com/RagavRida/agentsmcp",
          },
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
          },
          authentication: apiKey ? "required" : "none",
          agentId,
          createdAt: agent.createdAt,
          threadCount: mailbox.threads.length,
          unreadCount: mailbox.unreadCount,
          endpoints: {
            mailbox: `${baseUrl}/mailbox/${encodeURIComponent(agentId)}`,
            unread: `${baseUrl}/mailbox/${encodeURIComponent(agentId)}/unread`,
            markRead: `${baseUrl}/mailbox/${encodeURIComponent(agentId)}/read`,
          },
        };
        return res.status(200).json(card);
      } catch (e) {
        next(e);
      }
    }
  );

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    if (!apiKey) return next();
    if (req.path === "/health") return next();
    const header = req.header("authorization") ?? "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const token = header.slice(prefix.length);
    if (!bearerMatches(token, apiKey)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  };
  app.use(requireApiKey);

  // Cloud-tier rate limiting. Spec: skip entirely when AGENTSMCP_API_KEY is
  // set (self-hosted operator) — they're past the soft caps by definition.
  let rateLimiter: RateLimiterHandle | undefined;
  if (cloudMode && !apiKey) {
    rateLimiter = createRateLimiter({
      ...DEFAULT_CLOUD_RATE_LIMITS,
      ...opts.rateLimits,
    });
    app.use(rateLimiter.middleware);
  }

  // GET /usage/:identifier — current soft-limit usage. Mounted only when
  // the limiter is active so /usage isn't exposed on self-hosted deploys.
  if (rateLimiter) {
    app.get("/usage/:identifier", (req: Request, res: Response) => {
      return res.status(200).json(rateLimiter!.getUsage(req.params.identifier));
    });
  }

  // ---------- Cloud-tier multi-tenant auth ----------
  //
  // When CLOUD_MODE is on AND we have a Postgres-backed storage (the only
  // adapter that can host multi-tenant data today), mount the per-user
  // Bearer auth layer. Single-key self-hosted users (`AGENTSMCP_API_KEY`
  // set) skip this entirely — they're already past the trust boundary.
  if (cloudMode && !apiKey && storage instanceof PostgresStorage) {
    const pgStorage = storage;
    // Lazy: pg.Pool isn't constructed until the first request that needs
    // it, so createServer() can stay synchronous.
    let resolvedPool: PgPoolLike | null = null;
    const getPool = async (): Promise<PgPoolLike> => {
      if (!resolvedPool) {
        resolvedPool = (await pgStorage.getRawPool()) as unknown as PgPoolLike;
      }
      return resolvedPool;
    };
    const cloudPool: PgPoolLike = {
      query: async (text, params) => (await getPool()).query(text, params),
      connect: async () => (await getPool()).connect(),
    };
    const cloudOpts = { pool: cloudPool };

    // /auth/register is intentionally registered BEFORE cloudAuth so signup
    // doesn't require a key. cloudAuth's skip-list also includes it as
    // defence-in-depth.
    app.post("/auth/register", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { email, name } = (req.body ?? {}) as {
          email?: string;
          name?: string;
        };
        if (!email) return res.status(400).json({ error: "email_required" });
        const created = await createUser(cloudPool!, email, { name });
        return res.status(201).json(created);
      } catch (e) {
        if (e instanceof AuthError) {
          return res.status(e.status).json({ error: e.code });
        }
        next(e);
      }
    });

    // ---------- GitHub OAuth (also pre-auth: no Bearer required) ----------
    const githubClientId = process.env.GITHUB_CLIENT_ID;
    const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
    const githubCallbackUrl =
      process.env.GITHUB_CALLBACK_URL ??
      "https://hdnxa5c8yr.us-east-1.awsapprunner.com/auth/github/callback";
    const frontendUrl =
      process.env.FRONTEND_URL ?? "https://agentmailbox.vercel.app";
    const sessionSecret = process.env.SESSION_SECRET;
    const githubReady =
      Boolean(githubClientId) &&
      Boolean(githubClientSecret) &&
      Boolean(sessionSecret);

    if (!githubReady) {
      console.warn(
        "[agentsmcp] GitHub OAuth env vars missing; /auth/github routes will 503"
      );
    }

    // GET /auth/github — kick off OAuth. State cookie defends against CSRF
    // on the callback (verified inside /auth/github/callback below).
    app.get("/auth/github", (_req: Request, res: Response) => {
      if (!githubReady) {
        return res.status(503).json({ error: "github_oauth_not_configured" });
      }
      const state = require("crypto").randomBytes(24).toString("hex");
      // 10-minute httpOnly cookie. Browsers only send it back to our same
      // host on the callback, so it's a reliable CSRF defence even though
      // we're cross-site from the frontend's perspective.
      res.cookie?.("ghoauth_state", state, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 10 * 60 * 1000,
        path: "/auth/github",
      });
      // Express doesn't have res.cookie unless cookie-parser / setHeader is
      // used. Fallback to manual Set-Header for compatibility.
      res.setHeader(
        "Set-Cookie",
        `ghoauth_state=${state}; Max-Age=600; Path=/auth/github; HttpOnly; Secure; SameSite=Lax`
      );

      const params = new URLSearchParams({
        client_id: githubClientId!,
        redirect_uri: githubCallbackUrl,
        scope: "read:user user:email",
        state,
        allow_signup: "true",
      });
      return res.redirect(
        `https://github.com/login/oauth/authorize?${params.toString()}`
      );
    });

    // GET /auth/github/callback — exchange code for token, look up user,
    // sign a JWT, redirect to frontend.
    app.get(
      "/auth/github/callback",
      async (req: Request, res: Response, next: NextFunction) => {
        if (!githubReady) {
          return res.status(503).json({ error: "github_oauth_not_configured" });
        }
        try {
          const { code, state, error } = req.query as {
            code?: string;
            state?: string;
            error?: string;
          };
          if (error) {
            return res.redirect(`${frontendUrl}/?auth_error=${encodeURIComponent(error)}`);
          }
          if (!code) {
            return res.redirect(`${frontendUrl}/?auth_error=missing_code`);
          }

          // CSRF check: state cookie must match the state echoed back by GitHub.
          const cookieHeader = req.headers.cookie ?? "";
          const stateCookie = cookieHeader
            .split(";")
            .map((c) => c.trim())
            .find((c) => c.startsWith("ghoauth_state="))
            ?.slice("ghoauth_state=".length);
          if (!stateCookie || !state || stateCookie !== state) {
            return res.redirect(`${frontendUrl}/?auth_error=state_mismatch`);
          }

          // Exchange code → access_token.
          const tokenRes = await fetch(
            "https://github.com/login/oauth/access_token",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": "agentsmcp",
              },
              body: JSON.stringify({
                client_id: githubClientId,
                client_secret: githubClientSecret,
                code,
                redirect_uri: githubCallbackUrl,
              }),
            }
          );
          const tokenJson = (await tokenRes.json()) as {
            access_token?: string;
            error?: string;
          };
          if (!tokenJson.access_token) {
            return res.redirect(
              `${frontendUrl}/?auth_error=${encodeURIComponent(tokenJson.error ?? "token_exchange_failed")}`
            );
          }
          const accessToken = tokenJson.access_token;

          // Fetch profile + email in parallel.
          const ghHeaders = {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "agentsmcp",
            Accept: "application/vnd.github+json",
          };
          const [userRes, emailsRes] = await Promise.all([
            fetch("https://api.github.com/user", { headers: ghHeaders }),
            fetch("https://api.github.com/user/emails", { headers: ghHeaders }),
          ]);
          if (!userRes.ok) {
            return res.redirect(`${frontendUrl}/?auth_error=gh_user_fetch_failed`);
          }
          const ghUser = (await userRes.json()) as {
            id: number;
            login: string;
            name?: string;
            email?: string;
            avatar_url?: string;
          };
          let primaryEmail: string | undefined;
          if (emailsRes.ok) {
            const emails = (await emailsRes.json()) as Array<{
              email: string;
              primary: boolean;
              verified: boolean;
            }>;
            primaryEmail =
              emails.find((e) => e.primary && e.verified)?.email ??
              emails.find((e) => e.primary)?.email;
          }
          primaryEmail = primaryEmail ?? ghUser.email ?? undefined;
          if (!primaryEmail) {
            return res.redirect(
              `${frontendUrl}/?auth_error=no_verified_email`
            );
          }

          const { userId, apiKey, isNew } = await findOrCreateGitHubUser(
            cloudPool!,
            {
              githubId: ghUser.id,
              githubLogin: ghUser.login,
              email: primaryEmail,
              name: ghUser.name ?? null,
              avatarUrl: ghUser.avatar_url ?? null,
            }
          );

          const token = signSession({ userId, githubLogin: ghUser.login }, sessionSecret!);

          // Clear the state cookie now that we've validated it.
          res.setHeader(
            "Set-Cookie",
            "ghoauth_state=; Max-Age=0; Path=/auth/github; HttpOnly; Secure; SameSite=Lax"
          );

          const dashboardParams = new URLSearchParams({ token });
          // Only surface the freshly-minted API key on first-time signup so
          // the dashboard can show the one-time copy banner. Returning users
          // see their key list via /auth/keys after sign-in.
          if (isNew && apiKey) dashboardParams.set("apiKey", apiKey);
          return res.redirect(
            `${frontendUrl}/dashboard?${dashboardParams.toString()}`
          );
        } catch (e) {
          next(e);
        }
      }
    );

    // GET /auth/session — validate a JWT, return user profile + keys + usage.
    // Authenticated by JWT (NOT a sk_live_ key) so it can't be confused with
    // the API-key auth used everywhere else.
    app.get("/auth/session", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!sessionSecret) {
          return res.status(503).json({ error: "session_not_configured" });
        }
        const header = req.header("authorization") ?? "";
        if (!header.startsWith("Bearer ")) {
          return res.status(401).json({ error: "session_required" });
        }
        const token = header.slice("Bearer ".length).trim();
        const payload = verifySession(token, sessionSecret);
        if (!payload) {
          return res.status(401).json({ error: "session_expired" });
        }

        const user = await getUser(cloudPool!, payload.userId);
        if (!user) return res.status(404).json({ error: "user_not_found" });

        const limits = await getPlanLimits(cloudPool!, user.plan);
        const keys = await listKeys(cloudPool!, payload.userId);

        const counts = await cloudPool!.query<{
          agents: string;
          threads: string;
          msgs_today: string | null;
          github_login: string | null;
          avatar_url: string | null;
        }>(
          `SELECT
             (SELECT COUNT(*)::text FROM agents  WHERE user_id = $1) AS agents,
             (SELECT COUNT(*)::text FROM threads WHERE user_id = $1) AS threads,
             (SELECT count::text FROM usage_metrics
                WHERE user_id = $1
                  AND metric = 'messages_sent'
                  AND period_start = CURRENT_DATE) AS msgs_today,
             (SELECT github_login FROM users WHERE id = $1) AS github_login,
             (SELECT avatar_url   FROM users WHERE id = $1) AS avatar_url`,
          [payload.userId]
        );
        const row = counts.rows[0] ?? {
          agents: "0",
          threads: "0",
          msgs_today: null,
          github_login: null,
          avatar_url: null,
        };

        return res.status(200).json({
          user: {
            id: user.userId,
            email: user.email,
            name: user.name,
            plan: user.plan,
            githubLogin: row.github_login,
            avatarUrl: row.avatar_url,
            createdAt: user.createdAt,
          },
          keys,
          usage: {
            agents: Number(row.agents),
            maxAgents: limits?.maxAgents ?? null,
            threads: Number(row.threads),
            maxThreads: limits?.maxThreads ?? null,
            messagesToday: Number(row.msgs_today ?? 0),
            maxMessagesPerDay: limits?.maxMessagesPerDay ?? null,
          },
        });
      } catch (e) {
        next(e);
      }
    });

    // Mount the API-key auth AFTER the OAuth + session routes so those
    // stay pre-auth.
    app.use(cloudAuth(cloudOpts));

    // /auth/me — caller's profile + current usage snapshot.
    app.get("/auth/me", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.userId) return res.status(401).json({ error: "invalid_api_key" });
        const user = await getUser(cloudPool!, req.userId);
        if (!user) return res.status(404).json({ error: "user_not_found" });
        const limits = await getPlanLimits(cloudPool!, user.plan);

        const counts = await cloudPool!.query<{
          agents: string;
          threads: string;
          msgs_today: string | null;
        }>(
          `SELECT
             (SELECT COUNT(*)::text FROM agents  WHERE user_id = $1) AS agents,
             (SELECT COUNT(*)::text FROM threads WHERE user_id = $1) AS threads,
             (SELECT count::text FROM usage_metrics
                WHERE user_id = $1
                  AND metric = 'messages_sent'
                  AND period_start = CURRENT_DATE) AS msgs_today`,
          [req.userId]
        );
        const row = counts.rows[0] ?? { agents: "0", threads: "0", msgs_today: null };
        return res.status(200).json({
          ...user,
          usage: {
            agents: Number(row.agents),
            maxAgents: limits?.maxAgents ?? null,
            threads: Number(row.threads),
            maxThreads: limits?.maxThreads ?? null,
            messagesToday: Number(row.msgs_today ?? 0),
            maxMessagesPerDay: limits?.maxMessagesPerDay ?? null,
          },
        });
      } catch (e) {
        next(e);
      }
    });

    // GET /auth/keys — list active keys (never returns the full key/hash).
    app.get("/auth/keys", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.userId) return res.status(401).json({ error: "invalid_api_key" });
        const keys = await listKeys(cloudPool!, req.userId);
        return res.status(200).json({ keys });
      } catch (e) {
        next(e);
      }
    });

    // POST /auth/keys — mint an additional key, capped at plan.max_api_keys.
    app.post("/auth/keys", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.userId || !req.planLimits) {
          return res.status(401).json({ error: "invalid_api_key" });
        }
        const { name } = (req.body ?? {}) as { name?: string };

        const existing = await listKeys(cloudPool!, req.userId);
        const cap = req.planLimits.maxApiKeys;
        if (cap >= 0 && existing.length >= cap) {
          return res.status(403).json({
            error: "plan_limit",
            resource: "api_keys",
            current: existing.length,
            limit: cap,
            upgrade: "https://agentsmcp.com/pricing",
          });
        }
        const created = await createAdditionalKey(cloudPool!, req.userId, name || "default");
        return res.status(201).json(created);
      } catch (e) {
        next(e);
      }
    });

    // DELETE /auth/keys/:keyId — revoke (soft delete). When authenticated via
    // API key, refuses to revoke the key being used. JWT sessions have no such
    // restriction since they don't use an API key for auth.
    app.delete("/auth/keys/:keyId", async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.userId) {
          return res.status(401).json({ error: "invalid_api_key" });
        }
        // JWT session auth: apiKeyId is undefined — skip the self-revoke guard.
        const currentKeyId = req.apiKeyId ?? "__session__";
        const ok = await revokeKey(cloudPool!, req.params.keyId, req.userId, currentKeyId);
        if (!ok) return res.status(404).json({ error: "key_not_found" });
        return res.status(200).json({ ok: true });
      } catch (e) {
        if (e instanceof AuthError) {
          return res.status(e.status).json({ error: e.code });
        }
        next(e);
      }
    });
  }

  // Helper: in CLOUD_MODE the auth middleware attaches a ScopedStorage as
  // `req.storage`; self-hosted requests fall back to the unscoped global.
  const storageFor = (req: Request): Storage => req.storage ?? storage;

  // Plan-cap middleware factory — only mounted when CLOUD_MODE is on and
  // the storage backend is Postgres. We build a lazy proxy pool so callers
  // don't depend on createServer being async.
  const buildLazyPool = (pgStorage: PostgresStorage): PgPoolLike => ({
    query: async (text: string, params?: unknown[]) =>
      (await pgStorage.getRawPool()).query(text, params),
    connect: async () => (await pgStorage.getRawPool()).connect(),
  });
  const planLazyPool =
    cloudMode && !apiKey && storage instanceof PostgresStorage
      ? buildLazyPool(storage)
      : null;
  const planCapAgents = planLazyPool
    ? enforceAgentCap({ pool: planLazyPool })
    : (_req: Request, _res: Response, next: NextFunction) => next();
  const planCapMessages = planLazyPool
    ? enforceMessageCap({ pool: planLazyPool })
    : (_req: Request, _res: Response, next: NextFunction) => next();

  // POST /agents/register
  app.post("/agents/register", planCapAgents, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const s = storageFor(req);
      const existing = await s.getAgent(parsed.data.agentId);
      const agent = await s.registerAgent(parsed.data.agentId);
      return res.status(201).json({
        agentId: agent.id,
        created: !existing,
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /messages/send
  app.post("/messages/send", planCapMessages, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const { from, to, payload, contextSnapshot, threadId, cc, bcc, replyTo } =
        parsed.data;
      const s = storageFor(req);

      await s.registerAgent(from);
      await s.registerAgent(to);
      for (const a of cc ?? []) await s.registerAgent(a);
      for (const a of bcc ?? []) await s.registerAgent(a);

      let thread: Thread | null = null;
      if (threadId) {
        thread = await s.getThread(threadId);
        if (!thread) {
          return res.status(404).json({ error: `thread ${threadId} not found` });
        }
      } else {
        const visibleSet = [from, to, ...(cc ?? [])];
        thread = await s.getThreadByParticipantSet(visibleSet);
        if (!thread) thread = await s.createThread(visibleSet, bcc ?? []);
      }

      const message: Message = {
        id: uuidv4(),
        threadId: thread.id,
        from,
        to,
        payload,
        contextSnapshot: contextSnapshot ?? {},
        timestamp: Date.now(),
      };
      if (cc && cc.length > 0) message.cc = cc;
      if (bcc && bcc.length > 0) message.bcc = bcc;
      if (replyTo) message.replyTo = replyTo;

      await s.appendMessage(thread.id, message);

      // Cloud-tier usage counter. Best-effort; failure here must not undo
      // the message that already landed.
      if (req.userId && storage instanceof PostgresStorage) {
        const pool = await storage.getRawPool();
        recordMessageSent(pool as unknown as PgPoolLike, req.userId).catch(
          (err) => console.error("[agentsmcp] usage_metrics upsert failed:", err)
        );
      }

      const deliveredTo = Array.from(
        new Set<AgentAddress>([to, ...(cc ?? []), ...(bcc ?? [])])
      ).filter((a) => a !== from);

      return res.status(200).json({
        messageId: message.id,
        threadId: thread.id,
        deliveredTo,
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /messages/reply-all
  app.post("/messages/reply-all", planCapMessages, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ReplyAllSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const { from, threadId, payload, contextSnapshot } = parsed.data;
      const s = storageFor(req);

      const thread = await s.getThread(threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });

      await s.registerAgent(from);

      const visible = thread.participants.filter((p) => p !== from);
      if (visible.length === 0) {
        return res
          .status(400)
          .json({ error: "no other visible participants to reply to" });
      }

      const [primary, ...rest] = visible;
      const message: Message = {
        id: uuidv4(),
        threadId,
        from,
        to: primary,
        payload,
        contextSnapshot: contextSnapshot ?? {},
        timestamp: Date.now(),
      };
      if (rest.length > 0) message.cc = rest;

      await s.appendMessage(threadId, message);

      if (req.userId && storage instanceof PostgresStorage) {
        const pool = await storage.getRawPool();
        recordMessageSent(pool as unknown as PgPoolLike, req.userId).catch(
          (err) => console.error("[agentsmcp] usage_metrics upsert failed:", err)
        );
      }

      const deliveredTo = visible;
      return res.status(200).json({
        messageId: message.id,
        threadId,
        deliveredTo,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId
  app.get("/mailbox/:agentId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const s = storageFor(req);
      const mailbox = await s.getMailbox(agentId);
      const threadsRaw = await Promise.all(
        mailbox.threads.map((tid) => s.getThread(tid))
      );
      const threads: Thread[] = threadsRaw
        .filter((t): t is Thread => t !== null)
        .map((t) => stripBccFromThread(t, agentId));
      return res.status(200).json({
        threads,
        unreadCount: mailbox.unreadCount,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId/unread
  app.get("/mailbox/:agentId/unread", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const s = storageFor(req);
      const unread = await s.getUnread(agentId);
      const frames: ContextFrame[] = await Promise.all(
        unread.map(async (m) => {
          const allMessages = await s.getMessages(m.threadId);
          const context = await assembleContext(allMessages, {
            threadId: m.threadId,
            storage: s,
            compressor,
            compressionThreshold,
          });
          const frame: ContextFrame = {
            id: m.id,
            threadId: m.threadId,
            from: m.from,
            to: m.to,
            timestamp: m.timestamp,
            payload: m.payload,
            context,
          };
          if (m.cc) frame.cc = m.cc;
          if (m.bcc) frame.bcc = m.bcc;
          if (m.replyTo) frame.replyTo = m.replyTo;
          return stripBccFromFrame(frame, agentId);
        })
      );
      return res.status(200).json({ messages: frames });
    } catch (e) {
      next(e);
    }
  });

  // POST /mailbox/:agentId/read
  app.post("/mailbox/:agentId/read", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const parsed = MarkReadSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      await storageFor(req).markRead(agentId, parsed.data.threadId);
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId
  app.get("/threads/:threadId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const thread = await storageFor(req).getThread(req.params.threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });
      const requester = (req.query.as as string | undefined) ?? "";
      return res.status(200).json({ thread: stripBccFromThread(thread, requester) });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId/sync
  app.get("/threads/:threadId/sync", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const s = storageFor(req);
      const thread = await s.getThread(req.params.threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });
      const requester = (req.query.as as string | undefined) ?? "";
      const ctx = await assembleContext(thread.messages, {
        threadId: thread.id,
        storage: s,
        compressor,
        compressionThreshold,
      });
      const responseContext: Record<string, unknown> = {
        snapshot: ctx.snapshot,
        threadSummary: ctx.threadSummary,
        recentMessages: stripBccFromMessages(ctx.recentMessages, requester),
        tokenCount: ctx.tokenCount,
      };
      if (ctx.threadSummaryStructured) {
        responseContext.threadSummaryStructured = ctx.threadSummaryStructured;
      }
      return res.status(200).json({ context: responseContext });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId/participants
  app.get("/threads/:threadId/participants", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const threadId = req.params.threadId;
      const s = storageFor(req);
      const thread = await s.getThread(threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });

      const requester = (req.query.as as string | undefined) ?? "";
      const roles = await s.getThreadParticipants(threadId);

      // Determine which BCC agents the requester can see.
      // Rule: requester sees a BCC participant iff requester is the sender of
      // any message that included that agent in BCC, OR requester IS that BCC agent.
      const messages = thread.messages;
      const bccVisibleToRequester = new Set<string>();
      for (const m of messages) {
        if (!m.bcc) continue;
        if (m.from === requester) {
          for (const a of m.bcc) bccVisibleToRequester.add(a);
        }
      }
      if (requester) bccVisibleToRequester.add(requester);

      const filtered: ParticipantRole[] = roles.filter((p) => {
        if (p.role !== "bcc") return true;
        return bccVisibleToRequester.has(p.agentId);
      });

      return res.status(200).json({ participants: filtered });
    } catch (e) {
      next(e);
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[agentsmcp] error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  });

  return { app, storage, ready, rateLimiter };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  const dbPath =
    readEnv("AGENTSMCP_DB", "AGENTMAILBOX_DB") ?? "agentmailbox.db";
  const { app, ready } = createServer(dbPath);
  ready
    .then(() => {
      app.listen(port, () => {
        console.log(`[agentsmcp] server listening on http://localhost:${port}`);
        console.log(`[agentsmcp] db: ${dbPath}`);
      });
    })
    .catch((e) => {
      console.error("[agentsmcp] failed to initialize storage:", e);
      process.exit(1);
    });
}
