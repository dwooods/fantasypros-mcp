import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  FANTASYPROS_API_KEY: string;
  MCP_AUTH_TOKEN: string;
  MCP_OBJECT: DurableObjectNamespace;
  FP_CACHE: KVNamespace;
}

const FP_BASE = "https://api.fantasypros.com/public/v2/json/nfl";

// How long a cached response is considered fresh, per endpoint "family".
// Injury/player news moves fast; rankings, projections, and player metadata
// don't change minute to minute, so they get a longer TTL. This is what
// keeps repeated questions in one chat (or across a few chats in a day)
// from burning through the free tier's 50 requests/day budget.
const CACHE_TTL_SECONDS = {
  news: 120, // 2 min
  rankings: 900, // 15 min
  projections: 900, // 15 min
  player: 3600, // 1 hour — name/team/position rarely changes
} as const;

function cacheKey(path: string, params: Record<string, string | number | undefined>): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `fp:${path}?${query}`;
}

/**
 * Thin wrapper around the FantasyPros v2 API, fronted by a Workers KV cache.
 * Note the "/public/" segment — the same paths without it return
 * {"message":"Forbidden"} even with a valid key.
 */
async function fpFetch(
  env: Env,
  path: string,
  params: Record<string, string | number | undefined> = {},
  ttlSeconds: number = CACHE_TTL_SECONDS.rankings
): Promise<unknown> {
  const key = cacheKey(path, params);

  const cached = await env.FP_CACHE.get(key, "json");
  if (cached !== null) {
    console.log(`[cache] HIT ${key}`);
    return cached;
  }
  console.log(`[cache] MISS ${key}`);

  const url = new URL(`${FP_BASE}${path}`);
  for (const [k, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(k, String(value));
  }

  const res = await fetch(url.toString(), {
    headers: { "x-api-key": env.FANTASYPROS_API_KEY },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FantasyPros API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  // Best-effort: don't fail the tool call just because the cache write did.
  try {
    await env.FP_CACHE.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });
    console.log(`[cache] WROTE ${key} (ttl ${ttlSeconds}s)`);
  } catch (err) {
    console.error("[cache] FP_CACHE.put failed", err);
  }
  return data;
}

function asToolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export class FantasyProsMCP extends McpAgent<Env> {
  server = new McpServer({ name: "fantasypros", version: "1.0.0" });

  async init() {
    const env = this.env;

    this.server.tool(
      "get_injury_news",
      "Get the most recent NFL injury newswire from FantasyPros (real-time, includes fantasy-impact write-ups). Optionally filter to one player via FantasyPros player ID (fpid).",
      {
        limit: z.number().min(1).max(25).optional().describe("Number of items to return (default 10)"),
        fpid: z.string().optional().describe("FantasyPros player ID to filter to one player"),
      },
      async ({ limit, fpid }) => {
        const data = await fpFetch(
          env,
          "/news",
          { category: "injury", limit: limit ?? 10, fpid },
          CACHE_TTL_SECONDS.news
        );
        return asToolResult(data);
      }
    );

    this.server.tool(
      "get_player_news",
      "Get recent FantasyPros news (any category: injury, recap, transaction, rumor, breaking) for a specific player by FantasyPros player ID.",
      {
        fpid: z.string().describe("FantasyPros player ID"),
        limit: z.number().min(1).max(25).optional().describe("Number of items to return (default 10)"),
      },
      async ({ fpid, limit }) => {
        const data = await fpFetch(env, "/news", { fpid, limit: limit ?? 10 }, CACHE_TTL_SECONDS.news);
        return asToolResult(data);
      }
    );

    this.server.tool(
      "get_player",
      "Look up a specific NFL player's FantasyPros record (name, position, team) by FantasyPros player ID. Use this to confirm an fpid before using it elsewhere.",
      { fpid: z.string().describe("FantasyPros player ID") },
      async ({ fpid }) => {
        const data = await fpFetch(env, "/players", { player: fpid }, CACHE_TTL_SECONDS.player);
        return asToolResult(data);
      }
    );

    this.server.tool(
      "get_consensus_rankings",
      "Get FantasyPros expert consensus rankings (ECR) for a position and week. Also a reliable way to find a player's fpid, since the full /players list is truncated on the free tier but rankings lists are not.",
      {
        position: z
          .enum(["QB", "RB", "WR", "TE", "K", "DST", "FLEX", "ALL"])
          .describe("Position to rank"),
        season: z.string().optional().describe("Season year, e.g. '2026' (default: current season)"),
        week: z
          .number()
          .min(0)
          .max(18)
          .optional()
          .describe("Week number, 0 for preseason/full-season rankings (default: 0)"),
        scoring: z.enum(["STD", "PPR", "HALF"]).optional().describe("Scoring format (default: PPR)"),
      },
      async ({ position, season, week, scoring }) => {
        const data = await fpFetch(
          env,
          `/${season ?? "2026"}/consensus-rankings`,
          { position, week: week ?? 0, scoring: scoring ?? "PPR" },
          CACHE_TTL_SECONDS.rankings
        );
        return asToolResult(data);
      }
    );

    this.server.tool(
      "get_projections",
      "Get FantasyPros weekly or season-long fantasy point projections for a position.",
      {
        position: z
          .enum(["QB", "RB", "WR", "TE", "K", "DST"])
          .describe("Position to project"),
        season: z.string().optional().describe("Season year, e.g. '2026' (default: current season)"),
        week: z.number().min(0).max(18).optional().describe("Week number, 0 for season-long (default: 0)"),
        scoring: z.enum(["STD", "PPR", "HALF"]).optional().describe("Scoring format (default: PPR)"),
      },
      async ({ position, season, week, scoring }) => {
        const data = await fpFetch(
          env,
          `/${season ?? "2026"}/projections`,
          { position, week: week ?? 0, scoring: scoring ?? "PPR" },
          CACHE_TTL_SECONDS.projections
        );
        return asToolResult(data);
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Gate the whole Worker behind a bearer token so it isn't an open proxy
    // for your FantasyPros key (and your 50 req/day free-tier budget) to
    // anyone who finds the URL.
    //
    // NOTE: this checks "x-api-key" rather than "Authorization" because
    // Claude's custom-connector UI reserves the Authorization header for
    // its own OAuth bearer token and won't let you set it as a plain
    // custom header under "No sign-in" mode. x-api-key is offered there
    // and works the same way.
    const apiKey = request.headers.get("x-api-key");
    if (apiKey !== env.MCP_AUTH_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return FantasyProsMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return FantasyProsMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found. MCP endpoints: /sse (SSE transport) or /mcp (Streamable HTTP).", {
      status: 404,
    });
  },
};
