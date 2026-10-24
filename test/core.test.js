import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GENRES, SUBGENRES, TONES, subgenresOf, tonesFor } from "../shared/catalog.js";
import { pairBlock, pruneSelection, resolveCompatibility, selectionConflicts } from "../shared/compatibility.js";
import { apportion, secondaryFor, synthesizeWriter } from "../shared/orchestrator.js";
import { equalize, normalizeWeights, setVoiceWeight, toggleVoice, weightSum } from "../shared/weights.js";
import { blankWizard, stepIssues } from "../shared/story.js";
import { applyEdits, cleanProse, needsEditor, parseJsonReply } from "../server/pipeline.js";
import { cleanOutline, cleanWizard } from "../server/library.js";

const byId = (id) => SUBGENRES.find((s) => s.id === id);

describe("каталог", () => {
  it("целостен: ссылки и тона существуют, у каждого жанра есть поджанры", () => {
    const ids = new Set(SUBGENRES.map((s) => s.id));
    for (const s of SUBGENRES) {
      for (const ref of [...s.incompatible, ...s.bridges]) {
        assert.ok(ids.has(ref), `${s.id} → ${ref}`);
        assert.equal(byId(ref).genreId, s.genreId, `${s.id} → ${ref}: другой жанр`);
      }
      for (const tone of s.tones) assert.ok(TONES.includes(tone), `${s.id}: тон ${tone}`);
      assert.ok(s.writer.voice && s.writer.lexicon.length && s.writer.rhythm);
      assert.ok(s.writer.temperature > 0 && s.writer.temperature <= 1.2);
    }
    for (const g of GENRES) assert.ok(subgenresOf(g.id).length >= 4);
    assert.equal(new Set(SUBGENRES.map((s) => s.id)).size, SUBGENRES.length);
  });

  it("тона: пересечение, а без общего — объединение", () => {
    assert.equal(tonesFor(["det-noir", "det-psych"]).mode, "intersection");
    assert.ok(tonesFor(["det-noir", "det-psych"]).tones.includes("меланхоличный"));
    assert.equal(tonesFor(["sf-solar", "sf-hard"]).mode, "union");
  });
});

describe("CompatibilityResolver", () => {
  const det = subgenresOf("det");

  it("блокирует несовместимое, пока не выбран мост", () => {
    const blocked = resolveCompatibility(det, ["det-noir"]).find((row) => row.id === "det-cozy");
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.blockedBy, ["det-noir"]);
    assert.deepEqual(blocked.liftBy, ["det-psych"]);
    const lifted = resolveCompatibility(det, ["det-noir", "det-psych"]).find((row) => row.id === "det-cozy");
    assert.equal(lifted.status, "open");
  });

  it("мост снимает только свою пару", () => {
    // cozy конфликтует с noir (мост psych) и со spy (мост psych/proc).
    const rows = resolveCompatibility(det, ["det-spy", "det-proc"]);
    assert.equal(rows.find((r) => r.id === "det-cozy").status, "open");
    assert.equal(pairBlock(byId("det-cozy"), byId("det-noir"), ["det-proc"]).blocked, true);
  });

  it("выкидывает из выбора то, что потеряло мост", () => {
    assert.deepEqual(pruneSelection(["det-noir", "det-psych", "det-cozy"]), ["det-noir", "det-psych", "det-cozy"]);
    assert.deepEqual(pruneSelection(["det-noir", "det-cozy"]), ["det-noir"]);
    assert.deepEqual(selectionConflicts(["det-noir", "det-cozy"]), [["det-noir", "det-cozy"]]);
  });
});

describe("веса", () => {
  it("равное деление даёт ровно 100", () => {
    assert.deepEqual(equalize(["a", "b", "c"]).map((w) => w.weight), [34, 33, 33]);
  });

  it("ползунок двигает остальных пропорционально и не опускает ниже 5%", () => {
    const start = [
      { id: "a", weight: 50 },
      { id: "b", weight: 30 },
      { id: "c", weight: 20 },
    ];
    const next = setVoiceWeight(start, "a", 95);
    assert.equal(weightSum(next), 100);
    assert.equal(next[0].weight, 90);
    assert.ok(next.every((w) => w.weight >= 5));
    const mid = setVoiceWeight(start, "a", 70);
    assert.equal(weightSum(mid), 100);
    assert.ok(mid[1].weight > mid[2].weight);
  });

  it("лимит голосов и нормализация мусора", () => {
    const three = toggleVoice(toggleVoice(toggleVoice([], "a", 3), "b", 3), "c", 3);
    assert.equal(toggleVoice(three, "d", 3).length, 3);
    assert.deepEqual(normalizeWeights([{ id: "a", weight: -5 }, { id: "b", weight: "x" }]), equalize(["a", "b"]));
    assert.equal(weightSum(normalizeWeights([{ id: "a", weight: 1000 }, { id: "b", weight: 1 }])), 100);
  });
});

describe("оркестратор", () => {
  const weights = [
    { id: "hor-goth", weight: 60 },
    { id: "hor-psych", weight: 25 },
    { id: "hor-folk", weight: 15 },
  ];

  it("раскладывает сцены по весам и не ставит один голос подряд, если можно", () => {
    const seq = apportion(weights, 5);
    assert.equal(seq.length, 5);
    assert.equal(seq.filter((id) => id === "hor-goth").length, 3);
    for (let i = 1; i < seq.length - 1; i += 1) assert.notEqual(seq[i], seq[i - 1]);
  });

  it("смешивает второй голос в дозе веса", () => {
    const secondary = secondaryFor(weights, "hor-goth");
    assert.equal(secondary, "hor-psych");
    const synth = synthesizeWriter({ primaryId: "hor-goth", secondaryId: secondary, weights, words: "100" });
    assert.match(synth.system, /ВТОРОЙ ГОЛОС — «Психологический» \(25%/);
    assert.match(synth.system, /ощутимо/);
    assert.ok(synth.temperature > 0.8 && synth.temperature < 0.85);
    const solo = synthesizeWriter({ primaryId: "hor-goth", secondaryId: null, weights, words: "100" });
    assert.doesNotMatch(solo.system, /ВТОРОЙ ГОЛОС/);
  });
});

describe("проверки и чистка ввода", () => {
  it("мастер не пускает дальше без обязательного", () => {
    const story = { genreId: "det", wizard: blankWizard(), outline: [] };
    assert.ok(stepIssues(story, 2).some((m) => /поджанр/.test(m)));
    story.wizard.subgenres = [{ id: "det-noir", weight: 100 }];
    story.wizard.tone = "мрачный";
    assert.deepEqual(stepIssues(story, 3), []);
    assert.ok(stepIssues(story, 4).length > 0);
  });

  it("сервер чинит мастер и план", () => {
    const w = cleanWizard(
      {
        subgenres: [{ id: "det-noir", weight: 80 }, { id: "sf-hard", weight: 20 }, { id: "det-noir", weight: 1 }],
        tone: "светлый",
        tropes: ["secret", "secret", "nope", "letter", "double"],
        premise: "  много   пробелов \r\n\r\n\r\n строка ",
      },
      "det",
      null,
    );
    assert.deepEqual(w.subgenres, [{ id: "det-noir", weight: 100 }]);
    assert.equal(w.tone, null, "тон не из совместимых");
    assert.deepEqual(w.tropes, ["secret", "letter"]);
    assert.equal(w.premise, "много пробелов \n\n строка");
    const outline = cleanOutline(
      [{ title: "A", summary: "a", writer: "чужой" }, { title: "B", summary: "b" }, {}, {}, {}, {}],
      { ...w, pacing: "fast" },
    );
    assert.equal(outline.length, 3);
    assert.ok(outline.every((card) => card.writer === "det-noir"));
  });

  it("достаёт JSON и прозу из обёрток моделей", () => {
    assert.deepEqual(parseJsonReply('Вот:\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonReply('{"a":{"b":2}} спасибо'), { a: { b: 2 } });
    assert.equal(parseJsonReply("нет json"), null);
    assert.equal(parseJsonReply("[1,2]"), null);
    assert.equal(cleanProse("```\nТекст\n```"), "Текст");
    assert.equal(cleanProse("## Сцена 2. Дом\n\nТекст сцены."), "Текст сцены.");
  });
});

describe("точечные правки редактора", () => {
  it("заменяет первое точное вхождение и считает ненайденные", () => {
    const result = applyEdits("Раз, два. Раз, два.", [
      { find: "два", replace: "три" },
      { find: "нет такого", replace: "x" },
      { find: "Раз", replace: "Раз" },
      { find: "", replace: "x" },
    ]);
    assert.deepEqual(result, { text: "Раз, три. Раз, два.", applied: 1, missed: 1 });
  });

  it("зовёт редактора только когда есть что править", () => {
    const clean = { issues: [] };
    assert.equal(needsEditor(clean, { score: 9, notes: [] }), false);
    assert.equal(needsEditor(clean, { score: 7, notes: [] }), true);
    assert.equal(needsEditor({ issues: [{ problem: "имя" }] }, { score: 10, notes: [] }), true);
    assert.equal(needsEditor(clean, null), true, "бета-ридер выключен — судить не по чему");
    assert.equal(needsEditor(null, { score: 8, notes: [] }), false);
  });
});
