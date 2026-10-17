import { del, get, post, put } from "../api.js";
import { button, dateLabel, h, mount, toast } from "../dom.js";
import { genreById } from "/shared/catalog.js";
import { STATUS_LABEL } from "/shared/story.js";

export async function projectView(root, [projectId], ctx) {
  let { project, stories } = await get(`/api/projects/${projectId}`);
  const types = ctx.meta.loreTypes;
  let editing = null;

  async function reload() {
    ({ project, stories } = await get(`/api/projects/${projectId}`));
    render();
  }

  function loreForm(entity, onDone) {
    let type;
    let name;
    let description;
    const submit = async (event) => {
      event.preventDefault();
      const body = { type: type.value, name: name.value, description: description.value };
      try {
        if (entity) await put(`/api/projects/${projectId}/lore/${entity.id}`, body);
        else await post(`/api/projects/${projectId}/lore`, body);
        onDone();
      } catch (error) {
        toast(error.message, "error");
      }
    };
    return h(
      "form",
      { class: "lore-form", onSubmit: submit },
      h("select", { ref: (el) => (type = el), "aria-label": "Тип" }, types.map((t) => h("option", { value: t.id, selected: entity?.type === t.id }, t.name))),
      h("input", { ref: (el) => (name = el), value: entity?.name ?? "", placeholder: "Имя или название", required: true, maxlength: 80, "aria-label": "Имя" }),
      h("textarea", { ref: (el) => (description = el), value: entity?.description ?? "", rows: 2, maxlength: 600, placeholder: "Кто это или что это: факты, которые нельзя нарушать", "aria-label": "Описание" }),
      h("div", { class: "row" }, h("button", { type: "submit", class: "btn btn-primary" }, entity ? "Сохранить" : "Добавить"), entity && button("Отмена", () => ((editing = null), render()), { kind: "ghost" })),
    );
  }

  function render() {
    mount(
      root,
      h("a", { href: "#/", class: "back" }, "← Библиотека"),
      h(
        "section",
        { class: "page-head" },
        h("span", { class: "eyebrow" }, `Антология · ${genreById(project.genreId)?.name}`),
        h("h1", {
          contenteditable: "plaintext-only",
          spellcheck: "false",
          class: "editable-title",
          title: "Нажмите, чтобы переименовать",
          onBlur: async (event) => {
            const title = event.target.textContent.trim();
            if (!title || title === project.title) return (event.target.textContent = project.title);
            project = await put(`/api/projects/${projectId}`, { title });
            toast("Название сохранено");
          },
          onKeydown: (event) => event.key === "Enter" && (event.preventDefault(), event.target.blur()),
        }, project.title),
        h(
          "div",
          { class: "row" },
          button("✒ Новый рассказ в антологии", async () => {
            const story = await post("/api/stories", { projectId });
            ctx.navigate(`#/story/${story.id}`);
          }, { kind: "primary" }),
          button("Удалить антологию", async () => {
            if (!confirm(`Удалить антологию «${project.title}»? Рассказы останутся, но станут самостоятельными, лорбук пропадёт.`)) return;
            await del(`/api/projects/${projectId}`);
            ctx.navigate("#/");
          }, { kind: "ghost danger" }),
        ),
      ),
      h(
        "div",
        { class: "two-col" },
        h(
          "section",
          { class: "section" },
          h("div", { class: "section-head" }, h("h2", null, "Лорбук"), h("p", { class: "muted" }, "Канон антологии. Агенты не будут ему противоречить, а Хранитель канона проверит каждую сцену.")),
          types.map((t) => {
            const rows = project.lore.filter((item) => item.type === t.id);
            if (!rows.length) return null;
            return h(
              "div",
              { class: "lore-group" },
              h("h3", { class: "lore-type" }, t.name),
              rows.map((item) =>
                editing === item.id
                  ? loreForm(item, () => ((editing = null), reload()))
                  : h(
                      "div",
                      { class: "lore-item" },
                      h("div", null, h("strong", null, item.name), item.description && h("p", { class: "muted" }, item.description)),
                      h(
                        "div",
                        { class: "row tight" },
                        button("Изменить", () => ((editing = item.id), render()), { kind: "ghost small" }),
                        button("✕", async () => {
                          if (!confirm(`Удалить «${item.name}» из лорбука?`)) return;
                          await del(`/api/projects/${projectId}/lore/${item.id}`);
                          reload();
                        }, { kind: "ghost small", "aria-label": `Удалить ${item.name}` }),
                      ),
                    ),
              ),
            );
          }),
          project.lore.length === 0 && h("p", { class: "muted" }, "Лорбук пуст. Добавьте героев, места и правила мира — или позже примите предложения Архивариуса."),
          h("div", { class: "card" }, h("h3", null, "Новая запись"), loreForm(null, reload)),
        ),
        h(
          "section",
          { class: "section" },
          h("div", { class: "section-head" }, h("h2", null, "Рассказы антологии")),
          stories.length === 0
            ? h("p", { class: "muted" }, "Пока ни одного.")
            : h(
                "ul",
                { class: "story-list" },
                stories.map((story) =>
                  h(
                    "li",
                    null,
                    h(
                      "a",
                      { href: story.status === "COMPLETED" ? `#/read/${story.id}` : `#/story/${story.id}`, class: "story-row" },
                      h("div", { class: "story-row-main" }, h("strong", null, story.title || "Без названия"), h("span", { class: "muted small" }, dateLabel(story.updatedAt))),
                      h("span", { class: ["pill", `status-${story.status}`] }, STATUS_LABEL[story.status]),
                    ),
                  ),
                ),
              ),
        ),
      ),
    );
  }
  render();
}
