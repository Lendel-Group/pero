import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOpenRouter, createSSEParser } from "../server/openrouter.js";

function sseResponse(lines, status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("SSE-парсер", () => {
  it("собирает события из рваных кусков и пропускает комментарии", () => {
    const out = [];
    const parser = createSSEParser((data) => out.push(data));
    parser.push(": OPENROUTER PROCESSING\n\nda");
    parser.push('ta: {"a":1}\r\n\r\ndata: [DONE]');
    parser.end();
    assert.deepEqual(out, ['{"a":1}', "[DONE]"]);
  });
});

describe("клиент OpenRouter", () => {
  const base = { baseUrl: "http://x", getKey: async () => "k", sleep: async () => {} };

  it("стримит текст и собирает usage", async () => {
    const pieces = [];
    const client = createOpenRouter({
      ...base,
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"вет"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":0.5}}\n\n',
          "data: [DONE]\n\n",
        ]),
    });
    const res = await client.chat({ model: "m", messages: [], maxTokens: 10, onDelta: (t) => pieces.push(t) });
    assert.equal(res.text, "Привет");
    assert.deepEqual(pieces, ["При", "вет"]);
    assert.deepEqual(res.usage, { promptTokens: 3, completionTokens: 2, cost: 0.5 });
    assert.equal(res.finish, "stop");
  });

  it("повторяет при 503 и сдаётся с понятной ошибкой на 402", async () => {
    let calls = 0;
    const client = createOpenRouter({
      ...base,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response("{}", { status: 503 });
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    });
    assert.equal((await client.chat({ model: "m", messages: [], maxTokens: 5 })).text, "ok");
    assert.equal(calls, 2);

    const broke = createOpenRouter({ ...base, fetchImpl: async () => Response.json({ error: { message: "no credits" } }, { status: 402 }) });
    await assert.rejects(broke.chat({ model: "m", messages: [], maxTokens: 5 }), /кредитов/);
  });

  it("ошибка посреди потока не повторяется и доходит до вызывающего", async () => {
    let calls = 0;
    const client = createOpenRouter({
      ...base,
      fetchImpl: async () => {
        calls += 1;
        return sseResponse(['data: {"choices":[{"delta":{"content":"начало"}}]}\n\n', 'data: {"error":{"code":502,"message":"provider died"}}\n\n']);
      },
    });
    await assert.rejects(client.chat({ model: "m", messages: [], maxTokens: 5, onDelta: () => {} }), /provider died/);
    assert.equal(calls, 1);
  });

  it("не отправляет неподдерживаемые параметры и требует ключ", async () => {
    let sent;
    const client = createOpenRouter({
      ...base,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return Response.json({ choices: [{ message: { content: "{}" } }] });
      },
    });
    await client.chat({ model: "m", messages: [], maxTokens: 5, temperature: 0.5, topP: 0.9, json: true, supports: (p) => p === "temperature" });
    assert.equal(sent.temperature, 0.5);
    assert.equal(sent.top_p, undefined);
    assert.equal(sent.response_format, undefined);

    const keyless = createOpenRouter({ ...base, getKey: async () => "", fetchImpl: async () => assert.fail("не должен звонить") });
    await assert.rejects(keyless.chat({ model: "m", messages: [], maxTokens: 5 }), /ключ/);
  });
});
