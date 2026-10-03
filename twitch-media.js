const grid = document.querySelector("#clips-grid");

if (grid) {
  const status = document.querySelector("#clips-status");
  const moreButton = document.querySelector("#clips-more");
  const sortButtons = document.querySelectorAll(".media-sort");
  const rangeGroup = document.querySelector(".media-ranges");
  const rangeButtons = document.querySelectorAll(".media-range");
  const itemsPerPage = 12;
  let items = [];
  let visibleCount = 0;
  let currentSort = "recent";
  let currentRange = "all";

  if (!(status instanceof HTMLElement) || !(moreButton instanceof HTMLButtonElement)) {
    throw new Error("Twitch media page is missing its status or pagination controls.");
  }

  function getApiBase() {
    const apiBase = document.querySelector('meta[name="twitch-media-api"]')?.content.trim();
    if (!apiBase) {
      throw new Error("Укажите адрес Cloudflare Worker в meta twitch-media-api.");
    }

    const url = new URL(apiBase);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("Адрес Twitch media API должен использовать HTTPS.");
    }
    return url;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Twitch media API вернул неверную дату.");
    }
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function createCard(item) {
    if (!item || typeof item.id !== "string" || !item.id || !window.location.hostname) {
      throw new Error("Для Twitch-плеера требуется ID клипа и домен сайта.");
    }

    const card = document.createElement("article");
    card.className = "clip-item";

    const heading = document.createElement("h2");
    const link = document.createElement("a");
    link.href = `https://www.twitch.tv/hinamouse/clip/${encodeURIComponent(item.id)}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.title || "Без названия";
    heading.append(link);

    const iframe = document.createElement("iframe");
    iframe.className = "clip-player";
    iframe.title = `Клип HinaMouse: ${item.title || "без названия"}`;
    iframe.allow = "autoplay; fullscreen";
    iframe.allowFullscreen = true;
    iframe.loading = "lazy";
    const playerUrl = new URL("https://clips.twitch.tv/embed");
    playerUrl.searchParams.set("clip", item.id);
    playerUrl.searchParams.set("parent", window.location.hostname);
    playerUrl.searchParams.set("autoplay", "false");
    iframe.src = playerUrl.toString();

    const details = document.createElement("p");
    details.className = "media-details";
    if (item.created_at) {
      details.append(document.createTextNode(formatDate(item.created_at)));
    }
    if (typeof item.view_count === "number") {
      if (details.childNodes.length) {
        details.append(document.createTextNode(" · "));
      }
      details.append(document.createTextNode(
        `${new Intl.NumberFormat("ru-RU").format(item.view_count)} просмотров`,
      ));
    }

    card.append(heading, iframe);
    if (details.childNodes.length) {
      card.append(details);
    }
    return card;
  }

  function appendNextPage() {
    const end = Math.min(visibleCount + itemsPerPage, items.length);
    const fragment = document.createDocumentFragment();
    for (const item of items.slice(visibleCount, end)) {
      fragment.append(createCard(item));
    }
    grid.append(fragment);
    visibleCount = end;
    moreButton.hidden = visibleCount >= items.length;
  }

  async function loadClips(sort, range = currentRange, silent = false) {
    currentSort = sort;
    currentRange = range;
    for (const button of sortButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.sort === sort));
    }
    if (!(rangeGroup instanceof HTMLElement)) {
      throw new Error("Twitch clips page is missing the time-range controls.");
    }
    rangeGroup.hidden = sort !== "popular";
    for (const button of rangeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.range === range));
    }
    if (!silent) {
      status.dataset.state = "loading";
      status.textContent = sort === "popular"
        ? `Загружаю топ клипов ${range === "all" ? "за всё время" : `за ${range === "30d" ? "30 дней" : range === "7d" ? "7 дней" : "24 часа"}`}…`
        : "Загружаю клипы…";
    }

    try {
      if (window.location.protocol === "file:" || !window.location.hostname) {
        throw new Error("Откройте сайт через HTTP/HTTPS: Twitch не поддерживает плееры в file://.");
      }

      const apiUrl = new URL("/api/clips", getApiBase());
      apiUrl.searchParams.set("sort", sort);
      if (sort === "popular") {
        apiUrl.searchParams.set("range", range);
      }
      const response = await fetch(apiUrl, { headers: { Accept: "application/json" } });
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error(`Twitch media API вернул не JSON (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        throw new Error(result.error || `Twitch media API вернул HTTP ${response.status}.`);
      }
      if (!Array.isArray(result.items) || typeof result.updatedAt !== "string") {
        throw new Error("Twitch media API вернул данные в неверном формате.");
      }

      items = sort === "popular"
        ? [...result.items].sort((left, right) => (right.view_count || 0) - (left.view_count || 0))
        : result.items;
      visibleCount = 0;
      grid.replaceChildren();
      appendNextPage();
      status.dataset.state = items.length ? "ready" : "empty";
      const updateTime = formatDate(result.updatedAt);
      const rangeLabel = range === "all" ? "за всё время"
        : range === "30d" ? "за 30 дней"
          : range === "7d" ? "за 7 дней" : "за 24 часа";
      status.textContent = items.length
        ? `Обновлено ${updateTime}. ${sort === "popular" ? `Топ ${items.length} клипов ${rangeLabel}.` : `Найдено ${items.length} клипов.`}`
        : `Пока нет доступных клипов. Последняя проверка: ${updateTime}.`;
    } catch (error) {
      console.error("Failed to load HinaMouse clips.", error);
      status.dataset.state = "error";
      status.textContent = error instanceof Error ? error.message : "Не удалось загрузить список.";
    }
  }

  for (const button of sortButtons) {
    button.addEventListener("click", () => {
      void loadClips(button.dataset.sort, currentRange);
    });
  }
  for (const button of rangeButtons) {
    button.addEventListener("click", () => {
      void loadClips("popular", button.dataset.range);
    });
  }
  moreButton.addEventListener("click", appendNextPage);

  void loadClips(currentSort, currentRange);
  window.setInterval(() => {
    if (!document.hidden) {
      void loadClips(currentSort, currentRange, true);
    }
  }, 15 * 60 * 1000);
}
