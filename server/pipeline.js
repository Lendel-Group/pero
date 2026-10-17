/**
 * Конвейер агентов. Каждая задача получает контекст:
 *   llm(agentId, {...})  — вызов модели с учётом настроек и учётом расходов
 *   emit(event)          — событие в поток для браузера
 * и возвращает правку, которую сервер применит к рассказу.
 *
 * Модели вызываются вне блокировки файла библиотеки; запись — одной транзакцией в конце.
 */

import { randomUUID } from "node:crypto";
import { LORE_TYPES, lengthFor, sceneCountFor } from "../shared/catalog.js";
import { synthesizeWriter } from "../shared/orchestrator.js";
import { stepIssues } from "../shared/story.js";
import { AGENTS } from "./agents.js";
import { HttpError, cleanConcept, cleanOutline } from "./library.js";
import * as P from "./prompts.js";

export const TASKS = ["concept", "outline", "audit", "card", "scene", "review", "lore"];

export async function runTask(task, ctx) {
  switch (task) {
    case "concept":
      return concept(ctx);
    case "outline":
      return outline(ctx);
    case "audit":
      return audit(ctx);
    case "card":
      return card(ctx);
    case "scene":
      return scene(ctx);
    case "review":
      return review(ctx);
    case "lore":
      return lore(ctx);
    default:
      throw new HttpError(404, "Неизвестная задача.");
  }
}

function ensureStep(story, step) {
  const issues = stepIssues(story, step);
  if (issues.length) throw new HttpError(400, issues[0]);
}

// ── Идеолог ──────────────────────────────────────────────────

async function concept({ story, project, llm }) {
  ensureStep(story, 4);
  const data = await llm.json("concept", { user: P.conceptPrompt(story, project) });
  const result = cleanConcept({
    ...data,
    characters: Array.isArray(data.characters) ? data.characters : [],
  });
  if (!result.logline) throw new HttpError(502, "Идеолог не вернул логлайн. Попробуйте ещё раз.");
  return { concept: result };
}

// ── Архитектор ───────────────────────────────────────────────

async function outline({ story, project, llm, input }) {
  ensureStep(story, 4);
  const count = sceneCountFor(story.wizard.pacing);
  const useAudit = Boolean(input?.useAudit && story.audit?.issues?.length);
  const user = P.outlinePrompt(story, project, { audit: useAudit ? story.audit : null });
  let data = await llm.json("architect", { user });
  let scenes = Array.isArray(data.scenes) ? data.scenes : [];
  if (scenes.length !== count) {
    // Одна попытка исправиться: модели нередко теряют сцену.
    data = await llm.json("architect", {
      user: `${user}\n\nВ прошлый раз в плане было ${scenes.length} сцен вместо ${count}. Верни ровно ${count}.`,
    });
    scenes = Array.isArray(data.scenes) ? data.scenes : [];
  }
  if (scenes.length < count) throw new HttpError(502, `Архитектор вернул ${scenes.length} сцен вместо ${count}. Попробуйте ещё раз.`);
  const result = cleanOutline(scenes, story.wizard);
  if (result.some((cardItem) => !cardItem.title || !cardItem.summary)) {
    throw new HttpError(502, "План пришёл с пустыми карточками. Попробуйте ещё раз.");
  }
  const title = story.wizard.title || P.clip(typeof data.title === "string" ? data.title : "", 120);
  return { outline: result, title, audit: null, resetScenes: true };
}

// ── Сюжетный ревизор ─────────────────────────────────────────

async function audit({ story, project, llm }) {
  ensureStep(story, 6);
  const data = await llm.json("auditor", { user: P.auditPrompt(story, project) });
  return { audit: cleanAudit(data, story.outline.length) };
}

export function cleanAudit(data, scenes) {
  const issues = (Array.isArray(data?.issues) ? data.issues : [])
    .slice(0, 8)
    .map((item) => ({
      scene: Number.isInteger(Number(item?.scene)) && Number(item.scene) >= 0 && Number(item.scene) <= scenes ? Number(item.scene) : 0,
      severity: ["high", "medium", "low"].includes(item?.severity) ? item.severity : "medium",
      problem: P.clip(item?.problem, 400),
      fix: P.clip(item?.fix, 400),
    }))
    .filter((item) => item.problem);
  return { score: score(data?.score), verdict: P.clip(data?.verdict, 300), issues, at: new Date().toISOString() };
}

// ── Пересборка одной карточки ────────────────────────────────

async function card({ story, project, llm, input }) {
  ensureStep(story, 6);
  const n = Number(input?.n);
  const current = story.outline.find((item) => item.n === n);
  if (!current) throw new HttpError(404, "Сцена не найдена.");
  const data = await llm.json("architect", { user: P.cardPrompt(story, project, n, input?.instruction), temperature: 0.8 });
  const [next] = cleanOutline([{ ...data, writer: current.writer }], story.wizard);
  if (!next?.title || !next.summary) throw new HttpError(502, "Карточка пришла пустой. Попробуйте ещё раз.");
  const outline = story.outline.map((item) => (item.n === n ? { ...next, n } : item));
  return { outline, audit: null };
}

// ── Сцена: писатель → канон ∥ бета → редактор ───────────────

async function scene({ story, project, llm, emit, settings, input }) {
  ensureStep(story, 6);
  const n = Number(input?.n);
  const cardItem = story.outline.find((item) => item.n === n);
  if (!cardItem) throw new HttpError(404, "Сцена не найдена.");
  const length = lengthFor(story.wizard.length);
  const synth = synthesizeWriter({
    primaryId: cardItem.writer,
    secondaryId: cardItem.secondary,
    weights: story.wizard.subgenres,
    words: length.words,
  });
  if (!synth) throw new HttpError(400, "У сцены нет жанрового писателя.");

  emit({
    type: "plan",
    n,
    writer: synth.primary.name,
    secondary: synth.secondary ? { name: synth.secondary.name, weight: synth.secondaryWeight } : null,
  });

  const draftText = await llm.text("writer", {
    system: synth.system,
    user: P.writerPrompt(story, project, n),
    temperature: synth.temperature,
    topP: synth.topP,
    maxTokens: length.maxTokens,
    label: `Писатель «${synth.primary.name}»`,
  });
  const draft = cleanProse(draftText);
  if (draft.length < 200) throw new HttpError(502, "Сцена вышла слишком короткой. Попробуйте ещё раз.");

  const [continuity, beta] = await Promise.all([
    settings.agents.continuity !== false
      ? llm.json("continuity", { user: P.continuityPrompt(story, project, n, draft) }).then(cleanContinuity, softFail(emit, "continuity"))
      : null,
    settings.agents.beta !== false
      ? llm.json("beta", { user: P.betaPrompt(story, n, draft, synth) }).then(cleanBeta, softFail(emit, "beta"))
      : null,
  ]);
  if (continuity) emit({ type: "review", agent: "continuity", data: continuity });
  if (beta) emit({ type: "review", agent: "beta", data: beta });

  let content = draft;
  let edited = false;
  if (settings.agents.editor !== false) {
    try {
      emit({ type: "reset", n }); // браузер очищает поле и показывает поток редактора
      const editedText = cleanProse(
        await llm.text("editor", {
          user: P.editorPrompt(story, n, draft, synth, { continuity, beta }),
          maxTokens: length.maxTokens,
        }),
      );
      if (editedText.length >= draft.length * 0.5) {
        content = editedText;
        edited = true;
      } else {
        emit({ type: "notice", message: "Редактор сократил сцену слишком сильно — оставлен черновик писателя." });
      }
    } catch (error) {
      if (error.status === 499) throw error;
      emit({ type: "notice", message: `Редактор не ответил (${error.message}) — оставлен черновик писателя.` });
    }
  }

  return {
    scene: {
      n,
      content,
      draft,
      status: edited ? "EDITED" : "DRAFTED",
      writer: cardItem.writer,
      secondary: synth.secondary ? cardItem.secondary : null,
      continuity,
      beta,
      updatedAt: new Date().toISOString(),
    },
  };
}

function softFail(emit, agent) {
  return (error) => {
    if (error.status === 499) throw error;
    emit({ type: "notice", message: `${AGENTS[agent].name} не ответил: ${error.message}` });
    return null;
  };
}

export function cleanContinuity(data) {
  const issues = (Array.isArray(data?.issues) ? data.issues : [])
    .slice(0, 8)
    .map((item) => ({ quote: P.clip(item?.quote, 200), problem: P.clip(item?.problem, 400), fix: P.clip(item?.fix, 300) }))
    .filter((item) => item.problem);
  return { issues };
}

export function cleanBeta(data) {
  return {
    score: score(data?.score),
    strengths: (Array.isArray(data?.strengths) ? data.strengths : []).slice(0, 4).map((s) => P.clip(s, 300)).filter(Boolean),
    notes: (Array.isArray(data?.notes) ? data.notes : [])
      .slice(0, 6)
      .map((item) => ({ quote: P.clip(item?.quote, 200), issue: P.clip(item?.issue, 400), suggestion: P.clip(item?.suggestion, 400) }))
      .filter((item) => item.issue),
  };
}

/** Снимает обёртки, которые модели любят добавлять к прозе. */
export function cleanProse(raw) {
  let textValue = String(raw ?? "").trim();
  const fenced = textValue.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fenced) textValue = fenced[1].trim();
  textValue = textValue.replace(/^(#{1,6}\s*)?(Сцена|Глава)\s*\d+[^\n]*\n+/i, "");
  textValue = textValue.replace(/^\*\*[^*\n]{1,80}\*\*\n+/, "");
  return textValue.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Рецензент ────────────────────────────────────────────────

async function review({ story, project, llm }) {
  requireComplete(story);
  const data = await llm.json("reviewer", { user: P.reviewPrompt(story, project) });
  const list = (value, max, len) => (Array.isArray(value) ? value : []).slice(0, max).map((s) => P.clip(s, len)).filter(Boolean);
  return {
    review: {
      score: score(data?.score),
      summary: P.clip(data?.summary, 1200),
      strengths: list(data?.strengths, 5, 400),
      weaknesses: list(data?.weaknesses, 5, 400),
      endingFit: P.clip(data?.endingFit, 500),
      suggestions: list(data?.suggestions, 5, 400),
      titles: list(data?.titles, 3, 120),
      blurb: P.clip(data?.blurb, 800),
      at: new Date().toISOString(),
    },
  };
}

// ── Архивариус ───────────────────────────────────────────────

async function lore({ story, project, llm }) {
  requireComplete(story);
  const known = [
    ...(project?.lore ?? []).map((item) => item.name),
    ...story.wizard.guests.map((guest) => guest.name),
  ];
  const data = await llm.json("lore", { user: P.lorePrompt(story, project, known) });
  const lowerKnown = new Set(known.map((item) => item.toLowerCase()));
  const suggestions = (Array.isArray(data?.suggestions) ? data.suggestions : [])
    .slice(0, 6)
    .map((item) => ({
      id: randomUUID(),
      type: LORE_TYPES.some((t) => t.id === item?.type) ? item.type : "CHARACTER",
      name: P.clip(item?.name, 80),
      description: P.clip(item?.description, 500),
      accepted: false,
    }))
    .filter((item) => item.name && item.description && !lowerKnown.has(item.name.toLowerCase()));
  return { suggestions };
}

function requireComplete(story) {
  ensureStep(story, 6);
  if (story.scenes.some((item) => !item.content.trim())) throw new HttpError(400, "Сначала допишите все сцены.");
}

// ── Разбор JSON из ответа модели ─────────────────────────────

export function parseJsonReply(raw) {
  const value = String(raw ?? "").trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : value;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function score(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : null;
}
