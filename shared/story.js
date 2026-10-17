/**
 * Модель рассказа и проверки готовности шагов мастера.
 * Один и тот же код решает, можно ли идти дальше, в браузере
 * и на сервере перед вызовом агентов.
 */

import { MAX_TROPES, PACING, POV, LENGTHS, CONFLICTS, ENDINGS, genreById, sceneCountFor, tonesFor } from "./catalog.js";
import { selectionConflicts } from "./compatibility.js";
import { weightSum } from "./weights.js";

export const STEPS = [
  { n: 1, name: "Контекст" },
  { n: 2, name: "Микс" },
  { n: 3, name: "Тон и оптика" },
  { n: 4, name: "Ядро" },
  { n: 5, name: "Концепция" },
  { n: 6, name: "План" },
  { n: 7, name: "Рукопись" },
];

export const STATUS_LABEL = {
  DRAFT: "Черновик мастера",
  OUTLINE_READY: "План готов",
  WRITING: "Пишется",
  COMPLETED: "Готов",
};

export function blankWizard() {
  return {
    subgenres: [],
    tone: null,
    pacing: "even",
    pov: "third-close",
    length: "medium",
    conflict: null,
    tropes: [],
    loreIds: [],
    guests: [],
    premise: "",
    ending: null,
    title: "",
  };
}

export function blankConcept() {
  return {
    logline: "",
    theme: "",
    question: "",
    protagonist: "",
    antagonist: "",
    setting: "",
    motifs: "",
    characters: [],
  };
}

/** Что мешает уйти дальше с шага n (пустой массив — можно). */
export function stepIssues(story, n) {
  const w = story.wizard;
  const issues = [];
  if (n >= 1 && !genreById(story.genreId)) issues.push("Выберите жанр или антологию.");
  if (n >= 2) {
    if (w.subgenres.length === 0) issues.push("Выберите хотя бы один поджанр.");
    else if (weightSum(w.subgenres) !== 100) issues.push("Веса поджанров должны давать 100%.");
    if (selectionConflicts(w.subgenres.map((item) => item.id)).length > 0) issues.push("В миксе остался конфликт поджанров.");
  }
  if (n >= 3) {
    const { tones } = tonesFor(w.subgenres.map((item) => item.id));
    if (!w.tone || !tones.includes(w.tone)) issues.push("Выберите тон.");
    if (!PACING.some((item) => item.id === w.pacing)) issues.push("Выберите темп.");
    if (!POV.some((item) => item.id === w.pov)) issues.push("Выберите точку зрения.");
    if (!LENGTHS.some((item) => item.id === w.length)) issues.push("Выберите длину сцен.");
  }
  if (n >= 4) {
    if (!CONFLICTS.some((item) => item.id === w.conflict)) issues.push("Выберите тип конфликта.");
    if (w.tropes.length < 1 || w.tropes.length > MAX_TROPES) issues.push(`Выберите 1–${MAX_TROPES} тропа.`);
    if (w.premise.trim().length < 15) issues.push("Опишите завязку хотя бы одним предложением.");
    if (!ENDINGS.some((item) => item.id === w.ending)) issues.push("Выберите тип финала.");
  }
  if (n >= 6) {
    const count = sceneCountFor(w.pacing);
    if (story.outline.length !== count) issues.push(`Нужен план из ${count} сцен.`);
    else if (story.outline.some((card) => !card.title.trim() || !card.summary.trim()))
      issues.push("У каждой сцены должны быть название и описание.");
  }
  return issues;
}

export function storyTitle(story) {
  return story.title?.trim() || story.wizard.title.trim() || "Без названия";
}

export function scenesDone(story) {
  return story.scenes.filter((scene) => scene.content.trim()).length;
}
