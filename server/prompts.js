/**
 * Сборка пользовательских сообщений для агентов. Чистые функции:
 * на вход — рассказ и антология, на выход — текст промпта.
 */

import {
  CONFLICTS,
  ENDINGS,
  LORE_TYPES,
  PACING,
  POV,
  TROPES,
  genreById,
  lengthFor,
  optionById,
  sceneCountFor,
  subgenreById,
} from "../shared/catalog.js";
import { apportion, mixLine } from "../shared/orchestrator.js";

const name = (list, id) => optionById(list, id)?.name ?? "—";

export function clip(value, max) {
  const clean = String(value ?? "").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Хвост текста: для «предыдущей сцены» важнее её конец, а не начало. */
export function tail(value, max) {
  const clean = String(value ?? "").trim();
  return clean.length > max ? `…${clean.slice(clean.length - max + 1)}` : clean;
}

export function settingsBlock(story) {
  const w = story.wizard;
  return [
    `Жанр: ${genreById(story.genreId)?.name ?? "—"}. Микс поджанров: ${mixLine(w.subgenres)}.`,
    `Тон: ${w.tone ?? "—"}. Темп: ${name(PACING, w.pacing)} (${sceneCountFor(w.pacing)} сцены). Точка зрения: ${name(POV, w.pov)}.`,
    `Конфликт: ${name(CONFLICTS, w.conflict)}. Тропы: ${w.tropes.map((id) => name(TROPES, id)).join(", ") || "—"}.`,
    `Тип финала: ${name(ENDINGS, w.ending)}.`,
    `Завязка от автора: ${clip(w.premise, 2000)}`,
  ].join("\n");
}

export function castBlock(story, project) {
  const lore = (project?.lore ?? []).filter((item) => story.wizard.loreIds.includes(item.id));
  const rows = [
    ...lore.map((item) => `- [${typeName(item.type)}] ${item.name}: ${clip(item.description, 400)}`),
    ...story.wizard.guests.map((guest) => `- [Персонаж] ${guest.name}: ${clip(guest.description, 400)}`),
    ...(story.concept?.characters ?? [])
      .filter((c) => !story.wizard.guests.some((g) => g.name.toLowerCase() === c.name.toLowerCase()))
      .filter((c) => !lore.some((l) => l.name.toLowerCase() === c.name.toLowerCase()))
      .map((c) => `- [Персонаж] ${c.name}${c.role ? ` (${c.role})` : ""}: ${clip(c.description, 300)}`),
  ];
  return rows.length ? `Действующие лица и сущности (не противоречь им):\n${rows.slice(0, 20).join("\n")}` : "";
}

/** Фон антологии: прочие записи лорбука, которые не выбраны в каст, — только для согласованности. */
export function worldBlock(story, project) {
  const rest = (project?.lore ?? []).filter((item) => !story.wizard.loreIds.includes(item.id));
  if (!rest.length) return "";
  return `Канон антологии (фон, использовать не обязательно, но не противоречить):\n${rest
    .slice(0, 25)
    .map((item) => `- [${typeName(item.type)}] ${item.name}: ${clip(item.description, 200)}`)
    .join("\n")}`;
}

export function conceptBlock(concept) {
  if (!concept) return "";
  const rows = [
    ["Логлайн", concept.logline],
    ["Тема", concept.theme],
    ["Главный вопрос", concept.question],
    ["Герой", concept.protagonist],
    ["Противостоящая сила", concept.antagonist],
    ["Место и время", concept.setting],
    ["Сквозные мотивы", concept.motifs],
  ].filter(([, value]) => value?.trim());
  return rows.length ? `Концепция:\n${rows.map(([k, v]) => `- ${k}: ${clip(v, 600)}`).join("\n")}` : "";
}

export function outlineBlock(outline) {
  return outline
    .map((card) => {
      const extra = [card.goal && `цель: ${card.goal}`, card.turn && `поворот: ${card.turn}`].filter(Boolean).join("; ");
      return `${card.n}. «${card.title}» [${subgenreById(card.writer)?.name ?? "—"}] — ${card.summary}${extra ? ` (${extra})` : ""}`;
    })
    .join("\n");
}

/**
 * Библия истории — общий контекст для всех агентов после Идеолога.
 * Уходит не в user, а первым блоком системного промпта (см. makeLLM):
 * одинаковое начало запроса у всех ролей провайдер берёт из кэша.
 */
export function bible(story, project) {
  return [
    story.title || story.wizard.title ? `Название: ${story.title || story.wizard.title}` : "",
    settingsBlock(story),
    conceptBlock(story.concept),
    castBlock(story, project),
    worldBlock(story, project),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function conceptPrompt(story, project) {
  return [
    settingsBlock(story),
    castBlock(story, project),
    worldBlock(story, project),
    story.wizard.title ? `Рабочее название автора: ${story.wizard.title}` : "",
    "Собери концепцию рассказа.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function outlinePrompt(story, { audit } = {}) {
  const w = story.wizard;
  const count = sceneCountFor(w.pacing);
  const voices = w.subgenres
    .map((item) => {
      const sub = subgenreById(item.id);
      return `- ${item.id} — «${sub.name}», ${item.weight}%: ${sub.blurb}`;
    })
    .join("\n");
  const draft = apportion(w.subgenres, count)
    .map((id, index) => `Сцена ${index + 1}: ${id}`)
    .join("\n");
  const parts = [
    `Доступные писатели (поле writer):\n${voices}`,
    `Черновая раскладка по весам:\n${draft}`,
    `Сцен должно быть ровно ${count}.`,
    w.title ? `Название задано автором — верни его без изменений: ${w.title}` : "Придумай название рассказа.",
  ];
  if (audit && story.outline.length) {
    parts.push(`Текущий план:\n${outlineBlock(story.outline)}`);
    parts.push(
      `Замечания сюжетного ревизора, которые нужно устранить:\n${audit.issues
        .map((issue) => `- ${issue.scene ? `Сцена ${issue.scene}` : "Весь план"}: ${issue.problem} → ${issue.fix}`)
        .join("\n")}`,
    );
    parts.push("Перепиши план с учётом замечаний, сохранив удачное.");
  }
  return parts.join("\n\n");
}

export function auditPrompt(story) {
  return [`План:\n${outlineBlock(story.outline)}`, "Проведи ревизию плана."].join("\n\n");
}

export function cardPrompt(story, n, instruction) {
  const card = story.outline.find((item) => item.n === n);
  return [
    `Весь план:\n${outlineBlock(story.outline)}`,
    `Пересобери только сцену ${n} («${card.title}»), сохранив связь с соседними. Писатель сцены остаётся ${card.writer}.`,
    instruction ? `Пожелание автора: ${clip(instruction, 500)}` : "",
    'Верни JSON: {"title":"...","summary":"...","goal":"...","turn":"..."}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function writerPrompt(story, n) {
  const card = story.outline.find((item) => item.n === n);
  const previous = story.scenes.filter((scene) => scene.n < n && scene.content.trim());
  const last = previous[previous.length - 1];
  const earlier = previous.slice(0, -1);
  return [
    `План рассказа:\n${outlineBlock(story.outline)}`,
    earlier.length ? `Начало рассказа (сжато):\n${earlier.map((scene) => `[${scene.n}] ${clip(scene.content, 900)}`).join("\n")}` : "",
    last ? `Предыдущая сцена (${last.n}) — продолжай с её конца, не пересказывай:\n${tail(last.content, 3500)}` : "Это первая сцена рассказа.",
    `Напиши сцену ${n} из ${story.outline.length}: «${card.title}». ${card.summary}`,
    card.goal ? `Цель героя в сцене: ${card.goal}` : "",
    card.turn ? `Сцена должна закончиться поворотом: ${card.turn}` : "",
    n === story.outline.length ? `Это финальная сцена: дай финал типа «${name(ENDINGS, story.wizard.ending)}» и ответь на главный вопрос рассказа.` : "",
    `Объём: ${lengthFor(story.wizard.length).words} слов.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Критик сцены: канон и взгляд читателя одним запросом. Отключённую
 * половину не просим — меньше и входа (прошлые сцены), и ответа.
 */
export function criticPrompt(story, n, draft, synth, { canon = true, reader = true } = {}) {
  const card = story.outline.find((item) => item.n === n);
  const previous = story.scenes.filter((scene) => scene.n < n && scene.content.trim());
  return [
    `Рассказ: ${story.title || story.wizard.title || "без названия"}. Тон: ${story.wizard.tone}. Точка зрения: ${name(POV, story.wizard.pov)}.`,
    `Жанровый голос сцены: «${synth.primary.name}»${synth.secondary ? ` с примесью «${synth.secondary.name}» (${synth.secondaryWeight}%)` : ""}.`,
    `План сцены ${n}: «${card.title}». ${card.summary}${card.turn ? ` Поворот: ${card.turn}` : ""}`,
    canon && (previous.length ? `Уже написано:\n${previous.map((scene) => `[Сцена ${scene.n}]\n${clip(scene.content, 4000)}`).join("\n\n")}` : "Это первая сцена, сверяй с библией."),
    !canon && "Канон не проверяй: issues — пустой список.",
    !reader && "Читательский разбор не нужен: score — null, strengths и notes — пустые списки.",
    `Черновик сцены ${n}:\n${draft}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function editorPrompt(story, n, draft, synth, { continuity, beta }) {
  const previous = story.scenes.find((scene) => scene.n === n - 1 && scene.content.trim());
  const notes = [];
  if (continuity?.issues?.length) {
    notes.push(`Нестыковки канона (исправить обязательно):\n${continuity.issues.map((i) => `- «${i.quote}» — ${i.problem} → ${i.fix}`).join("\n")}`);
  }
  if (beta?.notes?.length) {
    notes.push(`Заметки бета-ридера:\n${beta.notes.map((i) => `- ${i.quote ? `«${i.quote}» — ` : ""}${i.issue} → ${i.suggestion}`).join("\n")}`);
  }
  return [
    `Ведущий голос: «${synth.primary.name}» — ${synth.primary.writer.voice} Ритм: ${synth.primary.writer.rhythm}.`,
    synth.secondary ? `Второй голос: «${synth.secondary.name}», ${synth.secondaryWeight}%.` : "Второго голоса нет.",
    `Точка зрения: ${name(POV, story.wizard.pov)}. Тон: ${story.wizard.tone}.`,
    previous ? `Конец предыдущей сцены:\n${tail(previous.content, 1200)}` : "Это первая сцена.",
    notes.length ? notes.join("\n\n") : "Замечаний нет — сделай лёгкую стилистическую вычитку.",
    `Черновик сцены ${n}:\n${draft}`,
  ].join("\n\n");
}

/** knownNames === null — архивариус отключён, сущности не ищем. */
export function reviewPrompt(story, knownNames) {
  return [
    knownNames
      ? `Уже известные имена (их в lore не включай): ${knownNames.slice(0, 80).join(", ") || "нет"}.`
      : "Сущности для лорбука искать не нужно: lore — пустой список.",
    `Рассказ целиком:\n\n${story.scenes.map((scene) => scene.content).join("\n\n* * *\n\n")}`,
  ].join("\n\n");
}

export function lorePrompt(story, project, knownNames) {
  return [
    `Уже известные имена: ${knownNames.slice(0, 80).join(", ") || "нет"}.`,
    `Рассказ:\n\n${clip(story.scenes.map((scene) => scene.content).join("\n\n"), 24000)}`,
  ].join("\n\n");
}

function typeName(type) {
  return LORE_TYPES.find((item) => item.id === type)?.name ?? type;
}
