import { get, post, put, runTask } from "../api.js";
import { button, debounce, h, money, mount, plural, prose, shortModel, toast, tokens } from "../dom.js";
import { MAX_TROPES, MAX_VOICES, genreById, sceneCountFor, subgenreById, subgenresOf, tonesFor } from "/shared/catalog.js";
import { pruneSelection, resolveCompatibility } from "/shared/compatibility.js";
import { apportion, doseLine, mixLine, secondaryFor } from "/shared/orchestrator.js";
import { STEPS, blankConcept, stepIssues, storyTitle } from "/shared/story.js";
import { MIN_WEIGHT, normalizeWeights, setVoiceWeight, toggleVoice } from "/shared/weights.js";

const AGENT_LABEL = {
  concept: "Идеолог",
  architect: "Архитектор",
  auditor: "Сюжетный ревизор",
  writer: "Писатель",
  continuity: "Хранитель канона",
  beta: "Бета-ридер",
  editor: "Редактор",
  reviewer: "Рецензент",
  lore: "Архивариус",
};

export async function wizardView(root, [storyId], ctx) {
  const meta = ctx.meta;
  let story = await get(`/api/stories/${storyId}`);
  let project = story.projectId ? (await get(`/api/projects/${story.projectId}`)).project : null;
  let projects = null;
  let busy = null; // { task, n, controller, agent, model, chars }
  let live = null; // состояние сцены, которая пишется прямо сейчас
  let liveTextEl = null;
  let activityEl = null;
  const ui = { editing: new Set(), showDraft: new Set(), cardAsk: new Set() };

  // ── сохранение правок ──────────────────────────────────────
  let pending = null;
  let inflight = Promise.resolve();
  const scheduleSave = debounce(() => flushNow(), 600);

  function queue(patch) {
    const scenes = patch.scenes ? mergeScenes(pending?.scenes ?? [], patch.scenes) : pending?.scenes;
    pending = { ...pending, ...patch, ...(scenes ? { scenes } : {}) };
    scheduleSave();
  }
  function mergeScenes(prev, next) {
    const map = new Map(prev.map((s) => [s.n, s]));
    for (const s of next) map.set(s.n, s);
    return [...map.values()];
  }
  function flushNow() {
    if (!pending) return inflight;
    const patch = pending;
    pending = null;
    inflight = inflight
      .then(() => put(`/api/stories/${storyId}`, patch))
      .then((saved) => {
        // Счётчики и статус берём с сервера, тексты — свои (пользователь мог продолжить печатать).
        story.status = saved.status;
        story.updatedAt = saved.updatedAt;
      })
      .catch((error) => toast(error.message, "error"));
    return inflight;
  }
  async function flush() {
    scheduleSave.cancel();
    await flushNow();
  }
  function setWizard(patch) {
    Object.assign(story.wizard, patch);
    queue({ wizard: story.wizard });
  }

  // ── агенты ─────────────────────────────────────────────────
  async function run(task, input = {}) {
    if (busy) return false;
    if (!ctx.settings.hasKey) {
      toast("Сначала добавьте ключ OpenRouter в «Настройках».", "error");
      return false;
    }
    await flush();
    const controller = new AbortController();
    busy = { task, n: input.n ?? null, controller, agent: null, model: null, chars: 0 };
    if (task === "scene") live = freshLive(input.n);
    ctx.leaveGuard = (unload) => {
      if (unload) return false;
      if (!confirm("Агенты ещё работают. Остановить и уйти?")) return false;
      controller.abort();
      return true;
    };
    render();
    try {
      story = await runTask(storyId, task, input, { signal: controller.signal, onEvent });
      return true;
    } catch (error) {
      toast(error.status === 499 ? "Остановлено." : error.message, error.status === 499 ? "info" : "error", 7000);
      story = await get(`/api/stories/${storyId}`).catch(() => story);
      return false;
    } finally {
      busy = null;
      live = null;
      ctx.leaveGuard = null;
      render();
    }
  }

  function stop() {
    if (!busy) return;
    busy.controller.abort();
    post(`/api/stories/${storyId}/stop`).catch(() => {});
  }

  function freshLive(n) {
    const on = ctx.settings.agents;
    return {
      n,
      text: "",
      writer: null,
      agents: {
        writer: "wait",
        continuity: on.continuity ? "wait" : "off",
        beta: on.beta ? "wait" : "off",
        editor: on.editor ? "wait" : "off",
      },
      continuity: null,
      beta: null,
    };
  }

  let frame = 0;
  function onEvent(event) {
    switch (event.type) {
      case "agent":
        if (event.status === "start") Object.assign(busy, { agent: event.name, model: event.model, chars: 0 });
        if (live && event.agent in live.agents) live.agents[event.agent] = event.status === "start" ? "active" : "done";
        if (live || event.status === "start") render();
        break;
      case "plan":
        if (live) live.writer = event;
        break;
      case "delta":
        if (!live) break;
        live.text += event.text;
        busy.chars = live.text.length;
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (liveTextEl) liveTextEl.textContent = live?.text ?? "";
            updateActivity();
          });
        }
        break;
      case "progress":
        busy.chars = event.chars;
        updateActivity();
        break;
      case "reset":
        if (live) live.text = "";
        break;
      case "review":
        if (live) live[event.agent] = event.data;
        render();
        break;
      case "notice":
        toast(event.message, "warn", 7000);
        break;
    }
  }

  // ── навигация по шагам ─────────────────────────────────────
  const reachable = (n) => n === 1 || stepIssues(story, n - 1).length === 0;

  function goStep(n) {
    if (!reachable(n)) return;
    story.step = n;
    queue({ step: n });
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── отрисовка ──────────────────────────────────────────────
  function render() {
    const issues = stepIssues(story, story.step);
    liveTextEl = null;
    mount(
      root,
      h(
        "div",
        { class: "wizard-top" },
        h("a", { href: story.projectId ? `#/project/${story.projectId}` : "#/", class: "back" }, story.projectId ? `← ${project?.title ?? "Антология"}` : "← Библиотека"),
        h("h1", { class: "wizard-title" }, storyTitle(story)),
        h(
          "p",
          { class: "muted" },
          [genreById(story.genreId)?.name, story.wizard.subgenres.length ? mixLine(story.wizard.subgenres) : null].filter(Boolean).join(" · ") || "Новый рассказ",
        ),
      ),
      h(
        "ol",
        { class: "stepper", "aria-label": "Шаги мастера" },
        STEPS.map((step) =>
          h(
            "li",
            null,
            h(
              "button",
              {
                type: "button",
                class: ["step", step.n === story.step && "is-current", step.n < story.step && "is-past"],
                disabled: !reachable(step.n) || Boolean(busy),
                "aria-current": step.n === story.step ? "step" : null,
                onClick: () => goStep(step.n),
              },
              h("span", { class: "step-n" }, step.n),
              h("span", { class: "step-name" }, step.name),
            ),
          ),
        ),
      ),
      h("fieldset", { class: "step-body", disabled: Boolean(busy) && story.step < 7 }, STEP_RENDER[story.step]()),
      h(
        "div",
        { class: "wizard-nav" },
        story.step > 1 ? button("← Назад", () => goStep(story.step - 1), { kind: "ghost", disabled: Boolean(busy) }) : h("span"),
        h(
          "div",
          { class: "wizard-nav-right" },
          issues.length > 0 && story.step < 7 && h("span", { class: "muted small" }, issues[0]),
          story.step < 7 && button(story.step === 5 && !story.concept ? "Пропустить →" : "Далее →", () => goStep(story.step + 1), { kind: "primary", disabled: issues.length > 0 || Boolean(busy) }),
          story.step === 7 && story.status === "COMPLETED" && h("a", { href: `#/read/${storyId}`, class: "btn btn-primary" }, "Открыть рукопись →"),
        ),
      ),
      usageLine(),
      (activityEl = activityBar()),
    );
    if (liveTextEl && live) liveTextEl.textContent = live.text;
  }

  function usageLine() {
    const u = story.usage;
    if (!u?.calls) return null;
    return h("p", { class: "usage muted small" }, `Расход по рассказу: ${u.calls} ${plural(u.calls, "вызов", "вызова", "вызовов")} · ${tokens(u.promptTokens + u.completionTokens)} токенов · ${money(u.cost)}`);
  }

  function activityBar() {
    if (!busy) return null;
    return h(
      "div",
      { class: "activity", role: "status", "aria-live": "polite" },
      h("span", { class: "spinner", "aria-hidden": "true" }),
      h("div", { class: "activity-text" }, h("strong", null, busy.agent ?? "Агенты собираются…"), h("span", { class: "muted small", "data-role": "detail" }, activityDetail())),
      button("Стоп", stop, { kind: "ghost" }),
    );
  }
  function activityDetail() {
    if (!busy) return "";
    return [busy.model && shortModel(busy.model), busy.chars ? `${busy.chars} знаков` : null].filter(Boolean).join(" · ");
  }
  function updateActivity() {
    const detail = activityEl?.querySelector('[data-role="detail"]');
    if (detail) detail.textContent = activityDetail();
  }

  // ── Шаг 1: контекст ────────────────────────────────────────
  function stepContext() {
    if (!projects) {
      get("/api/library").then((data) => {
        projects = data.projects;
        if (story.step === 1) render();
      });
    }
    return [
      stepHead("Где будет жить рассказ?", "Самостоятельный рассказ получает жанр здесь. Рассказ антологии наследует её жанр и лорбук."),
      h(
        "div",
        { class: "two-col" },
        h(
          "div",
          null,
          h("h3", null, "Самостоятельный рассказ"),
          h(
            "div",
            { class: "choice-grid" },
            meta.genres.map((genre) =>
              choice({
                active: !story.projectId && story.genreId === genre.id,
                title: genre.name,
                text: genre.description,
                onClick: () => setContext(null, genre.id),
              }),
            ),
          ),
        ),
        h(
          "div",
          null,
          h("h3", null, "В антологии"),
          projects === null
            ? h("p", { class: "muted" }, "Загружаю…")
            : projects.length === 0
              ? h("p", { class: "muted" }, "Антологий пока нет. Их можно создать в библиотеке.")
              : h(
                  "div",
                  { class: "choice-grid" },
                  projects.map((p) =>
                    choice({
                      active: story.projectId === p.id,
                      eyebrow: genreById(p.genreId)?.name,
                      title: p.title,
                      text: `${p.lore.length} ${plural(p.lore.length, "запись", "записи", "записей")} в лорбуке`,
                      onClick: () => setContext(p.id, p.genreId),
                    }),
                  ),
                ),
        ),
      ),
    ];
  }

  async function setContext(projectId, genreId) {
    if (projectId === story.projectId && genreId === story.genreId) return;
    if (genreId !== story.genreId && (story.wizard.subgenres.length || story.outline.length)) {
      if (!confirm("Смена жанра сбросит микс поджанров и план. Продолжить?")) return;
    }
    await flush();
    try {
      story = await put(`/api/stories/${storyId}`, { projectId, genreId });
      project = projectId ? (await get(`/api/projects/${projectId}`)).project : null;
    } catch (error) {
      toast(error.message, "error");
    }
    render();
  }

  // ── Шаг 2: микс поджанров ──────────────────────────────────
  function stepMix() {
    const pool = subgenresOf(story.genreId);
    const selectedIds = story.wizard.subgenres.map((w) => w.id);
    const states = new Map(resolveCompatibility(pool, selectedIds).map((row) => [row.id, row]));
    const name = (id) => `«${subgenreById(id)?.name}»`;
    const sliders = [];
    let mixEl;
    let layoutEl;

    function refreshMix() {
      for (const { id, range, output } of sliders) {
        const weight = story.wizard.subgenres.find((w) => w.id === id)?.weight ?? 0;
        range.value = weight;
        output.textContent = `${weight}%`;
      }
      if (mixEl) mixEl.textContent = mixLine(story.wizard.subgenres);
      if (layoutEl) mount(layoutEl, sceneLayout());
    }

    function toggle(sub) {
      const state = states.get(sub.id);
      if (state.status === "blocked") {
        toast(`${name(sub.id)} не сочетается с ${state.blockedBy.map(name).join(" и ")}.${state.liftBy.length ? ` Сначала добавьте мост: ${state.liftBy.map(name).join(" или ")}.` : ""}`, "warn");
        return;
      }
      if (state.status !== "selected" && selectedIds.length >= MAX_VOICES) {
        toast(`Не больше ${MAX_VOICES} голосов в одном рассказе.`, "warn");
        return;
      }
      let next = toggleVoice(story.wizard.subgenres, sub.id, MAX_VOICES);
      const kept = pruneSelection(next.map((w) => w.id));
      const dropped = next.filter((w) => !kept.includes(w.id));
      if (dropped.length) toast(`${dropped.map((w) => name(w.id)).join(", ")} убран из микса: пропал мост.`, "warn");
      next = normalizeWeights(next.filter((w) => kept.includes(w.id)));
      const { tones } = tonesFor(kept);
      setWizard({ subgenres: next, tone: tones.includes(story.wizard.tone) ? story.wizard.tone : null });
      render();
    }

    function sceneLayout() {
      const count = sceneCountFor(story.wizard.pacing);
      const seq = apportion(story.wizard.subgenres, count);
      if (!seq.length) return h("span", { class: "muted" }, "Выберите голоса — здесь появится раскладка сцен.");
      return h(
        "ol",
        { class: "layout" },
        seq.map((id) => h("li", null, doseLine(id, secondaryFor(story.wizard.subgenres, id), story.wizard.subgenres))),
      );
    }

    return [
      stepHead("Микс поджанров", `Выберите до ${MAX_VOICES} голосов. Несовместимые блокируются, а поджанр-мост снимает конкретный конфликт.`),
      h(
        "div",
        { class: "sub-grid" },
        pool.map((sub) => {
          const state = states.get(sub.id);
          return h(
            "button",
            {
              type: "button",
              class: ["sub-card", `is-${state.status}`],
              "aria-pressed": state.status === "selected" ? "true" : "false",
              "aria-disabled": state.status === "blocked" ? "true" : null,
              onClick: () => toggle(sub),
            },
            h("span", { class: "sub-name" }, sub.name, state.status === "selected" && h("span", { class: "check", "aria-hidden": "true" }, " ✓")),
            h("span", { class: "sub-blurb" }, sub.blurb),
            h("span", { class: "sub-refs muted small" }, `в духе: ${sub.writer.references.join(", ")}`),
            state.status === "blocked" &&
              h(
                "span",
                { class: "sub-block small" },
                `Не сочетается с ${state.blockedBy.map(name).join(", ")}`,
                state.liftBy.length ? ` · мост: ${state.liftBy.map(name).join(" или ")}` : "",
              ),
          );
        }),
      ),
      story.wizard.subgenres.length > 0 &&
        h(
          "div",
          { class: "card mix-panel" },
          h("h3", null, "Пропорции"),
          story.wizard.subgenres.length === 1
            ? h("p", { class: "muted" }, `${subgenreById(story.wizard.subgenres[0].id).name} — единственный голос, 100%.`)
            : story.wizard.subgenres.map((w) => {
                const sub = subgenreById(w.id);
                let range;
                let output;
                const row = h(
                  "label",
                  { class: "slider-row" },
                  h("span", { class: "slider-name" }, sub.name),
                  h("input", {
                    type: "range",
                    min: MIN_WEIGHT,
                    max: 100 - MIN_WEIGHT * (story.wizard.subgenres.length - 1),
                    step: 1,
                    value: w.weight,
                    ref: (el) => (range = el),
                    "aria-label": `Вес: ${sub.name}`,
                    onInput: (event) => {
                      story.wizard.subgenres = setVoiceWeight(story.wizard.subgenres, w.id, Number(event.target.value));
                      queue({ wizard: story.wizard });
                      refreshMix();
                    },
                  }),
                  h("output", { class: "slider-value", ref: (el) => (output = el) }, `${w.weight}%`),
                );
                sliders.push({ id: w.id, range, output });
                return row;
              }),
          h("p", { class: "mix-line", ref: (el) => (mixEl = el) }, mixLine(story.wizard.subgenres)),
          h("h4", null, `Как Архитектор разложит ${sceneCountFor(story.wizard.pacing)} сцены`),
          h("div", { ref: (el) => (layoutEl = el) }, sceneLayout()),
          h("p", { class: "muted small" }, "Темп (а значит и число сцен) выбирается на следующем шаге. Архитектор может отступить от раскладки, если того требует сюжет."),
        ),
    ];
  }

  // ── Шаг 3: тон и оптика ────────────────────────────────────
  function stepVibe() {
    const { tones, mode } = tonesFor(story.wizard.subgenres.map((w) => w.id));
    return [
      stepHead("Тон и оптика", "Тон отфильтрован по выбранным поджанрам."),
      section(
        "Тон",
        mode === "union" && h("p", { class: "callout" }, "У выбранных поджанров нет общего тона — выберите, какой будет ведущим."),
        chips(tones.map((t) => ({ id: t, name: t })), [story.wizard.tone], (id) => (setWizard({ tone: id }), render())),
      ),
      section(
        "Темп",
        h("div", { class: "choice-grid small" }, meta.pacing.map((p) => choice({ active: story.wizard.pacing === p.id, title: p.name, text: p.hint, onClick: () => (setWizard({ pacing: p.id }), render()) }))),
      ),
      section(
        "Точка зрения",
        h("div", { class: "choice-grid small" }, meta.pov.map((p) => choice({ active: story.wizard.pov === p.id, title: p.name, text: p.hint, onClick: () => (setWizard({ pov: p.id }), render()) }))),
      ),
      section(
        "Длина сцен",
        h("div", { class: "choice-grid small" }, meta.lengths.map((l) => choice({ active: story.wizard.length === l.id, title: l.name, text: `${l.words} слов`, onClick: () => (setWizard({ length: l.id }), render()) }))),
      ),
    ];
  }

  // ── Шаг 4: ядро и действующие лица ─────────────────────────
  function stepCore() {
    let counter;
    let guestName;
    let guestText;
    const addGuest = () => {
      const nameValue = guestName.value.trim();
      if (!nameValue) return guestName.focus();
      setWizard({ guests: [...story.wizard.guests, { id: crypto.randomUUID(), name: nameValue, description: guestText.value.trim() }] });
      render();
    };
    return [
      stepHead("Ядро рассказа", "Конфликт, тропы, герои и завязка — сырьё для Идеолога и Архитектора."),
      section("Конфликт", chips(meta.conflicts, [story.wizard.conflict], (id) => (setWizard({ conflict: id }), render()))),
      section(
        `Тропы · ${story.wizard.tropes.length}/${MAX_TROPES}`,
        chips(meta.tropes, story.wizard.tropes, (id) => {
          const has = story.wizard.tropes.includes(id);
          if (!has && story.wizard.tropes.length >= MAX_TROPES) return toast(`Не больше ${MAX_TROPES} тропов.`, "warn");
          setWizard({ tropes: has ? story.wizard.tropes.filter((t) => t !== id) : [...story.wizard.tropes, id] });
          render();
        }),
      ),
      section(
        "Действующие лица",
        project &&
          (project.lore.length
            ? h(
                "div",
                { class: "lore-pick" },
                h("p", { class: "muted small" }, "Из лорбука антологии — отмеченные войдут в каст:"),
                project.lore.map((item) =>
                  h(
                    "label",
                    { class: "check-row" },
                    h("input", {
                      type: "checkbox",
                      checked: story.wizard.loreIds.includes(item.id),
                      onChange: (event) => setWizard({ loreIds: event.target.checked ? [...story.wizard.loreIds, item.id] : story.wizard.loreIds.filter((id) => id !== item.id) }),
                    }),
                    h("span", null, h("strong", null, item.name), " ", h("span", { class: "muted small" }, meta.loreTypes.find((t) => t.id === item.type)?.name), item.description && h("span", { class: "muted small block" }, item.description)),
                  ),
                ),
              )
            : h("p", { class: "muted small" }, "Лорбук антологии пуст.")),
        story.wizard.guests.length > 0 &&
          h(
            "ul",
            { class: "guest-list" },
            story.wizard.guests.map((guest) =>
              h(
                "li",
                null,
                h("span", null, h("strong", null, guest.name), guest.description && ` — ${guest.description}`),
                button("✕", () => (setWizard({ guests: story.wizard.guests.filter((g) => g.id !== guest.id) }), render()), { kind: "ghost small", "aria-label": `Убрать ${guest.name}` }),
              ),
            ),
          ),
        h(
          "div",
          { class: "guest-form" },
          h("input", { ref: (el) => (guestName = el), placeholder: "Имя героя", maxlength: 80, onKeydown: (e) => e.key === "Enter" && (e.preventDefault(), addGuest()), "aria-label": "Имя героя" }),
          h("input", { ref: (el) => (guestText = el), placeholder: "Кто он: пара слов", maxlength: 400, onKeydown: (e) => e.key === "Enter" && (e.preventDefault(), addGuest()), "aria-label": "Описание героя" }),
          button("Добавить героя", addGuest),
        ),
        h("p", { class: "muted small" }, "Можно никого не добавлять — Идеолог придумает героев сам."),
      ),
      section(
        "Завязка",
        h("textarea", {
          class: "premise",
          rows: 4,
          maxlength: 2000,
          placeholder: "С чего всё начинается? Например: «Ночная сиделка находит ключ от комнаты, которую семья заперла тридцать лет назад».",
          value: story.wizard.premise,
          onInput: (event) => {
            setWizard({ premise: event.target.value });
            counter.textContent = `${event.target.value.length}/2000`;
            updateNav();
          },
        }),
        h("span", { class: "muted small", ref: (el) => (counter = el) }, `${story.wizard.premise.length}/2000`),
      ),
      section("Финал", chips(meta.endings, [story.wizard.ending], (id) => (setWizard({ ending: id }), render()))),
      section(
        "Название (необязательно)",
        h("input", { value: story.wizard.title, maxlength: 120, placeholder: "Оставьте пустым — Архитектор предложит", onInput: (event) => setWizard({ title: event.target.value }) }),
      ),
    ];
  }

  /** Обновляет только навигацию, чтобы не терять фокус в поле ввода. */
  function updateNav() {
    const issues = stepIssues(story, story.step);
    const next = root.querySelector(".wizard-nav .btn-primary");
    if (next) next.disabled = issues.length > 0;
    const hint = root.querySelector(".wizard-nav-right .muted");
    if (hint) hint.textContent = issues[0] ?? "";
  }

  // ── Шаг 5: концепция ───────────────────────────────────────
  function stepConcept() {
    const enabled = ctx.settings.agents.concept;
    const c = story.concept;
    const field = (key, label, rows = 2) =>
      h(
        "label",
        { class: "field" },
        h("span", null, label),
        h("textarea", {
          rows,
          value: c[key],
          maxlength: 600,
          onInput: (event) => {
            c[key] = event.target.value;
            queue({ concept: c });
          },
        }),
      );
    return [
      stepHead("Концепция", "Идеолог превращает завязку в крепкую основу: логлайн, тему, героя и противостоящую силу. Всё можно поправить руками."),
      !enabled && h("p", { class: "callout" }, "Идеолог отключён в настройках. Заполните концепцию сами или пропустите шаг."),
      h(
        "div",
        { class: "row" },
        enabled && button(c ? "Пересобрать концепцию" : "✦ Позвать Идеолога", () => run("concept"), { kind: c ? "" : "primary", disabled: Boolean(busy) }),
        !c && button("Заполнить вручную", () => ((story.concept = blankConcept()), queue({ concept: story.concept }), render()), { kind: "ghost" }),
        c && button("Убрать концепцию", () => ((story.concept = null), queue({ concept: null }), render()), { kind: "ghost" }),
      ),
      c &&
        h(
          "div",
          { class: "card concept" },
          field("logline", "Логлайн"),
          h("div", { class: "two-col tight" }, field("theme", "Тема", 1), field("question", "Главный вопрос", 1)),
          h("div", { class: "two-col tight" }, field("protagonist", "Герой"), field("antagonist", "Противостоящая сила")),
          h("div", { class: "two-col tight" }, field("setting", "Место и время"), field("motifs", "Сквозные мотивы")),
          h("h4", null, "Персонажи концепции"),
          c.characters.map((person, index) =>
            h(
              "div",
              { class: "person-row" },
              h("input", { value: person.name, placeholder: "Имя", "aria-label": "Имя", onInput: (e) => ((person.name = e.target.value), queue({ concept: c })) }),
              h("input", { value: person.role, placeholder: "Роль", "aria-label": "Роль", onInput: (e) => ((person.role = e.target.value), queue({ concept: c })) }),
              h("input", { value: person.description, placeholder: "Коротко о нём", "aria-label": "Описание", onInput: (e) => ((person.description = e.target.value), queue({ concept: c })) }),
              button("✕", () => (c.characters.splice(index, 1), queue({ concept: c }), render()), { kind: "ghost small", "aria-label": "Убрать персонажа" }),
            ),
          ),
          button("＋ Персонаж", () => (c.characters.push({ name: "", role: "", description: "" }), render()), { kind: "ghost small" }),
        ),
    ];
  }

  // ── Шаг 6: план ────────────────────────────────────────────
  function stepOutline() {
    const count = sceneCountFor(story.wizard.pacing);
    const written = story.scenes.some((s) => s.content.trim());
    const audit = story.audit;
    const rebuild = async (useAudit = false) => {
      if (written && !confirm("Новый план сотрёт уже написанные сцены. Продолжить?")) return;
      await run("outline", { useAudit });
    };
    const patchCard = (card, patch) => {
      Object.assign(card, patch);
      queue({ outline: story.outline });
    };
    return [
      stepHead("Интерактивный план", `Архитектор строит ${count} ${plural(count, "сцену", "сцены", "сцен")} и назначает каждой ведущий голос. Правьте карточки, меняйте писателей, пересобирайте отдельные сцены.`),
      h(
        "div",
        { class: "row" },
        button(story.outline.length ? "Пересобрать план" : "✦ Позвать Архитектора", () => rebuild(), { kind: story.outline.length ? "" : "primary", disabled: Boolean(busy) }),
        story.outline.length === count && ctx.settings.agents.auditor && button("Ревизия плана", () => run("audit"), { disabled: Boolean(busy) }),
      ),
      story.outline.length > 0 && story.outline.length !== count && h("p", { class: "callout callout-warn" }, `Темп изменился: нужен план из ${count} сцен. Пересоберите план.`),
      audit &&
        h(
          "div",
          { class: "card audit" },
          h("div", { class: "audit-head" }, scoreBadge(audit.score), h("div", null, h("h3", null, "Ревизия плана"), h("p", { class: "muted" }, audit.verdict))),
          audit.issues.length
            ? h(
                "ul",
                { class: "issues" },
                audit.issues.map((issue) =>
                  h(
                    "li",
                    { class: `sev-${issue.severity}` },
                    h("span", { class: "issue-where" }, issue.scene ? `Сцена ${issue.scene}` : "Весь план"),
                    h("span", null, issue.problem, h("span", { class: "fix" }, ` → ${issue.fix}`)),
                  ),
                ),
              )
            : h("p", null, "Замечаний нет."),
          audit.issues.length > 0 && button("Переписать план по замечаниям", () => rebuild(true), { disabled: Boolean(busy) }),
        ),
      h(
        "div",
        { class: "cards-list" },
        story.outline.map((card) => {
          let instruction;
          return h(
            "article",
            { class: "card scene-card" },
            h(
              "div",
              { class: "scene-card-head" },
              h("span", { class: "scene-n" }, card.n),
              h(
                "select",
                {
                  "aria-label": `Писатель сцены ${card.n}`,
                  onChange: (event) => {
                    patchCard(card, { writer: event.target.value, secondary: secondaryFor(story.wizard.subgenres, event.target.value) });
                    render();
                  },
                },
                story.wizard.subgenres.map((w) => h("option", { value: w.id, selected: card.writer === w.id }, `Писатель: ${subgenreById(w.id).name}`)),
              ),
              h("span", { class: "muted small" }, doseLine(card.writer, card.secondary, story.wizard.subgenres)),
            ),
            h("input", { class: "card-title", value: card.title, maxlength: 120, "aria-label": "Название сцены", onInput: (e) => (patchCard(card, { title: e.target.value }), updateNav()) }),
            h("textarea", { rows: 3, value: card.summary, maxlength: 1200, "aria-label": "Описание сцены", onInput: (e) => (patchCard(card, { summary: e.target.value }), updateNav()) }),
            h(
              "div",
              { class: "two-col tight" },
              h("label", { class: "field small" }, h("span", null, "Цель героя"), h("input", { value: card.goal, maxlength: 300, onInput: (e) => patchCard(card, { goal: e.target.value }) })),
              h("label", { class: "field small" }, h("span", null, "Поворот"), h("input", { value: card.turn, maxlength: 300, onInput: (e) => patchCard(card, { turn: e.target.value }) })),
            ),
            ui.cardAsk.has(card.n)
              ? h(
                  "div",
                  { class: "row" },
                  h("input", { ref: (el) => (instruction = el), placeholder: "Что изменить? (необязательно)", maxlength: 500, class: "grow" }),
                  button("Пересобрать", () => {
                    ui.cardAsk.delete(card.n);
                    run("card", { n: card.n, instruction: instruction.value });
                  }, { disabled: Boolean(busy) }),
                  button("Отмена", () => (ui.cardAsk.delete(card.n), render()), { kind: "ghost" }),
                )
              : button("↻ Пересобрать карточку", () => (ui.cardAsk.add(card.n), render()), { kind: "ghost small", disabled: Boolean(busy) }),
          );
        }),
      ),
    ];
  }

  // ── Шаг 7: рукопись ────────────────────────────────────────
  function stepDraft() {
    const done = story.scenes.filter((s) => s.content.trim()).length;
    const left = story.scenes.filter((s) => !s.content.trim()).map((s) => s.n);
    const writeAll = async () => {
      for (const n of left) {
        const ok = await run("scene", { n });
        if (!ok) break;
      }
    };
    const on = ctx.settings.agents;
    return [
      stepHead("Рукопись", `Каждая сцена проходит конвейер: Писатель → ${[on.continuity && "Хранитель канона", on.beta && "Бета-ридер"].filter(Boolean).join(" и ") || "без ревизоров"} → ${on.editor ? "Редактор" : "без редактора"}.`),
      h(
        "div",
        { class: "row" },
        h("span", { class: "progress-label" }, `Написано ${done} из ${story.scenes.length}`),
        left.length > 0 && button(done ? "Дописать оставшиеся" : "✦ Написать все сцены", writeAll, { kind: "primary", disabled: Boolean(busy) }),
      ),
      story.scenes.map((scene) => sceneBlock(scene)),
    ];
  }

  function sceneBlock(scene) {
    const card = story.outline.find((c) => c.n === scene.n);
    const isLive = live?.n === scene.n;
    const editing = ui.editing.has(scene.n);
    const showDraft = ui.showDraft.has(scene.n) && scene.draft && scene.draft !== scene.content;
    const agents = isLive ? live.agents : sceneAgents(scene);
    const continuity = isLive ? live.continuity : scene.continuity;
    const beta = isLive ? live.beta : scene.beta;

    let body;
    if (isLive) {
      const phase = agents.editor === "active" ? "Редактор правит сцену" : agents.writer === "active" ? `${live.writer?.writer ? `Писатель «${live.writer.writer}»` : "Писатель"} пишет` : agents.writer === "done" && agents.editor !== "done" ? "Ревизоры читают черновик" : "";
      body = h("div", { class: "live" }, h("p", { class: "live-phase small" }, phase), h("div", { class: "live-text", ref: (el) => (liveTextEl = el) }));
    } else if (editing) {
      body = h("textarea", {
        class: "scene-editor",
        rows: 14,
        value: scene.content,
        onInput: (event) => {
          scene.content = event.target.value;
          queue({ scenes: [{ n: scene.n, content: scene.content }] });
        },
      });
    } else if (scene.content.trim()) {
      body = prose(showDraft ? scene.draft : scene.content, { class: showDraft ? "is-draft" : "" });
    } else {
      body = h("p", { class: "muted" }, card?.summary ?? "Сцена ещё не написана.");
    }

    return h(
      "article",
      { class: ["card", "draft-scene", isLive && "is-live"] },
      h(
        "header",
        { class: "draft-head" },
        h("div", null, h("span", { class: "eyebrow" }, `Сцена ${scene.n}`), h("h3", null, card?.title ?? ""), h("p", { class: "muted small" }, card ? doseLine(card.writer, card.secondary, story.wizard.subgenres) : "")),
        pipeline(agents),
      ),
      body,
      showDraft && h("p", { class: "muted small" }, "Показан черновик писателя до редактуры."),
      reviews(continuity, beta, agents.editor === "done"),
      !isLive &&
        h(
          "div",
          { class: "row" },
          button(scene.content.trim() ? "↻ Переписать" : "✦ Написать сцену", async () => {
            if (scene.content.trim() && !confirm(`Переписать сцену ${scene.n}? Текущий текст будет заменён.`)) return;
            ui.editing.delete(scene.n);
            await run("scene", { n: scene.n });
          }, { kind: scene.content.trim() ? "" : "primary", disabled: Boolean(busy) }),
          scene.content.trim() &&
            button(editing ? "Готово" : "Править вручную", async () => {
              if (editing) {
                ui.editing.delete(scene.n);
                await flush();
              } else ui.editing.add(scene.n);
              render();
            }, { kind: "ghost", disabled: Boolean(busy) }),
          scene.draft && scene.draft !== scene.content && !editing &&
            button(showDraft ? "Показать итог" : "Черновик писателя", () => {
              if (showDraft) ui.showDraft.delete(scene.n);
              else ui.showDraft.add(scene.n);
              render();
            }, { kind: "ghost" }),
        ),
    );
  }

  function sceneAgents(scene) {
    if (!scene.content.trim()) return { writer: "wait", continuity: "wait", beta: "wait", editor: "wait" };
    return {
      writer: "done",
      continuity: scene.continuity ? "done" : "off",
      beta: scene.beta ? "done" : "off",
      editor: scene.status === "EDITED" ? "done" : "off",
    };
  }

  function pipeline(agents) {
    const chip = (key) => h("span", { class: `agent agent-${agents[key]}`, title: stateLabel(agents[key]) }, AGENT_LABEL[key]);
    return h("ol", { class: "pipeline", "aria-label": "Конвейер агентов" }, h("li", null, chip("writer")), h("li", { class: "agent-pair" }, chip("continuity"), chip("beta")), h("li", null, chip("editor")));
  }

  function reviews(continuity, beta, edited) {
    if (!continuity && !beta) return null;
    const count = (continuity?.issues.length ?? 0) + (beta?.notes.length ?? 0);
    return h(
      "details",
      { class: "reviews" },
      h("summary", null, `Замечания ревизоров · ${count}`, beta?.score ? ` · бета-ридер: ${beta.score}/10` : ""),
      continuity &&
        h(
          "div",
          { class: "review-block" },
          h("h4", null, "Хранитель канона"),
          continuity.issues.length
            ? h("ul", null, continuity.issues.map((i) => h("li", null, i.quote && h("q", null, i.quote), " ", i.problem, h("span", { class: "fix" }, ` → ${i.fix}`))))
            : h("p", { class: "muted" }, "Нестыковок не найдено."),
        ),
      beta &&
        h(
          "div",
          { class: "review-block" },
          h("h4", null, "Бета-ридер"),
          beta.strengths.length > 0 && h("p", { class: "muted" }, `Работает: ${beta.strengths.join("; ")}`),
          h("ul", null, beta.notes.map((i) => h("li", null, i.quote && h("q", null, i.quote), " ", i.issue, h("span", { class: "fix" }, ` → ${i.suggestion}`)))),
        ),
      edited && h("p", { class: "muted small" }, "Редактор уже учёл эти замечания в итоговом тексте."),
    );
  }

  const STEP_RENDER = { 1: stepContext, 2: stepMix, 3: stepVibe, 4: stepCore, 5: stepConcept, 6: stepOutline, 7: stepDraft };

  render();

  return () => {
    stop();
    flush();
  };
}

// ── мелкие компоненты ────────────────────────────────────────

function stepHead(title, text) {
  return h("div", { class: "step-head" }, h("h2", null, title), text && h("p", { class: "muted" }, text));
}

function section(title, ...children) {
  return h("section", { class: "form-section" }, h("h3", null, title), children);
}

function choice({ active, title, text, eyebrow, onClick }) {
  return h(
    "button",
    { type: "button", class: ["choice", active && "is-active"], "aria-pressed": active ? "true" : "false", onClick },
    eyebrow && h("span", { class: "eyebrow" }, eyebrow),
    h("span", { class: "choice-title" }, title),
    text && h("span", { class: "choice-text" }, text),
  );
}

function chips(options, selected, onToggle) {
  return h(
    "div",
    { class: "chips" },
    options.map((opt) =>
      h(
        "button",
        { type: "button", class: ["chip", selected.includes(opt.id) && "is-active"], "aria-pressed": selected.includes(opt.id) ? "true" : "false", onClick: () => onToggle(opt.id) },
        opt.name,
      ),
    ),
  );
}

export function scoreBadge(score) {
  if (!score) return null;
  return h("span", { class: ["score", score >= 8 ? "score-high" : score >= 6 ? "score-mid" : "score-low"], "aria-label": `Оценка ${score} из 10` }, score, h("small", null, "/10"));
}

function stateLabel(state) {
  return { wait: "ждёт", active: "работает", done: "готово", off: "отключён или не запускался" }[state] ?? "";
}

