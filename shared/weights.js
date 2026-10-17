/**
 * Веса микса поджанров. Инвариант: целые проценты, сумма ровно 100,
 * у каждого голоса не меньше MIN_WEIGHT, если голосов больше одного.
 */

export const MIN_WEIGHT = 5;

/** Метод наибольшего остатка: дробные доли → целые, сумма = target. */
export function largestRemainder(parts, target) {
  const rows = parts.map((part) => {
    const floor = Math.floor(part.exact + 1e-9);
    return { id: part.id, weight: floor, frac: part.exact - floor };
  });
  let used = rows.reduce((sum, row) => sum + row.weight, 0);
  const byFraction = [...rows].sort((a, b) => b.frac - a.frac || a.id.localeCompare(b.id));
  for (const row of byFraction) {
    if (used >= target) break;
    row.weight += 1;
    used += 1;
  }
  return rows.map(({ id, weight }) => ({ id, weight }));
}

export function equalize(ids) {
  if (ids.length === 0) return [];
  return largestRemainder(
    ids.map((id) => ({ id, exact: 100 / ids.length })),
    100,
  );
}

export function toggleVoice(items, id, maxVoices) {
  if (items.some((item) => item.id === id)) {
    return equalize(items.filter((item) => item.id !== id).map((item) => item.id));
  }
  if (items.length >= maxVoices) return items.map((item) => ({ ...item }));
  return equalize([...items.map((item) => item.id), id]);
}

/** Ставит вес одному голосу, остальные пропорционально делят остаток. */
export function setVoiceWeight(items, id, raw) {
  if (!items.some((item) => item.id === id)) return items.map((item) => ({ ...item }));
  if (items.length === 1) return [{ id, weight: 100 }];
  const max = 100 - MIN_WEIGHT * (items.length - 1);
  const next = clamp(Math.round(Number(raw) || 0), MIN_WEIGHT, max);
  const others = items.filter((item) => item.id !== id);
  const rest = 100 - next;
  const spare = rest - MIN_WEIGHT * others.length;
  const othersSpare = others.reduce((sum, item) => sum + Math.max(0, item.weight - MIN_WEIGHT), 0);
  const balanced = largestRemainder(
    others.map((item) => ({
      id: item.id,
      exact:
        MIN_WEIGHT +
        (othersSpare <= 0 ? spare / others.length : (Math.max(0, item.weight - MIN_WEIGHT) / othersSpare) * spare),
    })),
    rest,
  );
  return items.map((item) =>
    item.id === id ? { id, weight: next } : { id: item.id, weight: balanced.find((row) => row.id === item.id).weight },
  );
}

/** Приводит произвольный ввод к инварианту, сохраняя пропорции. */
export function normalizeWeights(items) {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ id: items[0].id, weight: 100 }];
  const raw = items.map((item) => ({ id: item.id, value: Math.max(0, Number(item.weight) || 0) }));
  const total = raw.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return equalize(raw.map((item) => item.id));
  const spare = 100 - MIN_WEIGHT * raw.length;
  return largestRemainder(
    raw.map((item) => ({ id: item.id, exact: MIN_WEIGHT + (item.value / total) * spare })),
    100,
  );
}

export function weightSum(items) {
  return items.reduce((sum, item) => sum + item.weight, 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
