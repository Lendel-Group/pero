/**
 * HTTP-сервер «Пера»: REST для библиотеки и настроек, поток событий
 * (Server-Sent Events) для работы агентов и раздача интерфейса.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as catalog from "../shared/catalog.js";
import { STEPS } from "../shared/story.js";
import { AGENTS, AGENT_TOGGLES, MODEL_ROLES, agentDirectory } from "./agents.js";
import {
  HttpError,
  addLore,
  addUsage,
  alignScenes,
  createProject,
  createStory,
  deleteProject,
  deleteStory,
  emptyLibrary,
  getProject,
  getStory,
  patchStory,
  refreshStatus,
  removeLore,
  storySummary,
  updateLore,
  updateProject,
} from "./library.js";
import { exportStory } from "./export.js";
import { createOpenRouter } from "./openrouter.js";
import { TASKS, parseJsonReply, runTask } from "./pipeline.js";
import {
  MODEL_PRESETS,
  applySettingsPatch,
  defaultSettings,
  modelFor,
  publicSettings,
  resolveKey,
} from "./settings.js";
import { JsonFile } from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIRS = { "/shared/": path.join(ROOT, "shared"), "/": path.join(ROOT, "public") };
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};
const MODELS_TTL = 60 * 60 * 1000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function createApp({
  dataDir,
  openrouterBase = "https://openrouter.ai/api/v1",
  fetchImpl = globalThis.fetch,
  env = process.env,
  allowAnyHost = false,
  log = console.info,
} = {}) {
  const settingsStore = new JsonFile(path.join(dataDir, "settings.json"), defaultSettings());
  const library = new JsonFile(path.join(dataDir, "library.json"), emptyLibrary());
  const client = createOpenRouter({
    baseUrl: openrouterBase.replace(/\/+$/, ""),
    fetchImpl,
    getKey: async () => resolveKey(await settingsStore.read(), env).key,
  });
  const running = new Map(); // storyId → AbortController
  let models = { at: 0, list: null };

  async function loadModels(force = false) {
    if (!force && models.list && Date.now() - models.at < MODELS_TTL) return models.list;
    models = { at: Date.now(), list: await client.listModels() };
    return models.list;
  }

  function supportsFor(model) {
    const params = models.list?.find((item) => item.id === model)?.params;
    return params ? (param) => params.includes(param) : undefined;
  }

  // ── маршруты ───────────────────────────────────────────────

  const routes = [
    ["GET", "/api/meta", async () => ({
      genres: catalog.GENRES,
      subgenres: catalog.SUBGENRES,
      tones: catalog.TONES,
      pacing: catalog.PACING,
      pov: catalog.POV,
      lengths: catalog.LENGTHS,
      conflicts: catalog.CONFLICTS,
      tropes: catalog.TROPES,
      endings: catalog.ENDINGS,
      loreTypes: catalog.LORE_TYPES,
      steps: STEPS,
      agents: agentDirectory(),
      toggles: AGENT_TOGGLES,
      modelRoles: MODEL_ROLES,
      presets: MODEL_PRESETS,
    })],

    ["GET", "/api/settings", async () => publicSettings(await settingsStore.read(), env)],
    ["PUT", "/api/settings", async ({ body }) => {
      let errors = [];
      const next = await settingsStore.update((draft) => {
        errors = applySettingsPatch(draft, body ?? {});
        return draft;
      });
      if (errors.length) throw new HttpError(400, errors.join(" "));
      return publicSettings(next, env);
    }],
    ["POST", "/api/settings/check", async () => client.keyInfo()],
    ["GET", "/api/models", async ({ query }) => ({ models: await loadModels(query.get("refresh") === "1") })],

    ["GET", "/api/library", async () => {
      const lib = await library.read();
      return { projects: lib.projects, stories: lib.stories.map(storySummary) };
    }],

    ["POST", "/api/projects", ({ body }) => library.update((lib) => createProject(lib, body))],
    ["GET", "/api/projects/:id", async ({ params }) => {
      const lib = await library.read();
      const project = getProject(lib, params.id);
      return { project, stories: lib.stories.filter((s) => s.projectId === project.id).map(storySummary) };
    }],
    ["PUT", "/api/projects/:id", ({ params, body }) => library.update((lib) => updateProject(lib, params.id, body))],
    ["DELETE", "/api/projects/:id", ({ params }) => library.update((lib) => (deleteProject(lib, params.id), { ok: true }))],
    ["POST", "/api/projects/:id/lore", ({ params, body }) => library.update((lib) => addLore(lib, params.id, body))],
    ["PUT", "/api/projects/:id/lore/:loreId", ({ params, body }) =>
      library.update((lib) => updateLore(lib, params.id, params.loreId, body))],
    ["DELETE", "/api/projects/:id/lore/:loreId", ({ params }) =>
      library.update((lib) => (removeLore(lib, params.id, params.loreId), { ok: true }))],

    ["POST", "/api/stories", ({ body }) => library.update((lib) => createStory(lib, body))],
    ["GET", "/api/stories/:id", async ({ params }) => getStory(await library.read(), params.id)],
    ["PUT", "/api/stories/:id", ({ params, body }) => {
      busyGuard(params.id);
      return library.update((lib) => patchStory(lib, params.id, body));
    }],
    ["DELETE", "/api/stories/:id", ({ params }) => {
      busyGuard(params.id);
      return library.update((lib) => (deleteStory(lib, params.id), { ok: true }));
    }],
    ["POST", "/api/stories/:id/suggestions/:sid/accept", ({ params }) => {
      busyGuard(params.id);
      return library.update((lib) => {
        const story = getStory(lib, params.id);
        if (!story.projectId) throw new HttpError(400, "Рассказ не входит в антологию — лорбука нет.");
        const suggestion = story.suggestions.find((item) => item.id === params.sid);
        if (!suggestion) throw new HttpError(404, "Предложение не найдено.");
        if (!suggestion.accepted) {
          addLore(lib, story.projectId, suggestion);
          suggestion.accepted = true;
        }
        return story;
      });
    }],
    ["POST", "/api/stories/:id/stop", ({ params }) => {
      running.get(params.id)?.abort();
      return { ok: true };
    }],
  ];

  function busyGuard(storyId) {
    if (running.has(storyId)) throw new HttpError(409, "Агенты ещё работают над этим рассказом. Дождитесь или остановите.");
  }

  // ── задачи агентов (поток событий) ─────────────────────────

  async function handleTask(req, res, storyId, task) {
    if (!TASKS.includes(task)) throw new HttpError(404, "Неизвестная задача.");
    busyGuard(storyId);
    const input = await readBody(req);
    const lib = await library.read();
    const story = getStory(lib, storyId);
    const project = story.projectId ? getProject(lib, story.projectId) : null;
    const settings = await settingsStore.read();
    if (!resolveKey(settings, env).key) throw new HttpError(400, "Не задан ключ OpenRouter. Откройте «Настройки» и добавьте его.");

    loadModels().catch(() => {}); // список параметров моделей — в фоне, на будущие вызовы
    const controller = new AbortController();
    running.set(storyId, controller);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const emit = (event) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const keepAlive = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000);
    const usage = [];
    const llm = makeLLM({ settings, emit, signal: controller.signal, usage });

    try {
      emit({ type: "start", task });
      const result = await runTask(task, { story, project, settings, llm, emit, input, signal: controller.signal });
      const updated = await library.update((draft) => {
        const target = getStory(draft, storyId);
        applyResult(target, result);
        for (const item of usage) addUsage(target, item);
        refreshStatus(target);
        target.updatedAt = new Date().toISOString();
        return target;
      });
      emit({ type: "done", story: updated });
    } catch (error) {
      if (usage.length) {
        // Потраченные токены учитываем, даже если задача сорвалась.
        await library
          .update((draft) => {
            const target = draft.stories.find((item) => item.id === storyId);
            if (target) for (const item of usage) addUsage(target, item);
          })
          .catch(() => {});
      }
      const status = error.status ?? 500;
      emit({ type: "error", status, message: status === 500 && !(error instanceof HttpError) ? `Внутренняя ошибка: ${error.message}` : error.message });
      if (status === 500 && !(error instanceof HttpError)) console.error(error);
    } finally {
      clearInterval(keepAlive);
      running.delete(storyId);
      res.end();
    }
  }

  function makeLLM({ settings, emit, signal, usage }) {
    async function call(agentId, options) {
      const agent = AGENTS[agentId];
      const role = agentId === "writer" ? "writer" : agent.modelRole;
      const model = modelFor(settings, role);
      const anthropic = model.startsWith("anthropic/");
      const name = options.label ?? agent?.name ?? agentId;
      emit({ type: "agent", agent: agentId, name, model, status: "start" });
      let chars = 0;
      let lastProgress = 0;
      const result = await client.chat({
        model,
        messages: [
          { role: "system", content: systemContent(options.system ?? agent.system, options.bible, anthropic) },
          { role: "user", content: options.user },
        ],
        temperature: options.temperature ?? agent?.temperature,
        topP: options.topP,
        reasoning: options.reasoning ?? agent?.reasoning,
        // Кэш Anthropic живёт у конкретного провайдера: держимся его, пока он доступен.
        provider: anthropic ? ANTHROPIC_PROVIDER : undefined,
        maxTokens: options.maxTokens ?? agent?.maxTokens ?? 3000,
        json: options.json,
        signal,
        supports: supportsFor(model),
        onDelta: (piece) => {
          if (!options.json) return emit({ type: "delta", agent: agentId, text: piece });
          chars += piece.length;
          if (Date.now() - lastProgress > 400) {
            lastProgress = Date.now();
            emit({ type: "progress", agent: agentId, chars });
          }
        },
      });
      usage.push(result.usage);
      log?.(usageLine(name, result.model, result.usage));
      emit({ type: "agent", agent: agentId, name, model: result.model, status: "done", usage: result.usage, finish: result.finish });
      if (result.finish === "length" && !options.json) {
        emit({ type: "notice", message: `${name}: ответ упёрся в лимит токенов и мог оборваться.` });
      }
      return result;
    }

    return {
      text: async (agentId, options) => (await call(agentId, { ...options, json: false })).text,
      json: async (agentId, options) => {
        const first = await call(agentId, { ...options, json: true });
        let parsed = parseJsonReply(first.text);
        if (!parsed) {
          emit({ type: "notice", message: `${AGENTS[agentId].name} ответил не в формате JSON — переспрашиваю.` });
          const second = await call(agentId, {
            ...options,
            json: true,
            user: `${options.user}\n\nВажно: предыдущий ответ не был валидным JSON. Верни только JSON-объект указанного формата.`,
          });
          parsed = parseJsonReply(second.text);
        }
        if (!parsed) throw new HttpError(502, `${AGENTS[agentId].name} не вернул JSON. Попробуйте ещё раз или выберите другую модель.`);
        return parsed;
      },
    };
  }

  // ── обработчик запросов ────────────────────────────────────

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
      checkHost(req, allowAnyHost);
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") checkOrigin(req);
        const task = url.pathname.match(/^\/api\/stories\/([\w-]+)\/run\/(\w+)$/);
        if (task && req.method === "POST") return await handleTask(req, res, task[1], task[2]);
        const exp = url.pathname.match(/^\/api\/stories\/([\w-]+)\/export$/);
        if (exp && req.method === "GET") {
          const story = getStory(await library.read(), exp[1]);
          const file = exportStory(story, url.searchParams.get("format"));
          res.writeHead(200, {
            "Content-Type": file.type,
            "Content-Disposition": `attachment; filename="story.${file.ext}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          });
          return res.end(file.body);
        }
        for (const [method, pattern, handler] of routes) {
          if (method !== req.method) continue;
          const params = match(pattern, url.pathname);
          if (!params) continue;
          const body = method === "GET" || method === "DELETE" ? null : await readBody(req);
          return sendJson(res, 200, await handler({ params, body, query: url.searchParams }));
        }
        throw new HttpError(404, "Нет такого адреса.");
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Метод не поддерживается.");
      return await serveStatic(url.pathname, res);
    } catch (error) {
      const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) return res.end();
      return sendJson(res, status, { error: status === 500 ? "Внутренняя ошибка сервера." : error.message });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  return { server, stores: { settings: settingsStore, library } };
}

const ANTHROPIC_PROVIDER = { order: ["anthropic"], allow_fallbacks: true };

/**
 * Библия идёт первым блоком системного промпта — это общее начало запросов
 * всех ролей, и провайдер отдаёт его из кэша. Anthropic кэширует только по
 * явной метке; Gemini и прочие находят общее начало сами.
 */
export function systemContent(system, bible, anthropic) {
  if (!bible) return system;
  const head = `Библия истории:\n${bible}`;
  if (!anthropic) return `${head}\n\n${system}`;
  return [
    { type: "text", text: head, cache_control: { type: "ephemeral" } },
    { type: "text", text: system },
  ];
}

export function usageLine(name, model, u) {
  return `[pero] ${name} · ${model} · вход ${u.promptTokens} (из кэша ${u.cachedTokens}) · выход ${u.completionTokens} (рассуждение ${u.reasoningTokens}) · $${u.cost.toFixed(4)}`;
}

function applyResult(story, result) {
  if (result.concept) story.concept = result.concept;
  if (result.outline) {
    story.outline = result.outline;
    if (result.resetScenes) {
      story.scenes = [];
      story.review = null;
      story.suggestions = [];
    }
    alignScenes(story);
    if (story.step < 6) story.step = 6;
  }
  if (typeof result.title === "string" && result.title) story.title = result.title;
  if ("audit" in result) story.audit = result.audit;
  if (result.scene) {
    story.scenes = story.scenes.map((item) => (item.n === result.scene.n ? result.scene : item));
    story.review = null;
    if (story.step < 7) story.step = 7;
  }
  if (result.review) story.review = result.review;
  if (result.suggestions) story.suggestions = result.suggestions;
}

/** Защита от DNS-rebinding: локальный сервер отвечает только на локальные имена. */
function checkHost(req, allowAnyHost) {
  if (allowAnyHost) return;
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOOPBACK.has(host)) throw new HttpError(403, "Доступ разрешён только с этого компьютера.");
}

/** Защита от CSRF: изменяющие запросы принимаются только со своей страницы. */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = "";
    }
    if (host !== req.headers.host) throw new HttpError(403, "Запрос с чужого сайта отклонён.");
  }
  const type = String(req.headers["content-type"] ?? "");
  const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"];
  if (hasBody && !type.startsWith("application/json")) throw new HttpError(415, "Ожидается JSON.");
}

function match(pattern, pathname) {
  const a = pattern.split("/");
  const b = pathname.split("/");
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith(":")) {
      if (!/^[\w-]{1,64}$/.test(b[i])) return null;
      params[a[i].slice(1)] = b[i];
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Слишком большой запрос.");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Некорректный JSON.");
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function serveStatic(pathname, res) {
  const prefix = pathname.startsWith("/shared/") ? "/shared/" : "/";
  const base = STATIC_DIRS[prefix];
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length)) || "index.html";
  } catch {
    throw new HttpError(400, "Некорректный адрес.");
  }
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) throw new HttpError(404, "Не найдено.");
  let data;
  try {
    data = await fs.readFile(file);
  } catch {
    throw new HttpError(404, "Не найдено.");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...(file.endsWith(".html")
      ? { "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" }
      : {}),
  });
  res.end(data);
}
