import { get } from "./api.js";
import { h, mount, shortModel, toast } from "./dom.js";
import { libraryView } from "./views/library.js";
import { projectView } from "./views/project.js";
import { wizardView } from "./views/wizard.js";
import { readerView } from "./views/reader.js";
import { settingsView } from "./views/settings.js";

const ROUTES = [
  [/^#?\/?$/, libraryView],
  [/^#\/project\/([\w-]+)$/, projectView],
  [/^#\/story\/([\w-]+)$/, wizardView],
  [/^#\/read\/([\w-]+)$/, readerView],
  [/^#\/settings$/, settingsView],
];

const ctx = {
  meta: null,
  settings: null,
  navigate: (hash) => {
    location.hash = hash;
  },
  async refreshSettings() {
    ctx.settings = await get("/api/settings");
    renderHeader();
    return ctx.settings;
  },
  /** Вид может запретить уход (идёт генерация). */
  leaveGuard: null,
};

const header = document.getElementById("header");
const main = document.getElementById("main");
let cleanup = null;
let currentHash = null;

function renderHeader() {
  const s = ctx.settings;
  const route = location.hash || "#/";
  mount(
    header,
    h(
      "div",
      { class: "header-inner" },
      h("a", { href: "#/", class: "wordmark", "aria-label": "Перо — на главную" }, h("span", { class: "wordmark-mark", "aria-hidden": "true" }, "✒"), "Перо"),
      h(
        "nav",
        { class: "nav" },
        h("a", { href: "#/", class: ["nav-link", !route.startsWith("#/settings") && "is-active"] }, "Библиотека"),
        h("a", { href: "#/settings", class: ["nav-link", route.startsWith("#/settings") && "is-active"] }, "Настройки"),
        s &&
          h(
            "a",
            { href: "#/settings", class: ["key-badge", s.hasKey ? "key-ok" : "key-missing"], title: s.hasKey ? `Модель по умолчанию: ${s.defaultModel}` : "Добавьте ключ OpenRouter" },
            h("span", { class: "dot", "aria-hidden": "true" }),
            s.hasKey ? shortModel(s.defaultModel) : "Нет ключа",
          ),
      ),
    ),
  );
}

async function route() {
  if (location.hash === currentHash) return;
  if (ctx.leaveGuard && !ctx.leaveGuard()) {
    history.replaceState(null, "", currentHash ?? "#/");
    return;
  }
  ctx.leaveGuard = null;
  currentHash = location.hash;
  cleanup?.();
  cleanup = null;
  renderHeader();
  const hash = location.hash || "#/";
  for (const [pattern, view] of ROUTES) {
    const match = hash.match(pattern);
    if (!match) continue;
    main.replaceChildren(h("div", { class: "loading" }, "Открываю…"));
    try {
      cleanup = (await view(main, match.slice(1), ctx)) ?? null;
    } catch (error) {
      mount(main, h("div", { class: "empty" }, h("h2", null, "Не получилось открыть"), h("p", null, error.message), h("a", { href: "#/", class: "btn" }, "В библиотеку")));
    }
    window.scrollTo(0, 0);
    return;
  }
  mount(main, h("div", { class: "empty" }, h("h2", null, "Такой страницы нет"), h("a", { href: "#/", class: "btn" }, "В библиотеку")));
}

window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (event) => {
  if (ctx.leaveGuard && !ctx.leaveGuard(true)) event.preventDefault();
});

(async function boot() {
  try {
    [ctx.meta, ctx.settings] = await Promise.all([get("/api/meta"), get("/api/settings")]);
  } catch (error) {
    mount(main, h("div", { class: "empty" }, h("h2", null, "Сервер не отвечает"), h("p", null, "Проверьте, что «Перо» запущено командой npm start, и обновите страницу."), h("p", { class: "muted" }, error.message)));
    return;
  }
  await route();
})();

window.addEventListener("unhandledrejection", (event) => {
  toast(event.reason?.message ?? String(event.reason), "error");
});
