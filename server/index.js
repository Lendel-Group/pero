#!/usr/bin/env node
/**
 * Точка входа: `npm start`.
 *
 * Переменные окружения (все необязательны):
 *   PORT                 порт, по умолчанию 3000 (если занят — берётся следующий свободный)
 *   HOST                 адрес, по умолчанию 127.0.0.1 — сервер виден только с этого компьютера
 *   PERO_DATA_DIR        папка с библиотекой и настройками, по умолчанию ./data
 *   OPENROUTER_API_KEY   ключ OpenRouter; если задан, важнее ключа из настроек
 *   OPENROUTER_BASE_URL  адрес API, по умолчанию https://openrouter.ai/api/v1
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  console.error(`Нужен Node.js 20 или новее, у вас ${process.versions.node}. Скачайте: https://nodejs.org`);
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.HOST || "127.0.0.1";
const firstPort = Number(process.env.PORT) || 3000;
const dataDir = path.resolve(process.env.PERO_DATA_DIR || path.join(ROOT, "data"));
const shouldOpen = process.argv.includes("--open");

const { server } = createApp({
  dataDir,
  openrouterBase: process.env.OPENROUTER_BASE_URL || undefined,
  allowAnyHost: !["127.0.0.1", "localhost", "::1"].includes(host),
});

listen(firstPort);

function listen(port, attempt = 0) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < 10) return listen(port + 1, attempt + 1);
    console.error(`Не удалось запустить сервер: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const url = `http://${host === "127.0.0.1" || host === "::1" ? "localhost" : host}:${port}`;
    console.log("");
    console.log("  Перо запущено.");
    console.log(`  Откройте в браузере: ${url}`);
    console.log(`  Данные: ${dataDir}`);
    console.log("  Остановить: Ctrl+C");
    console.log("");
    if (shouldOpen) openBrowser(url);
  });
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* браузер не открылся — адрес уже напечатан */
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
