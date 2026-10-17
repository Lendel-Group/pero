import { get, post, put } from "../api.js";
import { button, h, mount, toast } from "../dom.js";

export async function settingsView(root, _params, ctx) {
  let settings = ctx.settings;
  let models = null;
  let modelsError = null;
  let keyInfo = null;
  let query = "";

  async function loadModels(refresh = false) {
    try {
      models = (await get(`/api/models${refresh ? "?refresh=1" : ""}`)).models;
      modelsError = null;
    } catch (error) {
      modelsError = error.message;
    }
    render();
  }

  async function save(patch, message = "Сохранено") {
    try {
      settings = await put("/api/settings", patch);
      ctx.settings = settings;
      await ctx.refreshSettings();
      toast(message);
    } catch (error) {
      toast(error.message, "error");
    }
    render();
  }

  // ── ключ ───────────────────────────────────────────────────
  function keySection() {
    let input;
    const submit = async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return input.focus();
      keyInfo = null;
      await save({ apiKey: input.value.trim() }, "Ключ сохранён");
    };
    return h(
      "section",
      { class: "card settings-card" },
      h("h2", null, "Ключ OpenRouter"),
      h(
        "p",
        { class: "muted" },
        "Ключ хранится только на этом компьютере, в файле data/settings.json, и уходит лишь в OpenRouter. Получить ключ: ",
        h("a", { href: "https://openrouter.ai/keys", target: "_blank", rel: "noopener" }, "openrouter.ai/keys"),
        ".",
      ),
      h(
        "p",
        { class: ["key-status", settings.hasKey ? "is-ok" : "is-missing"] },
        settings.hasKey ? `Ключ задан: ${settings.keyHint}${settings.keySource === "env" ? " (из переменной окружения OPENROUTER_API_KEY)" : ""}` : "Ключ не задан — агенты не смогут работать.",
      ),
      settings.keySource === "env"
        ? h("p", { class: "muted small" }, "Пока задана переменная окружения, ключ из формы не используется.")
        : h(
            "form",
            { class: "row", onSubmit: submit },
            h("input", { ref: (el) => (input = el), type: "password", autocomplete: "off", placeholder: settings.hasKey ? "Новый ключ, чтобы заменить" : "sk-or-v1-…", class: "grow mono", "aria-label": "Ключ OpenRouter" }),
            h("button", { type: "submit", class: "btn btn-primary" }, "Сохранить"),
          ),
      h(
        "div",
        { class: "row" },
        settings.hasKey &&
          button("Проверить ключ", async () => {
            try {
              keyInfo = await post("/api/settings/check");
            } catch (error) {
              keyInfo = { error: error.message };
            }
            render();
          }, { kind: "ghost" }),
        settings.hasKey && settings.keySource === "settings" &&
          button("Удалить ключ", () => confirm("Удалить сохранённый ключ?") && save({ clearKey: true }, "Ключ удалён"), { kind: "ghost danger" }),
      ),
      keyInfo &&
        (keyInfo.error
          ? h("p", { class: "callout callout-warn" }, keyInfo.error)
          : h(
              "p",
              { class: "callout callout-ok" },
              `Ключ работает${keyInfo.label ? ` («${keyInfo.label}»)` : ""}. Потрачено: $${(keyInfo.usage ?? 0).toFixed(2)}`,
              keyInfo.limit !== null ? ` из лимита $${keyInfo.limit.toFixed(2)}, осталось $${(keyInfo.limitRemaining ?? 0).toFixed(2)}.` : ". Лимит на ключе не установлен.",
            )),
    );
  }

  // ── модель по умолчанию ────────────────────────────────────
  function modelSection() {
    const presets = ctx.meta.presets;
    let listEl;
    const renderList = () => mount(listEl, modelRows());

    function modelRows() {
      if (modelsError) return h("p", { class: "callout callout-warn" }, `Список моделей не загрузился: ${modelsError}. Можно ввести идентификатор вручную.`);
      if (!models) return h("p", { class: "muted" }, "Загружаю список моделей OpenRouter…");
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = models.filter((m) => words.every((w) => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w)));
      const shown = hits.slice(0, 60);
      const custom = query.includes("/") && !models.some((m) => m.id === query.trim());
      return [
        custom && h("button", { type: "button", class: "model-row", onClick: () => save({ defaultModel: query.trim() }, "Модель выбрана") }, h("span", { class: "mono" }, query.trim()), h("span", { class: "muted small" }, "использовать этот идентификатор")),
        shown.map((m) =>
          h(
            "button",
            { type: "button", class: ["model-row", m.id === settings.defaultModel && "is-active"], onClick: () => save({ defaultModel: m.id }, `Модель по умолчанию: ${m.name}`) },
            h("span", { class: "model-id mono" }, m.id),
            h("span", { class: "model-meta muted small" }, [m.name, price(m), m.context ? `${ctxLabel(m.context)} контекст` : null].filter(Boolean).join(" · ")),
          ),
        ),
        hits.length > shown.length && h("p", { class: "muted small" }, `Ещё ${hits.length - shown.length} — уточните поиск.`),
        hits.length === 0 && !custom && h("p", { class: "muted" }, "Ничего не нашлось."),
      ];
    }

    return h(
      "section",
      { class: "card settings-card" },
      h("h2", null, "Модель по умолчанию"),
      h("p", { class: "muted" }, "На ней работают все агенты, если для роли не выбрана своя модель."),
      h("p", { class: "current-model" }, "Сейчас: ", h("strong", { class: "mono" }, settings.defaultModel), models && !models.some((m) => m.id === settings.defaultModel) && h("span", { class: "warn small" }, " — нет в списке OpenRouter, проверьте идентификатор")),
      h("h4", null, "Быстрый выбор"),
      h(
        "div",
        { class: "preset-grid" },
        presets.map((p) =>
          h(
            "button",
            { type: "button", class: ["preset", p.id === settings.defaultModel && "is-active"], onClick: () => save({ defaultModel: p.id }, `Модель по умолчанию: ${p.id}`) },
            h("span", { class: "mono small" }, p.id),
            h("span", { class: "muted small" }, p.note),
            models && price(models.find((m) => m.id === p.id)) && h("span", { class: "small price" }, price(models.find((m) => m.id === p.id))),
          ),
        ),
      ),
      h(
        "div",
        { class: "row" },
        h("input", {
          type: "search",
          class: "grow",
          placeholder: "Поиск по всем моделям OpenRouter: claude, gpt, gemini, deepseek…",
          value: query,
          "aria-label": "Поиск модели",
          onInput: (event) => {
            query = event.target.value;
            renderList();
          },
        }),
        button("Обновить список", () => loadModels(true), { kind: "ghost" }),
      ),
      h("div", { class: "model-list", ref: (el) => (listEl = el) }, modelRows()),
    );
  }

  // ── модели по ролям ────────────────────────────────────────
  function rolesSection() {
    const ids = models?.map((m) => m.id) ?? [];
    return h(
      "section",
      { class: "card settings-card" },
      h("h2", null, "Модели по ролям"),
      h("p", { class: "muted" }, "Можно сэкономить: например, писателей и редактора оставить на сильной модели, а ревизоров и архивариуса — на быстрой и дешёвой. Пустое поле — модель по умолчанию."),
      h("datalist", { id: "model-ids" }, ids.map((id) => h("option", { value: id }))),
      h(
        "div",
        { class: "roles" },
        ctx.meta.modelRoles.map((role) =>
          h(
            "label",
            { class: "role-row" },
            h("span", null, role.name),
            h("input", {
              list: "model-ids",
              class: "mono",
              value: settings.roleModels[role.id] ?? "",
              placeholder: settings.defaultModel,
              onChange: (event) => save({ roleModels: { [role.id]: event.target.value.trim() } }, `${role.name}: ${event.target.value.trim() || "модель по умолчанию"}`),
            }),
          ),
        ),
      ),
    );
  }

  // ── агенты ─────────────────────────────────────────────────
  function agentsSection() {
    return h(
      "section",
      { class: "card settings-card" },
      h("h2", null, "Команда агентов"),
      h(
        "p",
        { class: "muted" },
        "Архитектор, Оркестратор и жанровые писатели работают всегда. Остальных можно отключить ради скорости и экономии — каждый из них добавляет вызов модели.",
      ),
      h(
        "ol",
        { class: "team" },
        h("li", null, h("strong", null, "Идеолог"), " → ", h("strong", null, "Архитектор"), " → ", h("strong", null, "Сюжетный ревизор"), h("span", { class: "muted small" }, " — до письма")),
        h("li", null, h("strong", null, "Оркестратор"), " → ", h("strong", null, "Писатель"), " → ", h("strong", null, "Канон ∥ Бета-ридер"), " → ", h("strong", null, "Редактор"), h("span", { class: "muted small" }, " — для каждой сцены")),
        h("li", null, h("strong", null, "Рецензент"), " и ", h("strong", null, "Архивариус"), h("span", { class: "muted small" }, " — по готовому рассказу")),
      ),
      ctx.meta.toggles.map((agent) =>
        h(
          "label",
          { class: "toggle-row" },
          h("input", { type: "checkbox", role: "switch", checked: settings.agents[agent.id] !== false, onChange: (event) => save({ agents: { [agent.id]: event.target.checked } }, `${agent.name}: ${event.target.checked ? "включён" : "отключён"}`) }),
          h("span", null, h("strong", null, agent.name), h("span", { class: "muted small block" }, agent.description)),
        ),
      ),
      h("details", { class: "writers" }, h("summary", null, `Жанровые писатели · ${ctx.meta.agents.writers.length}`), h("ul", { class: "plain" }, ctx.meta.agents.writers.map((w) => h("li", null, h("strong", null, w.name), " ", h("span", { class: "muted small" }, w.description))))),
    );
  }

  function render() {
    const scroll = window.scrollY;
    mount(root, h("div", { class: "page-head" }, h("h1", null, "Настройки")), keySection(), modelSection(), rolesSection(), agentsSection());
    window.scrollTo(0, scroll);
  }

  render();
  loadModels();
}

function price(model) {
  if (!model || model.promptPrice === null || model.completionPrice === null) return "";
  if (model.promptPrice === 0 && model.completionPrice === 0) return "бесплатно";
  return `$${fmt(model.promptPrice)} / $${fmt(model.completionPrice)} за 1M`;
}

function fmt(value) {
  return value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(2).replace(/\.?0+$/, "") : value.toFixed(3).replace(/\.?0+$/, "");
}

function ctxLabel(n) {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`;
}
