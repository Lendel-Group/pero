/**
 * Клиент OpenRouter: чат (обычный и потоковый), список моделей, сведения о ключе.
 * Только встроенный fetch, без SDK.
 */

export class OpenRouterError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.retryable = retryable;
  }
}

const TIMEOUT_MS = 240_000;
const RETRY_DELAYS = [1500, 4000];

export function createOpenRouter({ baseUrl, getKey, fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
  async function headers(requireKey) {
    const key = await getKey();
    if (!key && requireKey) {
      throw new OpenRouterError("Не задан ключ OpenRouter. Добавьте его в «Настройках».", { status: 401 });
    }
    return {
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost",
      "X-Title": "Pero",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    };
  }

  /**
   * Вызов модели. Если передан onDelta — потоковый режим, куски текста
   * приходят по мере генерации. Повторяет запрос при 429/5xx и сетевых
   * сбоях, но только пока не пришло ни одного куска текста.
   */
  async function chat({ model, messages, temperature, topP, maxTokens, json = false, signal, onDelta, supports }) {
    const can = (param) => (supports ? supports(param) : true);
    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      stream: Boolean(onDelta),
      usage: { include: true },
    };
    if (temperature !== undefined && can("temperature")) body.temperature = temperature;
    if (topP !== undefined && can("top_p")) body.top_p = topP;
    if (json && can("response_format")) body.response_format = { type: "json_object" };

    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
      let streamed = false;
      try {
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: await headers(true),
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) throw await httpError(res);
        if (!onDelta) return parseCompletion(await res.json(), model);
        return await readStream(res, (text) => {
          streamed = true;
          onDelta(text);
        }, model);
      } catch (error) {
        if (signal?.aborted) throw new OpenRouterError("Остановлено.", { status: 499 });
        lastError = normalizeError(error);
        if (!lastError.retryable || streamed || attempt === RETRY_DELAYS.length) throw lastError;
        await sleep(RETRY_DELAYS[attempt]);
      }
    }
    throw lastError;
  }

  async function listModels() {
    const res = await fetchImpl(`${baseUrl}/models`, {
      headers: await headers(false),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw await httpError(res);
    const body = await res.json();
    return (Array.isArray(body.data) ? body.data : [])
      .filter((m) => typeof m.id === "string" && outputsText(m))
      .map((m) => ({
        id: m.id,
        name: typeof m.name === "string" ? m.name : m.id,
        context: Number(m.context_length) || 0,
        promptPrice: perMillion(m.pricing?.prompt),
        completionPrice: perMillion(m.pricing?.completion),
        created: Number(m.created) || 0,
        params: Array.isArray(m.supported_parameters) ? m.supported_parameters : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async function keyInfo() {
    const res = await fetchImpl(`${baseUrl}/key`, {
      headers: await headers(true),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw await httpError(res);
    const data = (await res.json()).data ?? {};
    return {
      label: typeof data.label === "string" ? data.label : "",
      usage: num(data.usage),
      limit: num(data.limit),
      limitRemaining: num(data.limit_remaining),
      isFreeTier: Boolean(data.is_free_tier),
    };
  }

  return { chat, listModels, keyInfo };
}

/**
 * Разбор потока Server-Sent Events. Возвращает push(text) и end();
 * на каждое событие data: вызывает onData(строка).
 */
export function createSSEParser(onData) {
  let buffer = "";
  let dataLines = [];
  function flushEvent() {
    if (dataLines.length) onData(dataLines.join("\n"));
    dataLines = [];
  }
  function line(raw) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "") return flushEvent();
    if (text.startsWith(":")) return; // комментарий / keep-alive
    if (text.startsWith("data:")) dataLines.push(text.slice(text[5] === " " ? 6 : 5));
  }
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    },
    end() {
      if (buffer) line(buffer);
      buffer = "";
      flushEvent();
    },
  };
}

async function readStream(res, onDelta, requestedModel) {
  let text = "";
  let usage = null;
  let model = requestedModel;
  let finish = null;
  let failure = null;
  const parser = createSSEParser((data) => {
    if (data === "[DONE]" || failure) return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) {
      failure = new OpenRouterError(upstreamMessage(chunk.error), { status: Number(chunk.error.code) || 502 });
      return;
    }
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const piece = contentText(choice?.delta?.content);
    if (piece) {
      text += piece;
      onDelta(piece);
    }
  });
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    parser.push(decoder.decode(chunk, { stream: true }));
    if (failure) break;
  }
  parser.push(decoder.decode());
  parser.end();
  if (failure) throw failure;
  if (!text.trim()) throw new OpenRouterError("Модель вернула пустой ответ. Попробуйте ещё раз или выберите другую модель.", { status: 502, retryable: true });
  return { text, usage: normalizeUsage(usage), model, finish };
}

function parseCompletion(body, requestedModel) {
  if (body?.error) throw new OpenRouterError(upstreamMessage(body.error), { status: Number(body.error.code) || 502, retryable: true });
  const choice = body?.choices?.[0];
  const text = contentText(choice?.message?.content);
  if (!text.trim()) throw new OpenRouterError("Модель вернула пустой ответ. Попробуйте ещё раз или выберите другую модель.", { status: 502, retryable: true });
  return { text, usage: normalizeUsage(body.usage), model: body.model || requestedModel, finish: choice?.finish_reason ?? null };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).join("");
}

function normalizeUsage(usage) {
  if (!usage) return { promptTokens: 0, completionTokens: 0, cost: 0 };
  return {
    promptTokens: num(usage.prompt_tokens) ?? 0,
    completionTokens: num(usage.completion_tokens) ?? 0,
    cost: num(usage.cost) ?? 0,
  };
}

async function httpError(res) {
  let detail = "";
  try {
    const body = await res.json();
    detail = upstreamMessage(body?.error ?? body);
  } catch {
    /* тело не JSON — обойдёмся статусом */
  }
  return new OpenRouterError(explainStatus(res.status, detail), {
    status: res.status,
    retryable: res.status === 429 || res.status === 408 || res.status >= 500,
  });
}

export function explainStatus(status, detail = "") {
  const tail = detail ? ` (${detail.slice(0, 200)})` : "";
  switch (status) {
    case 400:
      return `Запрос отклонён моделью${tail}.`;
    case 401:
      return "Ключ OpenRouter не принят. Проверьте его в «Настройках».";
    case 402:
      return "На счёте OpenRouter не хватает кредитов для этого запроса.";
    case 403:
      return `Провайдер отказал в доступе или сработала модерация${tail}.`;
    case 404:
      return `Модель не найдена или недоступна. Выберите другую в «Настройках»${tail}.`;
    case 408:
      return "Модель не успела ответить. Попробуйте ещё раз.";
    case 429:
      return "Слишком много запросов: сработал лимит. Подождите немного.";
    default:
      return status >= 500 ? `Провайдер модели сейчас недоступен (${status}). Попробуйте позже или другую модель.` : `Ошибка OpenRouter (${status})${tail}.`;
  }
}

function normalizeError(error) {
  if (error instanceof OpenRouterError) return error;
  if (error?.name === "TimeoutError") return new OpenRouterError("Модель слишком долго не отвечает.", { status: 408, retryable: true });
  return new OpenRouterError("Не удалось связаться с OpenRouter. Проверьте интернет.", { status: 0, retryable: true });
}

function upstreamMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  const raw = error.metadata?.raw;
  const message = typeof error.message === "string" ? error.message : "";
  return typeof raw === "string" && raw.length < 200 && !message.includes(raw) ? `${message}: ${raw}` : message;
}

function outputsText(model) {
  const out = model.architecture?.output_modalities;
  return !Array.isArray(out) || out.includes("text");
}

function perMillion(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : null;
}

function num(value) {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? null : n;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
