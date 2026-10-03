const twitchPlayer = document.querySelector("#twitch-player");
const liveFallback = document.querySelector("#live-fallback");
const liveStatus = document.querySelector("#twitch-status");
const statusApi = document.querySelector('meta[name="twitch-status-api"]')?.content.trim();

if (
  !(twitchPlayer instanceof HTMLIFrameElement)
  || !(liveFallback instanceof HTMLElement)
  || !(liveStatus instanceof HTMLElement)
) {
  throw new Error("Twitch player markup is incomplete.");
}

async function refreshLiveStatus() {
  if (!statusApi) {
    liveStatus.textContent = "Статус эфира пока не настроен";
    liveStatus.dataset.state = "unconfigured";
    return;
  }

  try {
    const response = await fetch(new URL("/api/status", statusApi), {
      headers: { Accept: "application/json" },
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(typeof result.error === "string" ? result.error : `HTTP ${response.status}`);
    }
    if (typeof result.isLive !== "boolean") {
      throw new Error("Сервис вернул некорректный статус эфира.");
    }

    liveStatus.dataset.state = result.isLive ? "live" : "offline";
    liveStatus.textContent = result.isLive
      ? `Хина в эфире${typeof result.title === "string" && result.title ? `: ${result.title}` : ""}`
      : "Сейчас не в эфире";
  } catch (error) {
    liveStatus.textContent = `Статус эфира недоступен: ${
      error instanceof Error ? error.message : "неизвестная ошибка"
    }`;
    liveStatus.dataset.state = "error";
  } finally {
    window.setTimeout(refreshLiveStatus, 60_000);
  }
}

if (statusApi) {
  void refreshLiveStatus();
}

if (window.location.protocol === "file:" || !window.location.hostname) {
  liveFallback.hidden = false;
} else {
  const playerUrl = new URL("https://player.twitch.tv/");
  playerUrl.searchParams.set("channel", "hinamouse");
  playerUrl.searchParams.set("parent", window.location.hostname);
  playerUrl.searchParams.set("muted", "true");
  playerUrl.searchParams.set("autoplay", "true");

  twitchPlayer.src = playerUrl.toString();
  twitchPlayer.hidden = false;
  liveFallback.hidden = true;
}
