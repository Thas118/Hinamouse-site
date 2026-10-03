import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

function createCache(entries = {}) {
  return {
    async get(key) {
      return entries[key] ?? null;
    },
  };
}

test("serves cached clips with the selected sort", async () => {
  const index = {
    items: [{ id: "recent-clip", title: "Свежий клип" }],
    updatedAt: "2026-10-03T10:00:00.000Z",
  };
  const response = await worker.fetch(
    new Request("https://media.example/api/clips?sort=recent"),
    { MEDIA_CACHE: createCache({ "clips:recent": index }) },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), index);
});

test("reports the current Twitch stream status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.origin === "https://id.twitch.tv") {
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    if (url.pathname.endsWith("/users")) {
      return Response.json({ data: [{ id: "broadcaster-1" }] });
    }
    if (url.pathname.endsWith("/streams")) {
      return Response.json({
        data: [{
          title: "Тестовый стрим",
          game_name: "Just Chatting",
          viewer_count: 42,
          started_at: "2026-10-03T10:00:00.000Z",
        }],
      });
    }
    throw new Error(`Unexpected Twitch URL: ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://media.example/api/status"),
      { TWITCH_CLIENT_ID: "test-client-id", TWITCH_CLIENT_SECRET: "test-client-secret" },
    );
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.isLive, true);
    assert.equal(result.title, "Тестовый стрим");
    assert.equal(result.gameName, "Just Chatting");
    assert.equal(result.viewerCount, 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports an offline Twitch channel", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.origin === "https://id.twitch.tv") {
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    if (url.pathname.endsWith("/users")) {
      return Response.json({ data: [{ id: "broadcaster-1" }] });
    }
    if (url.pathname.endsWith("/streams")) {
      return Response.json({ data: [] });
    }
    throw new Error(`Unexpected Twitch URL: ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://media.example/api/status"),
      { TWITCH_CLIENT_ID: "test-client-id", TWITCH_CLIENT_SECRET: "test-client-secret" },
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).isLive, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects unsupported sort values", async () => {
  const response = await worker.fetch(
    new Request("https://media.example/api/clips?sort=oldest"),
    {},
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /recent or popular/);
});

test("rejects unsupported popular clip ranges", async () => {
  const response = await worker.fetch(
    new Request("https://media.example/api/clips?sort=popular&range=365d"),
    {},
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /all, 30d, 7d, 24h/);
});

test("serves a popular clip range from its own cache index", async () => {
  const index = {
    items: [{ id: "popular-last-week", view_count: 888 }],
    updatedAt: "2026-10-03T10:00:00.000Z",
  };
  const response = await worker.fetch(
    new Request("https://media.example/api/clips?sort=popular&range=7d"),
    { MEDIA_CACHE: createCache({ "clips:popular:7d": index }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), index);
});

test("does not expose the removed VOD endpoint", async () => {
  const response = await worker.fetch(
    new Request("https://media.example/api/videos?sort=recent"),
    {},
  );

  assert.equal(response.status, 404);
});

test("returns an explicit error when a clips cache miss cannot refresh", async () => {
  const response = await worker.fetch(
    new Request("https://media.example/api/clips"),
    { MEDIA_CACHE: createCache() },
  );

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Twitch API secrets are not configured/);
});

test("scheduled refresh caches newest and popular clips", async () => {
  const originalFetch = globalThis.fetch;
  const entries = new Map();
  const cache = {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(key, value) {
      entries.set(key, JSON.parse(value));
    },
  };
  const recentClips = Array.from({ length: 100 }, (_, index) => ({
    id: `clip-${index}`,
    title: `Клип ${index}`,
    created_at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  }));

  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.origin === "https://id.twitch.tv") {
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    if (url.pathname.endsWith("/users")) {
      return Response.json({ data: [{ id: "broadcaster-1" }] });
    }
    if (url.pathname.endsWith("/clips")) {
      const startedAt = url.searchParams.get("started_at");
      const endedAt = url.searchParams.get("ended_at");
      const range = startedAt && endedAt
        ? Date.parse(endedAt) - Date.parse(startedAt)
        : null;
      return Response.json({
        data: range === null
          ? [{ id: "popular-all-time", title: "Топ за всё время", view_count: 1000 }]
          : range > 7 * 24 * 60 * 60 * 1000
            ? [{ id: `popular-${startedAt}`, title: "Клип за месяц", view_count: 1000 }]
            : recentClips,
        pagination: {},
      });
    }
    throw new Error(`Unexpected Twitch URL: ${url}`);
  };

  try {
    await worker.scheduled(null, {
      MEDIA_CACHE: cache,
      TWITCH_CLIENT_ID: "test-client-id",
      TWITCH_CLIENT_SECRET: "test-client-secret",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(entries.get("clips:popular:all").items[0].id, "popular-all-time");
  assert.equal(entries.get("clips:popular:24h").items[0].id.startsWith("clip-"), true);
  assert.equal(entries.get("clips:popular:7d").items[0].id.startsWith("clip-"), true);
  assert.equal(entries.get("clips:popular:30d").items.length, 100);
  assert.equal(entries.get("clips:recent").items[0].id, "clip-99");
  assert.equal(entries.get("clips:recent").items.at(-1).id, "clip-0");
});
