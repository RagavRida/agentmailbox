import { Request, Response, NextFunction } from "express";

export interface RateLimitConfig {
  /** Max distinct agents one IP can register. */
  maxAgentsPerIp: number;
  /** Max messages a single agentId can send per UTC day. */
  maxMessagesPerDay: number;
  /** Max requests per IP per rolling minute. */
  maxRequestsPerMinute: number;
  /**
   * Upgrade link returned in 429 bodies. Override per deploy if you want
   * to point at a custom self-host docs page.
   */
  upgradeUrl?: string;
}

export interface UsageStats {
  agentsRegistered: number;
  agentsLimit: number;
  messagesToday: number;
  messagesLimit: number;
  requestsThisMinute: number;
  requestsLimit: number;
}

interface PerIp {
  agents: Set<string>;
  requestsMinute: number;
  minuteWindowStart: number;
}

interface PerAgent {
  messagesToday: number;
}

const MINUTE_MS = 60 * 1000;

export interface RateLimiterHandle {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  getUsage: (identifier: string) => UsageStats;
  /** Stop the daily-reset timer. Exposed for tests / graceful shutdown. */
  stop: () => void;
}

/**
 * In-memory rate limiter for the free tier. Tracks per-IP and per-agentId
 * counters, resets daily at UTC midnight, and short-circuits with HTTP 429
 * when any limit is exceeded.
 *
 * Skipped paths (always allowed through): `/health`, `/.well-known/*`,
 * `/usage/*`. Self-hosted users bypass the limiter entirely by not setting
 * `CLOUD_MODE=true` — and per the spec, the middleware should not even be
 * mounted when `AGENTSMCP_API_KEY` is configured.
 */
export function createRateLimiter(cfg: RateLimitConfig): RateLimiterHandle {
  const byIp = new Map<string, PerIp>();
  const byAgent = new Map<string, PerAgent>();

  const dailyReset = setInterval(() => {
    byAgent.clear();
    // Don't blow away IP→agents mapping on daily reset; that's a lifetime
    // soft cap, not a daily one. Only the per-minute window is implicitly
    // reset by elapsed time.
  }, msUntilNextUtcMidnight()).unref?.();

  // setInterval drift fix — schedule the *first* reset to land on midnight,
  // then it ticks every 24h thereafter.
  const firstReset = setTimeout(() => {
    byAgent.clear();
  }, msUntilNextUtcMidnight());
  firstReset.unref?.();

  const ipKey = (req: Request): string => {
    // Express respects app.set('trust proxy', ...) when populating req.ip
    return (req.ip ?? req.socket.remoteAddress ?? "unknown").toString();
  };

  const getPerIp = (ip: string): PerIp => {
    let entry = byIp.get(ip);
    if (!entry) {
      entry = { agents: new Set(), requestsMinute: 0, minuteWindowStart: Date.now() };
      byIp.set(ip, entry);
    }
    const now = Date.now();
    if (now - entry.minuteWindowStart >= MINUTE_MS) {
      entry.requestsMinute = 0;
      entry.minuteWindowStart = now;
    }
    return entry;
  };

  const getPerAgent = (agentId: string): PerAgent => {
    let entry = byAgent.get(agentId);
    if (!entry) {
      entry = { messagesToday: 0 };
      byAgent.set(agentId, entry);
    }
    return entry;
  };

  const isSkippedPath = (path: string): boolean => {
    if (path === "/health") return true;
    if (path.startsWith("/.well-known/")) return true;
    if (path.startsWith("/usage/")) return true;
    return false;
  };

  const limitExceeded = (
    res: Response,
    limit: number,
    resetsAt: Date
  ): Response => {
    return res.status(429).json({
      error: "rate_limit_exceeded",
      limit,
      remaining: 0,
      resetsAt: resetsAt.toISOString(),
      upgrade:
        cfg.upgradeUrl ?? "https://github.com/RagavRida/agentsmcp#self-hosted",
    });
  };

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (isSkippedPath(req.path)) return next();

    const ip = ipKey(req);
    const ipEntry = getPerIp(ip);

    ipEntry.requestsMinute += 1;
    if (ipEntry.requestsMinute > cfg.maxRequestsPerMinute) {
      return limitExceeded(
        res,
        cfg.maxRequestsPerMinute,
        new Date(ipEntry.minuteWindowStart + MINUTE_MS)
      );
    }

    if (req.method === "POST" && req.path === "/agents/register") {
      const body = req.body as { agentId?: string } | undefined;
      const agentId = body?.agentId;
      if (agentId) {
        const wouldBeNew = !ipEntry.agents.has(agentId);
        if (wouldBeNew && ipEntry.agents.size >= cfg.maxAgentsPerIp) {
          return limitExceeded(
            res,
            cfg.maxAgentsPerIp,
            nextUtcMidnight()
          );
        }
        ipEntry.agents.add(agentId);
      }
    }

    if (
      req.method === "POST" &&
      (req.path === "/messages/send" || req.path === "/messages/reply-all")
    ) {
      const body = req.body as { from?: string } | undefined;
      const from = body?.from;
      if (from) {
        const agentEntry = getPerAgent(from);
        if (agentEntry.messagesToday >= cfg.maxMessagesPerDay) {
          return limitExceeded(
            res,
            cfg.maxMessagesPerDay,
            nextUtcMidnight()
          );
        }
        agentEntry.messagesToday += 1;
      }
    }

    return next();
  };

  const getUsage = (identifier: string): UsageStats => {
    const ipEntry = byIp.get(identifier);
    const agentEntry = byAgent.get(identifier);
    return {
      agentsRegistered: ipEntry?.agents.size ?? 0,
      agentsLimit: cfg.maxAgentsPerIp,
      messagesToday: agentEntry?.messagesToday ?? 0,
      messagesLimit: cfg.maxMessagesPerDay,
      requestsThisMinute: ipEntry?.requestsMinute ?? 0,
      requestsLimit: cfg.maxRequestsPerMinute,
    };
  };

  const stop = () => {
    clearInterval(dailyReset as unknown as NodeJS.Timeout);
    clearTimeout(firstReset);
  };

  return { middleware, getUsage, stop };
}

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0
    )
  );
}

function msUntilNextUtcMidnight(): number {
  return nextUtcMidnight().getTime() - Date.now();
}
