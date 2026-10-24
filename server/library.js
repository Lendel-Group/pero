/**
 * Библиотека: антологии (проекты с лорбуком) и рассказы.
 * Все функции работают с объектом библиотеки и чистят любой ввод из браузера.
 */

import { randomUUID } from "node:crypto";
import {
  CONFLICTS,
  ENDINGS,
  LENGTHS,
  LORE_TYPES,
  MAX_TROPES,
  MAX_VOICES,
  PACING,
  POV,
  TROPES,
  genreById,
  sceneCountFor,
  subgenreById,
  tonesFor,
} from "../shared/catalog.js";
import { pruneSelection } from "../shared/compatibility.js";
import { normalizeWeights } from "../shared/weights.js";
import { secondaryFor } from "../shared/orchestrator.js";
import { blankConcept, blankWizard } from "../shared/story.js";

export function emptyLibrary() {
  return { version: 1, projects: [], stories: [] };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();

// ── Антологии ────────────────────────────────────────────────

export function createProject(lib, input) {
  const title = text(input?.title, 100);
  if (!title) throw new HttpError(400, "Назовите антологию.");
  if (!genreById(input?.genreId)) throw new HttpError(400, "Выберите жанр антологии.");
  const project = { id: randomUUID(), title, genreId: input.genreId, lore: [], createdAt: now(), updatedAt: now() };
  lib.projects.unshift(project);
  return project;
}

export function getProject(lib, id) {
  const project = lib.projects.find((item) => item.id === id);
  if (!project) throw new HttpError(404, "Антология не найдена.");
  return project;
}

export function updateProject(lib, id, input) {
  const project = getProject(lib, id);
  if (input?.title !== undefined) {
    const title = text(input.title, 100);
    if (!title) throw new HttpError(400, "Название не может быть пустым.");
    project.title = title;
  }
  project.updatedAt = now();
  return project;
}

export function deleteProject(lib, id) {
  getProject(lib, id);
  lib.projects = lib.projects.filter((item) => item.id !== id);
  // Рассказы остаются, но становятся самостоятельными.
  for (const story of lib.stories) {
    if (story.projectId !== id) continue;
    story.projectId = null;
    story.wizard.loreIds = [];
    story.updatedAt = now();
  }
}

export function addLore(lib, projectId, input) {
  const project = getProject(lib, projectId);
  const entity = cleanLore(input);
  if (project.lore.length >= 200) throw new HttpError(400, "Лорбук переполнен (200 записей).");
  if (project.lore.some((item) => item.name.toLowerCase() === entity.name.toLowerCase() && item.type === entity.type)) {
    throw new HttpError(409, `«${entity.name}» уже есть в лорбуке.`);
  }
  const record = { id: randomUUID(), ...entity };
  project.lore.push(record);
  project.updatedAt = now();
  return record;
}

export function updateLore(lib, projectId, loreId, input) {
  const project = getProject(lib, projectId);
  const index = project.lore.findIndex((item) => item.id === loreId);
  if (index < 0) throw new HttpError(404, "Запись лорбука не найдена.");
  project.lore[index] = { id: loreId, ...cleanLore(input) };
  project.updatedAt = now();
  return project.lore[index];
}

export function removeLore(lib, projectId, loreId) {
  const project = getProject(lib, projectId);
  project.lore = project.lore.filter((item) => item.id !== loreId);
  for (const story of lib.stories) {
    if (story.projectId === projectId) story.wizard.loreIds = story.wizard.loreIds.filter((id) => id !== loreId);
  }
  project.updatedAt = now();
}

function cleanLore(input) {
  const type = LORE_TYPES.some((item) => item.id === input?.type) ? input.type : null;
  const name = text(input?.name, 80);
  const description = text(input?.description, 600);
  if (!type) throw new HttpError(400, "Неизвестный тип записи.");
  if (!name) throw new HttpError(400, "Нужно имя или название.");
  return { type, name, description };
}

// ── Рассказы ─────────────────────────────────────────────────

export function createStory(lib, input) {
  const project = input?.projectId ? getProject(lib, input.projectId) : null;
  const story = {
    id: randomUUID(),
    projectId: project?.id ?? null,
    genreId: project?.genreId ?? null,
    title: "",
    step: project ? 2 : 1,
    status: "DRAFT",
    wizard: blankWizard(),
    concept: null,
    outline: [],
    audit: null,
    scenes: [],
    review: null,
    suggestions: [],
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cost: 0, calls: 0 },
    createdAt: now(),
    updatedAt: now(),
  };
  lib.stories.unshift(story);
  return story;
}

export function getStory(lib, id) {
  const story = lib.stories.find((item) => item.id === id);
  if (!story) throw new HttpError(404, "Рассказ не найден.");
  return story;
}

export function deleteStory(lib, id) {
  getStory(lib, id);
  lib.stories = lib.stories.filter((item) => item.id !== id);
}

export function storySummary(story) {
  return {
    id: story.id,
    projectId: story.projectId,
    genreId: story.genreId,
    title: story.title || story.wizard.title,
    status: story.status,
    step: story.step,
    subgenres: story.wizard.subgenres,
    scenes: story.outline.length,
    written: story.scenes.filter((scene) => scene.content.trim()).length,
    updatedAt: story.updatedAt,
  };
}

/** Применяет правку из мастера. Всё, что не проходит проверку, отбрасывается или чинится. */
export function patchStory(lib, id, patch) {
  const story = getStory(lib, id);
  if (!patch || typeof patch !== "object") throw new HttpError(400, "Пустая правка.");

  if ("projectId" in patch || "genreId" in patch) setContext(lib, story, patch);
  const project = story.projectId ? getProject(lib, story.projectId) : null;

  if (patch.wizard && typeof patch.wizard === "object") {
    story.wizard = cleanWizard({ ...story.wizard, ...patch.wizard }, story.genreId, project);
    if (story.outline.length && !Array.isArray(patch.outline)) {
      // Микс или темп могли поменяться — писатели сцен должны остаться из микса.
      story.outline = cleanOutline(story.outline, story.wizard);
      alignScenes(story);
    }
  }
  if ("concept" in patch) story.concept = patch.concept ? cleanConcept(patch.concept) : null;
  if (Array.isArray(patch.outline)) {
    story.outline = cleanOutline(patch.outline, story.wizard);
    alignScenes(story);
  }
  if (typeof patch.title === "string") story.title = text(patch.title, 120);
  if (Array.isArray(patch.scenes)) {
    for (const edit of patch.scenes.slice(0, 10)) {
      const scene = story.scenes.find((item) => item.n === Number(edit?.n));
      if (!scene || typeof edit.content !== "string") continue;
      scene.content = multiline(edit.content, 20_000);
      scene.status = scene.content ? "EDITED" : "EMPTY";
      scene.updatedAt = now();
    }
  }
  if (Number.isInteger(patch.step) && patch.step >= 1 && patch.step <= 7) story.step = patch.step;
  if (Array.isArray(patch.suggestions)) {
    // Разрешено только отклонять предложения архивариуса.
    const keep = new Set(patch.suggestions.map(String));
    story.suggestions = story.suggestions.filter((item) => keep.has(item.id));
  }
  refreshStatus(story);
  story.updatedAt = now();
  return story;
}

function setContext(lib, story, patch) {
  const projectId = patch.projectId ?? null;
  const project = projectId ? getProject(lib, projectId) : null;
  const genreId = project ? project.genreId : genreById(patch.genreId) ? patch.genreId : story.genreId;
  if (story.projectId !== (project?.id ?? null)) story.wizard.loreIds = [];
  story.projectId = project?.id ?? null;
  if (genreId !== story.genreId) {
    story.genreId = genreId;
    story.wizard = { ...story.wizard, subgenres: [], tone: null };
    story.outline = [];
    story.audit = null;
    alignScenes(story);
  }
}

export function cleanWizard(input, genreId, project) {
  const base = blankWizard();
  const ids = list(input.subgenres)
    .map((item) => ({ id: String(item?.id ?? ""), weight: Number(item?.weight) || 0 }))
    .filter((item) => subgenreById(item.id)?.genreId === genreId)
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
    .slice(0, MAX_VOICES);
  const keptIds = pruneSelection(ids.map((item) => item.id));
  const subgenres = normalizeWeights(ids.filter((item) => keptIds.includes(item.id)));
  const { tones } = tonesFor(subgenres.map((item) => item.id));
  const loreIds = new Set(project?.lore.map((item) => item.id) ?? []);
  return {
    subgenres,
    tone: tones.includes(input.tone) ? input.tone : null,
    pacing: pick(PACING, input.pacing) ?? base.pacing,
    pov: pick(POV, input.pov) ?? base.pov,
    length: pick(LENGTHS, input.length) ?? base.length,
    conflict: pick(CONFLICTS, input.conflict),
    tropes: [...new Set(list(input.tropes).filter((id) => pick(TROPES, id)))].slice(0, MAX_TROPES),
    loreIds: [...new Set(list(input.loreIds).filter((id) => loreIds.has(id)))].slice(0, 20),
    guests: list(input.guests)
      .slice(0, 8)
      .map((guest) => ({
        id: typeof guest?.id === "string" && guest.id.length <= 64 ? guest.id : randomUUID(),
        name: text(guest?.name, 80),
        description: text(guest?.description, 400),
      }))
      .filter((guest) => guest.name),
    premise: multiline(input.premise, 2000),
    ending: pick(ENDINGS, input.ending),
    title: text(input.title, 120),
  };
}

export function cleanConcept(input) {
  const base = blankConcept();
  const out = {};
  for (const key of Object.keys(base)) {
    if (key === "characters") continue;
    out[key] = multiline(input?.[key], 600);
  }
  out.characters = list(input?.characters)
    .slice(0, 8)
    .map((item) => ({ name: text(item?.name, 80), role: text(item?.role, 80), description: text(item?.description, 400) }))
    .filter((item) => item.name);
  return out;
}

/** План: ровно столько сцен, сколько даёт темп; писатель — только из микса. */
export function cleanOutline(input, wizard) {
  const allowed = wizard.subgenres.map((item) => item.id);
  const count = sceneCountFor(wizard.pacing);
  return list(input)
    .slice(0, count)
    .map((card, index) => {
      const writer = allowed.includes(card?.writer) ? card.writer : (allowed[0] ?? null);
      return {
        n: index + 1,
        title: text(card?.title, 120),
        summary: multiline(card?.summary, 1200),
        goal: text(card?.goal, 300),
        turn: text(card?.turn, 300),
        writer,
        secondary: writer ? secondaryFor(wizard.subgenres, writer) : null,
      };
    });
}

/** Держит массив сцен в соответствии с планом. Текст уже написанных сцен сохраняется. */
export function alignScenes(story) {
  story.scenes = story.outline.map((card) => {
    const existing = story.scenes.find((scene) => scene.n === card.n);
    return (
      existing ?? {
        n: card.n,
        content: "",
        draft: "",
        status: "EMPTY",
        writer: null,
        secondary: null,
        continuity: null,
        beta: null,
        updatedAt: null,
      }
    );
  });
}

export function refreshStatus(story) {
  const count = sceneCountFor(story.wizard.pacing);
  const ready = story.outline.length === count && count > 0;
  const written = story.scenes.filter((scene) => scene.content.trim()).length;
  if (ready && written === story.outline.length) story.status = "COMPLETED";
  else if (ready && written > 0) story.status = "WRITING";
  else if (ready) story.status = "OUTLINE_READY";
  else story.status = "DRAFT";
}

export function addUsage(story, usage) {
  if (!usage) return;
  story.usage.promptTokens += usage.promptTokens || 0;
  story.usage.completionTokens += usage.completionTokens || 0;
  // У рассказов, созданных до появления этих полей, их ещё нет.
  story.usage.cachedTokens = (story.usage.cachedTokens || 0) + (usage.cachedTokens || 0);
  story.usage.reasoningTokens = (story.usage.reasoningTokens || 0) + (usage.reasoningTokens || 0);
  story.usage.cost = Math.round((story.usage.cost + (usage.cost || 0)) * 1e6) / 1e6;
  story.usage.calls += 1;
}

// ── мелкие помощники ─────────────────────────────────────────

function text(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function multiline(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function pick(options, id) {
  return options.some((item) => item.id === id) ? id : null;
}

export { text as cleanText, multiline as cleanMultiline };
