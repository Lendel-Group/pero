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

    const system = body.messages[0].content;
    const user = body.messages[1].content;
    const agent = detect(system);
    const reply = (overrides[agent] ?? REPLIES[agent])(user, body);
    if (reply.status) return json(res, reply.status, { error: { message: reply.message ?? "fail" } });
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    const usage = { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 };
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

function detect(system) {
  if (system.startsWith("Ты — идеолог")) return "concept";
  if (system.startsWith("Ты — сюжетный архитектор")) return "architect";
  if (system.startsWith("Ты — сюжетный ревизор")) return "auditor";
  if (system.startsWith("Ты — хранитель канона")) return "continuity";
  if (system.startsWith("Ты — опытный бета-ридер")) return "beta";
  if (system.startsWith("Ты — литературный редактор")) return "editor";
  if (system.startsWith("Ты — литературный критик")) return "reviewer";
  if (system.startsWith("Ты — архивариус")) return "lore";
  if (system.startsWith("Ты — писатель")) return "writer";
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
  continuity: () => ({ issues: [{ quote: "двенадцать", problem: "В лорбуке ступенек тринадцать", fix: "Заменить на тринадцать" }] }),
  beta: () => ({ score: 6, strengths: ["атмосфера"], notes: [{ quote: "", issue: "мало действия", suggestion: "дать Марте поступок" }] }),
  editor: () => PROSE.replace("двенадцать", "тринадцать"),
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
  const { server } = createApp({ dataDir, env: {}, ...options });
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
