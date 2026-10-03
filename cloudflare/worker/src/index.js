const TWITCH_API = "https://api.twitch.tv/helix";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const CHANNEL_LOGIN = "hinamouse";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const ITEMS_PER_PAGE = 100;
const RECENT_CLIP_LIMIT = 100;
const RECENT_CLIP_WEEKS = 52;
const MAX_RECENT_CLIP_REQUESTS = 40;
const POPULAR_CLIP_RANGES = ["all", "30d", "7d", "24h"];

let cachedToken;

function responseHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=120",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function jsonResponse(data, status = 200, cacheControl = "public, max-age=120") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...responseHeaders(),
      "Cache-Control": cacheControl,
    },
  });
}

function cacheKey(kind, sort, range = "all") {
  return sort === "recent" ? `${kind}:recent` : `${kind}:${sort}:${range}`;
}

async function getAppToken(env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    throw new Error("Twitch API secrets are not configured on the Worker.");
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const tokenUrl = new URL(TWITCH_TOKEN_URL);
  tokenUrl.searchParams.set("client_id", env.TWITCH_CLIENT_ID);
  tokenUrl.searchParams.set("client_secret", env.TWITCH_CLIENT_SECRET);
  tokenUrl.searchParams.set("grant_type", "client_credentials");

  const response = await fetch(tokenUrl, { method: "POST" });
  if (!response.ok) {
    throw new Error(`Twitch OAuth returned HTTP ${response.status}.`);
  }

  const token = await response.json();
  if (typeof token.access_token !== "string" || typeof token.expires_in !== "number") {
    throw new Error("Twitch OAuth returned an invalid access token response.");
  }

  cachedToken = {
    value: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };
  return cachedToken.value;
}

async function helixGet(path, params, env, token) {
  const url = new URL(`${TWITCH_API}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      "Client-ID": env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Twitch API ${path} returned HTTP ${response.status}.`);
  }

  const result = await response.json();
  if (!Array.isArray(result.data)) {
    throw new Error(`Twitch API ${path} returned an invalid response.`);
  }
  return result;
}

async function getBroadcasterId(env, token) {
  const result = await helixGet("users", { login: CHANNEL_LOGIN }, env, token);
  const broadcasterId = result.data[0]?.id;
  if (!broadcasterId) {
    throw new Error(`Twitch channel ${CHANNEL_LOGIN} was not found.`);
  }
  return broadcasterId;
}

async function getPopularClips(env, token, broadcasterId, range) {
  const now = new Date();
  const rangeDuration = range === "24h" ? 24 * 60 * 60 * 1000
    : range === "7d" ? 7 * 24 * 60 * 60 * 1000
      : range === "30d" ? 30 * 24 * 60 * 60 * 1000
        : null;
  let clips;

  if (rangeDuration === null) {
    const result = await helixGet(
      "clips",
      { broadcaster_id: broadcasterId, first: ITEMS_PER_PAGE },
      env,
      token,
    );
    clips = result.data;
  } else {
    const rangeStart = new Date(now.getTime() - rangeDuration);
    const dateRanges = [];
    let start = rangeStart;
    while (start < now) {
      const end = new Date(Math.min(start.getTime() + 7 * 24 * 60 * 60 * 1000, now.getTime()));
      dateRanges.push({ start, end });
      start = end;
    }

    const results = await Promise.all(dateRanges.map(({ start, end }) => helixGet(
      "clips",
      {
        broadcaster_id: broadcasterId,
        started_at: start.toISOString(),
        ended_at: end.toISOString(),
        first: ITEMS_PER_PAGE,
      },
      env,
      token,
    )));
    clips = results.flatMap((result) => result.data);
  }

  return {
    items: [...new Map(clips.filter((clip) => clip.id).map((clip) => [clip.id, clip])).values()]
      .sort((left, right) => (right.view_count || 0) - (left.view_count || 0))
      .slice(0, ITEMS_PER_PAGE),
    updatedAt: new Date().toISOString(),
  };
}

async function getRecentClips(env, token, broadcasterId) {
  const clips = new Map();
  let end = new Date();
  let requestCount = 0;
  let searchLimited = false;

  for (let week = 0; week < RECENT_CLIP_WEEKS && clips.size < RECENT_CLIP_LIMIT; week += 1) {
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    let cursor;

    do {
      if (requestCount >= MAX_RECENT_CLIP_REQUESTS) {
        if (cursor) {
          throw new Error("Twitch returned too many clips in one date range to refresh the recent list safely.");
        }
        searchLimited = true;
        break;
      }

      const result = await helixGet(
        "clips",
        {
          broadcaster_id: broadcasterId,
          started_at: start.toISOString(),
          ended_at: end.toISOString(),
          first: ITEMS_PER_PAGE,
          after: cursor,
        },
        env,
        token,
      );
      requestCount += 1;

      for (const clip of result.data) {
        if (clip.id) {
          clips.set(clip.id, clip);
        }
      }
      cursor = result.pagination?.cursor;
    } while (cursor && clips.size < RECENT_CLIP_LIMIT);

    if (searchLimited || clips.size >= RECENT_CLIP_LIMIT) {
      break;
    }
    end = start;
  }

  const items = [...clips.values()]
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, RECENT_CLIP_LIMIT);

  return {
    items,
    updatedAt: new Date().toISOString(),
    searchedFrom: end.toISOString(),
    searchLimited,
  };
}

async function refreshMedia(env) {
  if (!env.MEDIA_CACHE) {
    throw new Error("The MEDIA_CACHE KV namespace is not bound to this Worker.");
  }

  const token = await getAppToken(env);
  const broadcasterId = await getBroadcasterId(env, token);
  const [popularIndexes, clipsRecent] = await Promise.all([
    Promise.all(POPULAR_CLIP_RANGES.map(async (range) => [
      range,
      await getPopularClips(env, token, broadcasterId, range),
    ])),
    getRecentClips(env, token, broadcasterId),
  ]);

  const entries = Object.fromEntries(popularIndexes.map(([range, index]) => [
    cacheKey("clips", "popular", range),
    index,
  ]));
  entries[cacheKey("clips", "recent")] = clipsRecent;

  await Promise.all(Object.entries(entries).map(([key, index]) => env.MEDIA_CACHE.put(key, JSON.stringify(index), {
    expirationTtl: CACHE_TTL_SECONDS,
  })));

  return entries;
}

async function loadIndex(env, kind, sort, range) {
  if (!env.MEDIA_CACHE) {
    throw new Error("The MEDIA_CACHE KV namespace is not bound to this Worker.");
  }

  const key = cacheKey(kind, sort, range);
  let index = await env.MEDIA_CACHE.get(key, { type: "json" });
  if (!index) {
    const refreshed = await refreshMedia(env);
    index = refreshed[key];
  }

  if (!index || !Array.isArray(index.items)) {
    throw new Error("The Twitch media index is not available yet.");
  }
  return index;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: responseHeaders() });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Only GET requests are supported." }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      try {
        const token = await getAppToken(env);
        const broadcasterId = await getBroadcasterId(env, token);
        const result = await helixGet("streams", { user_id: broadcasterId, first: 1 }, env, token);
        const stream = result.data[0];
        return jsonResponse(stream ? {
          isLive: true,
          title: stream.title,
          gameName: stream.game_name,
          viewerCount: stream.viewer_count,
          startedAt: stream.started_at,
          updatedAt: new Date().toISOString(),
        } : {
          isLive: false,
          updatedAt: new Date().toISOString(),
        }, 200, "public, max-age=30");
      } catch (error) {
        console.error("Failed to load Twitch stream status", error);
        const message = error instanceof Error ? error.message : "Unknown Twitch status error.";
        return jsonResponse({ error: message }, 502, "no-store");
      }
    }

    const kind = url.pathname === "/api/clips" ? "clips" : null;

    if (!kind) {
      return jsonResponse({ error: "Endpoint not found." }, 404);
    }

    const sort = url.searchParams.get("sort") || "recent";
    if (sort !== "recent" && sort !== "popular") {
      return jsonResponse({ error: "Sort must be either recent or popular." }, 400);
    }

    const range = sort === "popular" ? url.searchParams.get("range") || "all" : "all";
    if (sort === "popular" && !POPULAR_CLIP_RANGES.includes(range)) {
      return jsonResponse({ error: "Range must be one of: all, 30d, 7d, 24h." }, 400);
    }

    try {
      const index = await loadIndex(env, kind, sort, range);
      return jsonResponse(index);
    } catch (error) {
      console.error(`Failed to load ${kind} (${sort}, ${range})`, error);
      const message = error instanceof Error ? error.message : "Unknown Twitch media error.";
      return jsonResponse({ error: message }, 502);
    }
  },

  async scheduled(_controller, env) {
    await refreshMedia(env);
  },
};
