/**
 * CompatibilityResolver
 *
 * Пара A×B заблокирована, если хотя бы одна сторона перечисляет другую
 * в incompatible. Блок снимается, если в выборе есть мост — поджанр из
 * объединения bridges обеих сторон (кроме самих A и B). Мост снимает
 * конкретную пару, а не весь жанр.
 */

import { subgenreById } from "./catalog.js";

export function pairBlock(a, b, selectedIds) {
  const blocked = a.incompatible.includes(b.id) || b.incompatible.includes(a.id);
  if (!blocked) return { blocked: false, lifts: [], liftedBy: null };
  const lifts = unique([...a.bridges, ...b.bridges]).filter((id) => id !== a.id && id !== b.id);
  const liftedBy = lifts.find((id) => selectedIds.includes(id)) ?? null;
  return { blocked: !liftedBy, lifts, liftedBy };
}

/**
 * Состояние каждого поджанра пула при текущем выборе:
 * selected | open | blocked (+ кем заблокирован и какие мосты помогут).
 */
export function resolveCompatibility(pool, selectedIds) {
  const selected = selectedIds.map(subgenreById).filter(Boolean);
  return pool.map((candidate) => {
    if (selectedIds.includes(candidate.id)) {
      return { id: candidate.id, status: "selected", blockedBy: [], liftBy: [] };
    }
    const hits = selected
      .map((other) => ({ other, block: pairBlock(candidate, other, [...selectedIds, candidate.id]) }))
      .filter((row) => row.block.blocked);
    if (hits.length === 0) return { id: candidate.id, status: "open", blockedBy: [], liftBy: [] };
    // Мост, который снимет сразу все блоки, предпочтительнее; иначе — любой из них.
    const common = hits
      .map((row) => row.block.lifts)
      .reduce((acc, lifts) => acc.filter((id) => lifts.includes(id)));
    const liftBy = (common.length ? common : unique(hits.flatMap((row) => row.block.lifts))).filter(
      (id) => !selectedIds.includes(id),
    );
    return {
      id: candidate.id,
      status: "blocked",
      blockedBy: hits.map((row) => row.other.id),
      liftBy,
      liftsAll: common.length > 0,
    };
  });
}

/** Все заблокированные пары внутри выбора. */
export function selectionConflicts(selectedIds) {
  const rows = selectedIds.map(subgenreById).filter(Boolean);
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (pairBlock(rows[i], rows[j], selectedIds).blocked) out.push([rows[i].id, rows[j].id]);
    }
  }
  return out;
}

/**
 * Убирает из выбора то, что стало конфликтным (например, сняли мост):
 * пока есть заблокированная пара, выбрасываем более поздний из двух.
 */
export function pruneSelection(selectedIds) {
  let kept = unique(selectedIds.filter((id) => subgenreById(id)));
  for (let conflicts = selectionConflicts(kept); conflicts.length > 0; conflicts = selectionConflicts(kept)) {
    const [, later] = conflicts[0];
    kept = kept.filter((id) => id !== later);
  }
  return kept;
}

function unique(values) {
  return [...new Set(values)];
}
