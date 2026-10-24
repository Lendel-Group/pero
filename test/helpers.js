import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";

/**
 * Поддельный OpenRouter. Отвечает по системному промпту агента;
 * если запрос потоковый — отдаёт SSE кусками, как настоящий.
 */
export async function startMockOpenRouter(overrides = {}, { delayMs = 0 } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

    if (req.url.endsWith("/models")) {
      return json(res, 200, {
        data: [
          {
            id: "test/model",
            name: "Test Model",
            context_length: 1000,
            pricing: { prompt: "0.000001", completion: "0.000002" },
            architecture: { output_modalities: ["text"] },
            supported_parameters: ["temperature", "max_tokens"],
          },
          { id: "test/image", name: "Image", architecture: { output_modalities: ["image"] } },
        ],
      });
    }
    if (req.url.endsWith("/key")) {
      if (req.headers.authorization !== "Bearer sk-or-test-key-123456") return json(res, 401, { error: { message: "bad key" } });
      return json(res, 200, { data: { label: "test", usage: 1.5, limit: 10, limit_remaining: 8.5 } });
    }

    const system = contentText(body.messages[0].content);
    const user = contentText(body.messages[1].content);
    const agent = detect(system);
    const reply = (overrides[agent] ?? REPLIES[agent])(user, body);
    if (reply.status) return json(res, reply.status, { error: { message: reply.message ?? "fail" } });
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      cost: 0.001,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 },
    };
    if (!body.stream) {
      return json(res, 200, { model: body.model, choices: [{ message: { content: text }, finish_reason: "stop" }], usage });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": OPENROUTER PROCESSING\n\n");
    for (let i = 0; i < text.length; i += 40) {
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: text.slice(i, i + 40) } }] })}\n\n`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

/** Системный промпт бывает строкой или списком блоков (библия с меткой кэша + роль). */
export function contentText(content) {
  return Array.isArray(content) ? content.map((part) => part.text).join("\n\n") : content;
}

/** Роль — по первой строке после библии: библия стоит в начале системного промпта. */
function detect(system) {
  const has = (start) => system.startsWith(start) || system.includes(`\n\n${start}`);
  if (has("Ты — идеолог")) return "concept";
  if (has("Ты — сюжетный архитектор")) return "architect";
  if (has("Ты — сюжетный ревизор")) return "auditor";
  if (has("Ты — критик сцены")) return "critic";
  if (has("Ты — литературный редактор")) return "editor";
  if (has("Ты — литературный критик")) return "reviewer";
  if (has("Ты — архивариус")) return "lore";
  if (has("Ты — писатель")) return "writer";
  return "unknown";
}

const PROSE =
  "Дождь стучал по жестяному козырьку так, будто хотел войти. Марта стояла у двери и считала ступеньки вниз — двенадцать, как всегда. " +
  "В кармане лежал ключ, которого у неё не должно было быть. Она достала его, повертела в пальцах и положила обратно. " +
  "Внизу кто-то кашлянул. Марта не обернулась: в этом доме кашляли все, и все врали, что это от сырости.";

export const REPLIES = {
  concept: () => ({
    logline: "Сиделка находит ключ от комнаты, которую семья заперла тридцать лет назад.",
    theme: "цена молчания",
    question: "Откроет ли Марта дверь?",
    protagonist: "Марта, сиделка; хочет денег, нуждается в правде.",
    antagonist: "Семья Вольских, которой выгодно молчание.",
    setting: "Старый дом на окраине, осень.",
    motifs: "ключ, дождь, часы",
    characters: [{ name: "Марта", role: "героиня", description: "Сиделка, 40 лет." }],
  }),
  architect: (user) => {
    const count = Number(user.match(/Сцен должно быть ровно (\d+)/)?.[1] ?? 4);
    const writers = [...user.matchAll(/^- ([a-z]+-[a-z]+) —/gm)].map((m) => m[1]);
    if (user.includes("Пересобери только сцену")) {
      return { title: "Новая карточка", summary: "Марта спускается в подвал и находит часы.", goal: "найти", turn: "часы идут назад" };
    }
    return {
      title: "Ключ от тишины",
      scenes: Array.from({ length: count }, (_, i) => ({
        title: `Сцена ${i + 1}`,
        summary: `Марта делает шаг ${i + 1} и узнаёт новое.`,
        goal: "узнать",
        turn: "всё меняется",
        writer: writers[i % writers.length],
      })),
    };
  },
  auditor: () => ({ score: 7, verdict: "Крепко.", issues: [{ scene: 2, severity: "high", problem: "Провисает", fix: "Добавить угрозу" }] }),
  critic: () => ({
    issues: [{ quote: "двенадцать", problem: "В лорбуке ступенек тринадцать", fix: "Заменить на тринадцать" }],
    score: 6,
    strengths: ["атмосфера"],
    notes: [{ quote: "", issue: "мало действия", suggestion: "дать Марте поступок" }],
  }),
  editor: () => ({ edits: [{ find: "двенадцать", replace: "тринадцать" }, { find: "чего нет в тексте", replace: "x" }] }),
  writer: () => PROSE,
  reviewer: () => ({
    score: 8,
    summary: "Цельно.",
    strengths: ["тон"],
    weaknesses: ["финал"],
    endingFit: "соответствует",
    suggestions: ["усилить"],
    titles: ["Ключ", "Тишина", "Дом"],
    blurb: "Марта находит ключ.",
    lore: [{ type: "ITEM", name: "Ключ от чердака", description: "Ключ, который Марте не давали." }],
  }),
  lore: () => ({ suggestions: [{ type: "LOCATION", name: "Дом Вольских", description: "Старый дом." }, { type: "CHARACTER", name: "Марта", description: "уже известна" }] }),
  unknown: () => ({ status: 500 }),
};

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

export async function startApp(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pero-test-"));
  const { server } = createApp({ dataDir, env: {}, log: null, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://localhost:${server.address().port}`;
  async function api(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  async function run(storyId, task, input = {}) {
    const res = await fetch(`${base}/api/stories/${storyId}/run/${task}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.headers.get("content-type")?.startsWith("text/event-stream")) {
      return { status: res.status, error: (await res.json()).error, events: [] };
    }
    const events = (await res.text())
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6)));
    return { status: res.status, events, done: events.find((e) => e.type === "done"), error: events.find((e) => e.type === "error") };
  }
  return {
    base,
    dataDir,
    api,
    run,
    close: async () => {
      await new Promise((r) => server.close(r));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}
