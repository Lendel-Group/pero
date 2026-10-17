/** Обращения к локальному серверу «Пера». */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON */
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Ошибка сервера (${res.status})`, res.status);
  return data;
}

export const get = (url) => api("GET", url);
export const post = (url, body = {}) => api("POST", url, body);
export const put = (url, body) => api("PUT", url, body);
export const del = (url) => api("DELETE", url);

/**
 * Запускает задачу агентов и читает поток событий.
 * onEvent получает каждое событие; результат — обновлённый рассказ.
 */
export async function runTask(storyId, task, input, { onEvent, signal } = {}) {
  const res = await fetch(`/api/stories/${storyId}/run/${task}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
    signal,
  });
  if (!res.headers.get("content-type")?.startsWith("text/event-stream")) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? `Ошибка сервера (${res.status})`, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let story = null;
  let failure = null;
  const handle = (block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (!data) return;
    const event = JSON.parse(data);
    if (event.type === "done") story = event.story;
    if (event.type === "error") failure = new ApiError(event.message, event.status);
    onEvent?.(event);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        handle(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new ApiError("Остановлено.", 499);
    throw error;
  }
  if (buffer.trim()) handle(buffer);
  if (failure) throw failure;
  if (!story) throw new ApiError("Поток оборвался до конца задачи.", 502);
  return story;
}
