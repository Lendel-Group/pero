/**
 * Оркестратор: раскладка сцен по голосам и синтез промпта писателя.
 * Модель не вызывает — только собирает системный промпт ведущего
 * жанрового писателя и вмешивает директивы второго голоса в дозе веса.
 */

import { largestRemainder } from "./weights.js";
import { subgenreById } from "./catalog.js";

/** Общие для всех писателей запреты: нейросетевые штампы и служебщина. */
export const HOUSE_TABOOS = [
  "не называй жанр и не подписывай сцену",
  "без «в воздухе повисло», «сердце пропустило удар», «время словно остановилось», «лёгкая улыбка тронула губы», «не мог не заметить», «в самом сердце», «что-то неуловимое»",
  "не объясняй мораль последним абзацем",
  "не пересказывай чувства словами «он почувствовал, что…» — показывай действием и деталью",
];

export function mixLine(weights) {
  return sortByWeight(weights)
    .map((item) => `${subgenreById(item.id)?.name ?? item.id} ${item.weight}%`)
    .join(" · ");
}

/** Раздаёт сцены голосам по весам и чередует, чтобы тяжёлый голос не слипался в ком. */
export function apportion(weights, scenes) {
  if (weights.length === 0 || scenes <= 0) return [];
  const total = weights.reduce((sum, item) => sum + item.weight, 0) || 1;
  const left = largestRemainder(
    weights.map((item) => ({ id: item.id, exact: (item.weight / total) * scenes })),
    scenes,
  );
  const placed = new Map(left.map((item) => [item.id, 0]));
  const sequence = [];
  while (sequence.length < scenes) {
    const pool = left.filter((item) => item.weight > 0);
    if (pool.length === 0) break;
    const previous = sequence[sequence.length - 1];
    pool.sort(
      (a, b) =>
        Number(a.id === previous) - Number(b.id === previous) ||
        placed.get(a.id) - placed.get(b.id) ||
        b.weight - a.weight ||
        a.id.localeCompare(b.id),
    );
    const pick = pool[0];
    sequence.push(pick.id);
    placed.set(pick.id, placed.get(pick.id) + 1);
    pick.weight -= 1;
  }
  return sequence;
}

/** Второй голос сцены — самый тяжёлый из остальных поджанров микса. */
export function secondaryFor(weights, primaryId) {
  return sortByWeight(weights.filter((item) => item.id !== primaryId))[0]?.id ?? null;
}

export function writerSystemPrompt(subgenre, words) {
  const w = subgenre.writer;
  return [
    `Ты — писатель в манере «${w.name}». Пишешь ровно одну сцену короткого рассказа на русском языке, ${words} слов.`,
    w.voice,
    `Словарь, из которого можно брать (не обязательно всё): ${w.lexicon.join(", ")}.`,
    `Ритм: ${w.rhythm}.`,
    `Табу: ${[...w.taboos, ...HOUSE_TABOOS].join("; ")}.`,
    `Ориентиры по интонации (не цитировать, не заимствовать сюжеты): ${w.references.join(", ")}.`,
    "Опирайся на библию истории, план и предыдущий текст, но не пересказывай их. Не забегай в следующую сцену.",
    "Верни только текст сцены: без заголовка, без списков, без пометок автора и без кавычек-ёлочек вокруг всего текста.",
  ].join("\n");
}

/**
 * Синтез промпта сцены. Возвращает системный промпт, усреднённые
 * temperature / top_p и описание дозировки второго голоса.
 */
export function synthesizeWriter({ primaryId, secondaryId, weights, words }) {
  const primary = subgenreById(primaryId);
  if (!primary) return null;
  const secondary = secondaryId && secondaryId !== primaryId ? subgenreById(secondaryId) : null;
  const primaryWeight = weights.find((item) => item.id === primaryId)?.weight ?? 100;
  const secondaryWeight = secondary ? (weights.find((item) => item.id === secondary.id)?.weight ?? 0) : 0;
  let system = writerSystemPrompt(primary, words);
  const active = secondary && secondaryWeight > 0 ? secondary : null;
  if (active) {
    const dose = doseOf(secondaryWeight);
    const d = active.writer;
    system += [
      "",
      "",
      `ВТОРОЙ ГОЛОС — «${d.name}» (${secondaryWeight}% микса против ${primaryWeight}% у ведущего). Вмешивай его ${dose.instruction}. Сюжет и интонацию сцены ведёт первый голос.`,
      `Лексика второго голоса: ${d.lexicon.join(", ")}.`,
      `Ритм второго голоса: ${d.rhythm}.`,
      `Табу второго голоса тоже действуют: ${d.taboos.join("; ")}.`,
    ].join("\n");
  }
  const share = active ? secondaryWeight / (primaryWeight + secondaryWeight) : 0;
  const temperature = round(primary.writer.temperature * (1 - share) + (active?.writer.temperature ?? 0) * share);
  const topP = temperature > 0.85 ? 0.95 : 0.9;
  return {
    system,
    temperature,
    topP,
    primary,
    secondary: active,
    primaryWeight,
    secondaryWeight: active ? secondaryWeight : 0,
  };
}

export function doseOf(weight) {
  if (weight >= 40) return { label: "на равных", instruction: "заметно: почти на равных в ритме и словаре" };
  if (weight >= 20) return { label: "ощутимо", instruction: "ощутимо: в деталях, лексике и паре ритмических ходов" };
  return { label: "привкусом", instruction: "тонко, лёгким привкусом в одной-двух деталях" };
}

export function doseLine(primaryId, secondaryId, weights) {
  const primary = subgenreById(primaryId);
  if (!primary) return "";
  const secondary = secondaryId ? subgenreById(secondaryId) : null;
  const weight = secondary ? (weights.find((item) => item.id === secondary.id)?.weight ?? 0) : 0;
  if (!secondary || weight <= 0) return `Ведёт «${primary.name}»`;
  return `Ведёт «${primary.name}», «${secondary.name}» ${doseOf(weight).label}`;
}

function sortByWeight(weights) {
  return [...weights].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
