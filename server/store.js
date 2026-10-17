import fs from "node:fs/promises";
import path from "node:path";

/**
 * JSON-файл на диске с кешем в памяти и последовательными записями.
 * Запись атомарная: временный файл + rename, чтобы сбой не оставил
 * половину библиотеки.
 */
export class JsonFile {
  #file;
  #fallback;
  #cache = null;
  #queue = Promise.resolve();

  constructor(file, fallback) {
    this.#file = file;
    this.#fallback = fallback;
  }

  async read() {
    await this.#queue;
    return structuredClone(await this.#load());
  }

  /** fn получает изменяемую копию данных; её результат возвращается вызвавшему. */
  update(fn) {
    const run = this.#queue.then(async () => {
      const draft = structuredClone(await this.#load());
      const result = await fn(draft);
      await this.#save(draft);
      this.#cache = draft;
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #load() {
    if (this.#cache) return this.#cache;
    try {
      this.#cache = JSON.parse(await fs.readFile(this.#file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Повреждённый файл не затираем молча — откладываем копию рядом.
        await fs.copyFile(this.#file, `${this.#file}.broken-${Date.now()}`).catch(() => {});
      }
      this.#cache = structuredClone(this.#fallback);
    }
    return this.#cache;
  }

  async #save(value) {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.#file);
  }
}
