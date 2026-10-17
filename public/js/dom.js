/** Крошечный помощник для построения DOM без фреймворка. */

const PROPS = new Set(["value", "checked", "disabled", "selected", "htmlFor", "textContent", "indeterminate"]);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = Array.isArray(value) ? value.filter(Boolean).join(" ") : value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "ref") value(el);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function mount(root, ...children) {
  root.replaceChildren();
  return append(root, children);
}

/** Абзацы прозы: пустая строка — новый абзац. */
export function prose(text, { class: extra, ...props } = {}) {
  const paragraphs = String(text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return h("div", { ...props, class: ["prose", extra] }, paragraphs.map((p) => h("p", null, p)));
}

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

let toastHost;
export function toast(message, kind = "info", ms = 4500) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const node = h("div", { class: ["toast", `toast-${kind}`] }, message);
  toastHost.append(node);
  setTimeout(() => {
    node.classList.add("toast-out");
    setTimeout(() => node.remove(), 300);
  }, ms);
}

export function shortModel(id) {
  return String(id ?? "").split("/").pop();
}

export function money(value) {
  if (!value) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function tokens(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value ?? 0);
}

export function dateLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Кнопка с состоянием «занято». */
export function button(label, onClick, props = {}) {
  return h("button", { type: "button", class: ["btn", props.kind && `btn-${props.kind}`, props.class], onClick, ...omit(props, ["kind", "class"]) }, label);
}

function omit(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}
