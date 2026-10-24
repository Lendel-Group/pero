import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { REPLIES, startApp, startMockOpenRouter } from "./helpers.js";

const KEY = "sk-or-test-key-123456";

describe("HTTP API и конвейер агентов", () => {
  let mock;
  let app;

  before(async () => {
    mock = await startMockOpenRouter();
    app = await startApp({ openrouterBase: mock.url });
  });
  after(async () => {
    await app.close();
    await mock.close();
  });

  it("отдаёт интерфейс и общие модули", async () => {
    const page = await fetch(app.base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Перо/);
    const shared = await fetch(app.base + "/shared/catalog.js");
    assert.equal(shared.status, 200);
    const escape = await fetch(app.base + "/shared/..%2Fserver%2Fsettings.js");
    assert.equal(escape.status, 404);
  });

  it("не принимает чужой Host и чужой Origin", async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(app.base + "/api/meta", { headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    assert.equal(status, 403);
    const csrf = await fetch(app.base + "/api/projects", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", genreId: "det" }),
    });
    assert.equal(csrf.status, 403);
    const form = await fetch(app.base + "/api/projects", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(form.status, 415);
  });

  it("хранит ключ, но отдаёт только маску", async () => {
    let res = await app.api("GET", "/api/settings");
    assert.equal(res.body.hasKey, false);
    res = await app.api("PUT", "/api/settings", { apiKey: KEY, defaultModel: "test/model", roleModels: { beta: "test/model" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.hasKey, true);
    assert.equal(res.body.keySource, "settings");
    assert.ok(!JSON.stringify(res.body).includes(KEY));
    assert.equal(res.body.roleModels.beta, "test/model");
    const raw = JSON.parse(await fs.readFile(path.join(app.dataDir, "settings.json"), "utf8"));
    assert.equal(raw.apiKey, KEY);
    res = await app.api("PUT", "/api/settings", { defaultModel: "не модель" });
    assert.equal(res.status, 400);
  });

  it("проверяет ключ и отдаёт список моделей", async () => {
    const info = await app.api("POST", "/api/settings/check", {});
    assert.equal(info.status, 200);
    assert.equal(info.body.limitRemaining, 8.5);
    const models = await app.api("GET", "/api/models");
    assert.deepEqual(models.body.models.map((m) => m.id), ["test/model"]);
    assert.equal(models.body.models[0].promptPrice, 1);
  });

  it("проводит рассказ в антологии через весь конвейер", async () => {
    const project = (await app.api("POST", "/api/projects", { title: "Дом", genreId: "hor" })).body;
    const lore = (await app.api("POST", `/api/projects/${project.id}/lore`, { type: "LOCATION", name: "Лестница", description: "Тринадцать ступенек." })).body;
    let story = (await app.api("POST", "/api/stories", { projectId: project.id })).body;
    assert.equal(story.genreId, "hor");
    assert.equal(story.step, 2);

    // Конфликтная пара без моста отсекается сервером.
    story = (await app.api("PUT", `/api/stories/${story.id}`, { wizard: { subgenres: [{ id: "hor-cosmic", weight: 50 }, { id: "hor-folk", weight: 50 }] } })).body;
    assert.deepEqual(story.wizard.subgenres, [{ id: "hor-cosmic", weight: 100 }]);

    story = (
      await app.api("PUT", `/api/stories/${story.id}`, {
        wizard: {
          subgenres: [
            { id: "hor-goth", weight: 70 },
            { id: "hor-psych", weight: 30 },
          ],
          tone: "тревожный",
          pacing: "fast",
          pov: "third-close",
          length: "short",
          conflict: "self",
          tropes: ["secret"],
          loreIds: [lore.id, "чужой-id"],
          guests: [{ name: "Марта", description: "Сиделка" }],
          premise: "Сиделка находит ключ от запертой комнаты в доме, где работает.",
          ending: "twist",
        },
      })
    ).body;
    assert.deepEqual(story.wizard.loreIds, [lore.id]);

    let result = await app.run(story.id, "concept");
    assert.ok(result.done, JSON.stringify(result.error));
    assert.match(result.done.story.concept.logline, /ключ/);

    result = await app.run(story.id, "outline");
    assert.ok(result.done, JSON.stringify(result.error));
    story = result.done.story;
    assert.equal(story.outline.length, 3);
    assert.equal(story.title, "Ключ от тишины");
    assert.equal(story.status, "OUTLINE_READY");
    assert.ok(story.outline.every((card) => ["hor-goth", "hor-psych"].includes(card.writer)));

    result = await app.run(story.id, "audit");
    assert.equal(result.done.story.audit.score, 7);

    result = await app.run(story.id, "card", { n: 2, instruction: "больше страха" });
    assert.equal(result.done.story.outline[1].title, "Новая карточка");

    for (const n of [1, 2, 3]) {
      result = await app.run(story.id, "scene", { n });
      assert.ok(result.done, JSON.stringify(result.error));
      const types = result.events.map((e) => e.type);
      assert.ok(types.includes("delta"), "писатель и редактор транслируются потоком");
      assert.ok(types.includes("reset"));
      const agents = result.events.filter((e) => e.type === "agent" && e.status === "start").map((e) => e.agent);
      assert.deepEqual(agents.sort(), ["beta", "continuity", "editor", "writer"]);
    }
    story = result.done.story;
    assert.equal(story.status, "COMPLETED");
    assert.match(story.scenes[0].content, /тринадцать/, "редактор исправил нестыковку канона");
    assert.match(story.scenes[0].draft, /двенадцать/);
    assert.equal(story.scenes[0].continuity.issues.length, 1);
    assert.equal(story.scenes[0].beta.score, 6);

    // Писатель получил промпт второго голоса и лорбук.
    const writerCall = mock.calls.find((c) => c.body?.messages?.[0].content.startsWith("Ты — писатель"));
    assert.match(writerCall.body.messages[0].content, /ВТОРОЙ ГОЛОС/);
    assert.match(writerCall.body.messages[1].content, /Тринадцать ступенек/);
    // Писатель закреплён за Claude, проверки — на Gemini Flash, независимо от defaultModel.
    assert.equal(writerCall.body.model, "anthropic/claude-sonnet-5.5");
    const continuityCall = mock.calls.find((c) => c.body?.messages?.[0].content.startsWith("Ты — хранитель канона"));
    assert.equal(continuityCall.body.model, "google/gemini-3.8-flash");
    assert.equal(writerCall.auth, `Bearer ${KEY}`);

    result = await app.run(story.id, "review");
    assert.equal(result.done.story.review.score, 8);

    result = await app.run(story.id, "lore");
    const suggestions = result.done.story.suggestions;
    assert.deepEqual(suggestions.map((s) => s.name), ["Дом Вольских"], "известные имена отсеяны");

    story = (await app.api("POST", `/api/stories/${story.id}/suggestions/${suggestions[0].id}/accept`)).body;
    assert.equal(story.suggestions[0].accepted, true);
    const projectNow = (await app.api("GET", `/api/projects/${project.id}`)).body.project;
    assert.ok(projectNow.lore.some((item) => item.name === "Дом Вольских"));

    assert.ok(story.usage.calls >= 15);
    assert.ok(story.usage.cost > 0);

    const md = await fetch(`${app.base}/api/stories/${story.id}/export?format=md`);
    assert.equal(md.status, 200);
    assert.match(await md.text(), /^# Ключ от тишины/);
  });

  it("сообщает о понятных ошибках", async () => {
    const story = (await app.api("POST", "/api/stories", {})).body;
    const early = await app.run(story.id, "outline");
    assert.match(early.error.message, /жанр/);
    const unknown = await app.run(story.id, "nope");
    assert.equal(unknown.status, 404);
  });
});

describe("сбои модели", () => {
  it("не теряет черновик, если редактор упал, и переспрашивает при битом JSON", async () => {
    let auditorCalls = 0;
    const mock = await startMockOpenRouter({
      editor: () => ({ status: 400, message: "context too long" }),
      auditor: () => (++auditorCalls === 1 ? "вот мой план, без json" : REPLIES.auditor()),
    });
    const app = await startApp({ openrouterBase: mock.url, env: { OPENROUTER_API_KEY: KEY } });
    try {
      const settings = await app.api("GET", "/api/settings");
      assert.equal(settings.body.keySource, "env");
      let story = (await app.api("POST", "/api/stories", {})).body;
      await app.api("PUT", `/api/stories/${story.id}`, { genreId: "dra" });
      await app.api("PUT", `/api/stories/${story.id}`, {
        wizard: {
          subgenres: [{ id: "dra-home", weight: 100 }],
          tone: "тёплый",
          pacing: "fast",
          conflict: "person",
          tropes: ["return"],
          premise: "Сын возвращается домой через десять лет.",
          ending: "open",
        },
      });
      let result = await app.run(story.id, "outline");
      story = result.done.story;
      result = await app.run(story.id, "audit");
      assert.ok(result.done, JSON.stringify(result.error));
      assert.ok(result.events.some((e) => e.type === "notice" && /JSON/.test(e.message)));
      result = await app.run(story.id, "scene", { n: 1 });
      assert.ok(result.done);
      assert.equal(result.done.story.scenes[0].status, "DRAFTED");
      assert.ok(result.events.some((e) => e.type === "notice" && /Редактор не ответил/.test(e.message)));
    } finally {
      await app.close();
      await mock.close();
    }
  });

  it("без ключа отвечает подсказкой про настройки", async () => {
    const app = await startApp({ openrouterBase: "http://127.0.0.1:9" });
    try {
      const story = (await app.api("POST", "/api/stories", {})).body;
      const result = await app.run(story.id, "concept");
      assert.equal(result.status, 400);
      assert.match(result.error, /ключ/i);
    } finally {
      await app.close();
    }
  });
});
