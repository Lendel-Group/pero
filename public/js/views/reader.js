import { get, post, put, runTask } from "../api.js";
import { button, h, money, mount, plural, prose, shortModel, toast, tokens } from "../dom.js";
import { genreById } from "/shared/catalog.js";
import { mixLine } from "/shared/orchestrator.js";
import { storyTitle } from "/shared/story.js";
import { scoreBadge } from "./wizard.js";

export async function readerView(root, [storyId], ctx) {
  let story = await get(`/api/stories/${storyId}`);
  let busy = null;

  async function run(task) {
    if (busy) return;
    if (!ctx.settings.hasKey) return toast("Сначала добавьте ключ OpenRouter в «Настройках».", "error");
    const controller = new AbortController();
    busy = { task, controller, label: task === "review" ? "Рецензент читает рассказ" : "Архивариус ищет новые сущности", model: "" };
    ctx.leaveGuard = (unload) => !unload && confirm("Агент ещё работает. Остановить и уйти?") && (controller.abort(), true);
    render();
    try {
      story = await runTask(storyId, task, {}, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "agent" && event.status === "start") {
            busy.model = event.model;
            render();
          }
          if (event.type === "notice") toast(event.message, "warn");
        },
      });
    } catch (error) {
      toast(error.message, error.status === 499 ? "info" : "error", 7000);
    } finally {
      busy = null;
      ctx.leaveGuard = null;
      render();
    }
  }

  async function setTitle(title) {
    story = await put(`/api/stories/${storyId}`, { title });
    toast("Название обновлено");
    render();
  }

  function render() {
    const complete = story.status === "COMPLETED";
    const review = story.review;
    const pending = story.suggestions.filter((s) => !s.accepted);
    const u = story.usage;
    mount(
      root,
      h(
        "div",
        { class: "reader-top" },
        h("a", { href: `#/story/${storyId}`, class: "back" }, "← В мастерскую"),
        h(
          "div",
          { class: "row" },
          h("a", { class: "btn btn-ghost", href: `/api/stories/${storyId}/export?format=md`, download: "" }, "Скачать .md"),
          h("a", { class: "btn btn-ghost", href: `/api/stories/${storyId}/export?format=txt`, download: "" }, "Скачать .txt"),
          button("Копировать текст", async () => {
            await navigator.clipboard.writeText([storyTitle(story), "", ...story.scenes.map((s) => s.content)].join("\n\n"));
            toast("Текст скопирован");
          }, { kind: "ghost" }),
        ),
      ),
      h(
        "div",
        { class: "reader-layout" },
        h(
          "article",
          { class: "manuscript" },
          h("p", { class: "eyebrow center" }, `${genreById(story.genreId)?.name ?? ""} · ${mixLine(story.wizard.subgenres)}`),
          h("h1", { class: "manuscript-title" }, storyTitle(story)),
          review?.blurb && h("p", { class: "blurb" }, review.blurb),
          story.scenes.map((scene, index) => [index > 0 && h("div", { class: "asterism", "aria-hidden": "true" }, "⁂"), scene.content.trim() ? prose(scene.content) : h("p", { class: "muted center" }, `Сцена ${scene.n} ещё не написана.`)]),
        ),
        h(
          "aside",
          { class: "reader-side" },
          !complete && h("p", { class: "callout" }, "Рассказ не дописан. Вернитесь в мастерскую, чтобы закончить сцены."),
          busy &&
            h("div", { class: "activity static" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("div", { class: "activity-text" }, h("strong", null, busy.label), h("span", { class: "muted small" }, shortModel(busy.model))), button("Стоп", () => busy.controller.abort(), { kind: "ghost" })),

          h(
            "section",
            { class: "card" },
            h("h3", null, "Рецензия"),
            review
              ? [
                  h("div", { class: "audit-head" }, scoreBadge(review.score), h("p", null, review.summary)),
                  list("Сильные стороны", review.strengths),
                  list("Слабые места", review.weaknesses),
                  review.endingFit && h("p", { class: "small" }, h("strong", null, "Финал: "), review.endingFit),
                  list("Что улучшить", review.suggestions),
                  review.titles.length > 0 &&
                    h("div", null, h("h4", null, "Варианты названия"), h("div", { class: "chips" }, review.titles.map((t) => button(t, () => setTitle(t), { class: "chip", title: "Сделать названием" })))),
                ]
              : h("p", { class: "muted" }, "Рецензент прочитает рассказ целиком: оценит арку, финал и единство голосов, предложит название и аннотацию."),
            complete && ctx.settings.agents.reviewer && button(review ? "Перечитать" : "✦ Позвать Рецензента", () => run("review"), { kind: review ? "ghost" : "primary", disabled: Boolean(busy) }),
          ),

          h(
            "section",
            { class: "card" },
            h("h3", null, "Архивариус"),
            !story.projectId && h("p", { class: "muted small" }, "Рассказ вне антологии: найденное можно посмотреть, но сохранить в лорбук нельзя."),
            pending.length
              ? h(
                  "ul",
                  { class: "suggestions" },
                  pending.map((s) =>
                    h(
                      "li",
                      null,
                      h("div", null, h("strong", null, s.name), " ", h("span", { class: "muted small" }, ctx.meta.loreTypes.find((t) => t.id === s.type)?.name), h("p", { class: "muted small" }, s.description)),
                      h(
                        "div",
                        { class: "row tight" },
                        story.projectId &&
                          button("В лорбук", async () => {
                            story = await post(`/api/stories/${storyId}/suggestions/${s.id}/accept`);
                            toast(`«${s.name}» сохранён в лорбук`);
                            render();
                          }, { kind: "small" }),
                        button("✕", async () => {
                          story = await put(`/api/stories/${storyId}`, { suggestions: story.suggestions.filter((x) => x.id !== s.id).map((x) => x.id) });
                          render();
                        }, { kind: "ghost small", "aria-label": `Отклонить ${s.name}` }),
                      ),
                    ),
                  ),
                )
              : h("p", { class: "muted" }, story.suggestions.length ? "Все предложения разобраны." : "Архивариус найдёт новых героев, места и правила для лорбука."),
            complete && ctx.settings.agents.lore && button("Искать сущности", () => run("lore"), { kind: "ghost", disabled: Boolean(busy) }),
          ),

          u?.calls > 0 &&
            h("p", { class: "muted small" }, `Всего на рассказ: ${u.calls} ${plural(u.calls, "вызов", "вызова", "вызовов")} моделей, ${tokens(u.promptTokens + u.completionTokens)} токенов, ${money(u.cost)}.`),
        ),
      ),
    );
  }

  render();
}

function list(title, items) {
  if (!items?.length) return null;
  return h("div", null, h("h4", null, title), h("ul", { class: "plain" }, items.map((item) => h("li", null, item))));
}
