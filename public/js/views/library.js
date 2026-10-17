import { get, post } from "../api.js";
import { button, dateLabel, h, mount, plural, toast } from "../dom.js";
import { genreById } from "/shared/catalog.js";
import { mixLine } from "/shared/orchestrator.js";
import { STATUS_LABEL } from "/shared/story.js";

export async function libraryView(root, _params, ctx) {
  const data = await get("/api/library");
  const projectsById = new Map(data.projects.map((p) => [p.id, p]));

  async function newStory(projectId = null) {
    const story = await post("/api/stories", { projectId });
    ctx.navigate(`#/story/${story.id}`);
  }

  let formOpen = false;
  const projectForm = h("div");

  function renderForm() {
    if (!formOpen) {
      mount(projectForm, button("＋ Новая антология", () => ((formOpen = true), renderForm())));
      return;
    }
    let title;
    let genre;
    const submit = async (event) => {
      event.preventDefault();
      try {
        const project = await post("/api/projects", { title: title.value, genreId: genre.value });
        ctx.navigate(`#/project/${project.id}`);
      } catch (error) {
        toast(error.message, "error");
      }
    };
    mount(
      projectForm,
      h(
        "form",
        { class: "inline-form card", onSubmit: submit },
        h("label", { class: "field" }, h("span", null, "Название"), h("input", { ref: (el) => (title = el), required: true, maxlength: 100, placeholder: "Например, «Город под дождём»" })),
        h(
          "label",
          { class: "field" },
          h("span", null, "Жанр (фиксируется навсегда)"),
          h("select", { ref: (el) => (genre = el) }, ctx.meta.genres.map((g) => h("option", { value: g.id }, g.name))),
        ),
        h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Создать"), button("Отмена", () => ((formOpen = false), renderForm()), { kind: "ghost" })),
      ),
    );
    title.focus();
  }
  renderForm();

  mount(
    root,
    h(
      "section",
      { class: "hero" },
      h("h1", null, "Мастерская короткого рассказа"),
      h(
        "p",
        { class: "lead" },
        "Рассказ пишет не одна нейросеть, а редакция: идеолог, архитектор сюжета, жанровые писатели, хранитель канона, бета-ридер, редактор и рецензент. Вы ведёте их по шагам и правите на каждом этапе.",
      ),
      !ctx.settings.hasKey &&
        h("div", { class: "callout callout-warn" }, "Чтобы агенты заработали, добавьте ключ OpenRouter. ", h("a", { href: "#/settings" }, "Открыть настройки →")),
      h("div", { class: "row" }, button("✒ Новый рассказ", () => newStory(), { kind: "primary" })),
    ),

    h(
      "section",
      { class: "section" },
      h("div", { class: "section-head" }, h("h2", null, "Антологии"), h("p", { class: "muted" }, "Общий жанр и лорбук для цикла рассказов.")),
      h(
        "div",
        { class: "grid cards" },
        data.projects.map((project) => {
          const count = data.stories.filter((s) => s.projectId === project.id).length;
          return h(
            "a",
            { href: `#/project/${project.id}`, class: "card card-link" },
            h("span", { class: "eyebrow" }, genreById(project.genreId)?.name),
            h("h3", null, project.title),
            h("p", { class: "muted" }, `${project.lore.length} ${plural(project.lore.length, "запись", "записи", "записей")} в лорбуке · ${count} ${plural(count, "рассказ", "рассказа", "рассказов")}`),
          );
        }),
      ),
      projectForm,
    ),

    h(
      "section",
      { class: "section" },
      h("div", { class: "section-head" }, h("h2", null, "Рассказы")),
      data.stories.length === 0
        ? h("p", { class: "muted" }, "Пока пусто. Начните с кнопки «Новый рассказ».")
        : h(
            "ul",
            { class: "story-list" },
            data.stories.map((story) =>
              h(
                "li",
                null,
                h(
                  "a",
                  { href: story.status === "COMPLETED" ? `#/read/${story.id}` : `#/story/${story.id}`, class: "story-row" },
                  h(
                    "div",
                    { class: "story-row-main" },
                    h("strong", null, story.title || "Без названия"),
                    h(
                      "span",
                      { class: "muted small" },
                      [
                        genreById(story.genreId)?.name,
                        story.subgenres.length ? mixLine(story.subgenres) : null,
                        story.projectId ? `антология «${projectsById.get(story.projectId)?.title ?? "?"}»` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Жанр не выбран",
                    ),
                  ),
                  h(
                    "div",
                    { class: "story-row-side" },
                    h("span", { class: ["pill", `status-${story.status}`] }, STATUS_LABEL[story.status], story.scenes ? ` · ${story.written}/${story.scenes}` : ""),
                    h("span", { class: "muted small" }, dateLabel(story.updatedAt)),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}
