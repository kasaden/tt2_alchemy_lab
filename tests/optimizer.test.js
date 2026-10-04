// Run with: npm test   (Node's built-in test runner, no dependencies)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAlchemyData, validateAlchemyData } from "../lib/csv.js";
import { buildModel, toVector } from "../lib/model.js";
import { optimize } from "../lib/optimizer.js";
import { expandPlan, simulatePlan } from "../lib/plan.js";
import { stateSearch } from "../lib/stateSearch.js";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const alchemyData = parseAlchemyData(
  read("tt2_alchemy_v8_2_ingredients.csv"),
  read("tt2_alchemy_v8_2_recipes.csv")
);
const dataProblems = validateAlchemyData(alchemyData);
const alchemyModel = buildModel(alchemyData);

/**
 * Builds a synthetic model. Each recipe is [in1, in2, result, quantity?];
 * `result` is an ingredient if it appears in `ingredients`, otherwise a reward.
 */
function makeModel(ingredients, recipes) {
  const list = recipes.map(([a, b, res, qty], k) => {
    const isIngredient = ingredients.includes(res);
    return {
      id: k + 1,
      ingredient1: a,
      ingredient2: b,
      result: isIngredient ? res : `${qty} ${res}`,
      kind: isIngredient ? "ingredient" : "reward",
      quantity: isIngredient ? 1 : qty,
      resultName: res
    };
  });
  return buildModel({ ingredients, recipes: list });
}

const inv = (model, counts) => toVector(model, counts);

/** Replays the plan craft by craft from the initial inventory and checks the totals. */
function expectExecutable(model, res) {
  const sim = simulatePlan(model, res.initial, expandPlan(res.steps));
  assert.ok(sim.ok, sim.error);
  assert.equal(sim.rewards[res.target] ?? 0, res.value);
  assert.deepEqual(sim.final, res.remaining);
  // Every step's inventory snapshot must be non-negative.
  for (const s of res.steps) assert.ok(s.inventoryAfter.every((v) => v >= 0));
}

const describePlan = (res) =>
  res.steps.map((s) => `${s.times}x ${s.recipe.ingredient1}+${s.recipe.ingredient2}->${s.recipe.result}`);

describe("synthetic scenarios", () => {
  it("direct recipe: A + B -> 10 Target", () => {
    const m = makeModel(["A", "B"], [["A", "B", "Target", 10]]);
    const res = optimize(m, inv(m, { A: 1, B: 1 }), "Target");
    assert.equal(res.value, 10);
    assert.equal(res.exact, true);
    assert.deepEqual(describePlan(res), ["1x A+B->10 Target"]);
    assert.deepEqual(res.remaining, [0, 0]);
    expectExecutable(m, res);
  });

  it("intermediate chain: A + B -> C, C + D -> 10 Target", () => {
    const m = makeModel(["A", "B", "C", "D"], [
      ["A", "B", "C"],
      ["C", "D", "Target", 10]
    ]);
    const res = optimize(m, inv(m, { A: 1, B: 1, D: 1 }), "Target");
    assert.equal(res.value, 10);
    assert.deepEqual(describePlan(res), ["1x A+B->C", "1x C+D->10 Target"]);
    expectExecutable(m, res);
  });

  it("longer chain: A + B -> C, C + D -> E, E + F -> Target", () => {
    const m = makeModel(["A", "B", "C", "D", "E", "F"], [
      ["E", "F", "Target", 19],
      ["C", "D", "E"],
      ["A", "B", "C"]
    ]);
    const res = optimize(m, inv(m, { A: 2, B: 2, D: 2, F: 2 }), "Target");
    assert.equal(res.value, 38);
    assert.deepEqual(describePlan(res), ["2x A+B->C", "2x C+D->E", "2x E+F->19 Target"]);
    expectExecutable(m, res);
  });

  it("non-greedy: crafting an intermediate first beats the immediate reward", () => {
    // Greedy would craft A + C -> 10 immediately. Optimal: A + B -> D, then D + C -> 25.
    const m = makeModel(["A", "B", "C", "D"], [
      ["A", "C", "Target", 10],
      ["A", "B", "D"],
      ["D", "C", "Target", 25]
    ]);
    const res = optimize(m, inv(m, { A: 1, B: 1, C: 1 }), "Target");
    assert.equal(res.value, 25);
    assert.deepEqual(describePlan(res), ["1x A+B->D", "1x D+C->25 Target"]);
    expectExecutable(m, res);
  });

  it("non-greedy: best-yield direct recipe is globally worse", () => {
    // A + A -> 6 is the only immediately available reward. Better: 2x (A + B -> C), C + C -> 20.
    const m = makeModel(["A", "B", "C"], [
      ["A", "A", "Target", 6],
      ["A", "B", "C"],
      ["C", "C", "Target", 20]
    ]);
    const res = optimize(m, inv(m, { A: 2, B: 2 }), "Target");
    assert.equal(res.value, 20);
    expectExecutable(m, res);
  });

  it("mixed strategy: splits the inventory between direct and chained recipes", () => {
    const m = makeModel(["A", "B", "C"], [
      ["A", "B", "C"],
      ["C", "B", "Target", 9],
      ["A", "A", "Target", 5]
    ]);
    // A=5, B=4: 2x(A+B->C), 2x(C+B->9) = 18 uses 2 A, then 3 A left -> 1x(A+A->5) = 23.
    const res = optimize(m, inv(m, { A: 5, B: 4 }), "Target");
    assert.equal(res.value, 23);
    expectExecutable(m, res);
    assert.equal(res.value, stateSearch(m, inv(m, { A: 5, B: 4 }), "Target").value);
  });

  it("same ingredient twice: A + A consumes two units", () => {
    const m = makeModel(["A"], [["A", "A", "Target", 7]]);
    assert.equal(optimize(m, [0], "Target").value, 0);
    assert.equal(optimize(m, [1], "Target").value, 0);
    const two = optimize(m, [2], "Target");
    assert.equal(two.value, 7);
    assert.deepEqual(two.remaining, [0]);
    assert.equal(optimize(m, [3], "Target").value, 7);
    assert.equal(optimize(m, [5], "Target").value, 14);
  });

  it("impossible inventory: no recipe can reach the target", () => {
    const m = makeModel(["A", "B", "C"], [
      ["A", "B", "Other", 50],
      ["B", "C", "Target", 10]
    ]);
    const res = optimize(m, inv(m, { A: 3, B: 3 }), "Target");
    assert.equal(res.value, 0);
    assert.equal(res.exact, true);
    assert.deepEqual(res.steps, []);
    assert.deepEqual(res.remaining, [3, 3, 0]);
    // Unknown target: also 0, no crash.
    assert.equal(optimize(m, inv(m, { A: 3, B: 3, C: 3 }), "Nope").value, 0);
  });

  it("never crafts unrelated rewards", () => {
    const m = makeModel(["A", "B"], [
      ["A", "A", "Other", 999],
      ["A", "B", "Target", 1]
    ]);
    const res = optimize(m, inv(m, { A: 4, B: 1 }), "Target");
    assert.equal(res.value, 1);
    assert.deepEqual(res.remaining, [3, 0]);
  });

  it("repeats the same recipe several times", () => {
    const m = makeModel(["A", "B"], [["A", "B", "Target", 5]]);
    const res = optimize(m, inv(m, { A: 4, B: 3 }), "Target");
    assert.equal(res.value, 15);
    assert.equal(res.steps.length, 1);
    assert.equal(res.steps[0].times, 3);
    assert.deepEqual(res.remaining, [1, 0]);
    expectExecutable(m, res);
  });

  it("tie-break keeps the most ingredients among optimal plans", () => {
    // Both reach 10, but the direct route consumes 2 ingredients instead of 3.
    const m = makeModel(["A", "B", "C", "D"], [
      ["A", "B", "C"],
      ["C", "D", "Target", 10],
      ["A", "D", "Target", 10]
    ]);
    const res = optimize(m, inv(m, { A: 1, B: 1, D: 1 }), "Target");
    assert.equal(res.value, 10);
    assert.equal(res.totalCrafts, 1);
    assert.deepEqual(res.remaining, [0, 1, 0, 0]);
  });

  it("respects safety limits and never claims optimality when stopped early", () => {
    const res = optimize(alchemyModel, alchemyModel.ingredients.map((_, i) => 37 + 13 * i), "Currency", {
      maxNodes: 1
    });
    if (!res.exact) {
      assert.ok(res.upperBound >= res.value);
      assert.match(res.notes.join(" "), /at most/);
    }
    expectExecutable(alchemyModel, res);
  });
});

describe("CSV data", () => {
  it("parses 16 ingredients and 136 consistent recipes", () => {
    assert.equal(alchemyData.ingredients.length, 16);
    assert.equal(alchemyData.ingredients[0], "Pepper");
    assert.equal(alchemyData.ingredients[15], "Scale");
    assert.equal(alchemyData.recipes.length, 136);
    assert.deepEqual(dataProblems, []);
  });

  it("derives reward names from the CSV", () => {
    assert.ok(alchemyModel.rewardNames.includes("Crafting Shards"));
    assert.ok(alchemyModel.rewardNames.includes("Eggs"));
    assert.ok(alchemyModel.rewardNames.includes("Fortune Scroll"));
    assert.ok(!alchemyModel.rewardNames.includes("Sand"));
  });

  it("base ingredients have tier 0 and crafted ones a positive tier", () => {
    const t = (n) => alchemyModel.tier[alchemyModel.index.get(n)];
    assert.equal(t("Pepper"), 0);
    assert.equal(t("Berries"), 0);
    assert.equal(t("Mushroom"), 0);
    assert.equal(t("Sand"), 1);
    assert.ok(t("Scale") > t("Flame"));
  });
});

describe("real recipes", () => {
  const m = alchemyModel;

  it("finds the chain Pepper + Berries -> Sand, Sand + Petal -> Spirit, Spirit + Tooth -> 19 Crafting Shards", () => {
    const res = optimize(m, toVector(m, { Pepper: 1, Berries: 1, Petal: 1, Tooth: 1 }), "Crafting Shards");
    assert.equal(res.value, 19);
    assert.deepEqual(describePlan(res), [
      "1x Pepper+Berries->Sand",
      "1x Sand+Petal->Spirit",
      "1x Spirit+Tooth->19 Crafting Shards"
    ]);
    expectExecutable(m, res);
  });

  it("produces executable, verified plans for every reward on a mid-size inventory", () => {
    const inventory = toVector(m, {
      Pepper: 40, Berries: 35, Mushroom: 30, Sand: 6, Petal: 5, Acorn: 4, Feather: 3, Shadow: 3,
      Spirit: 2, Essence: 2, Power: 1, Beetle: 1, Tooth: 1, Flame: 1, Steel: 1, Scale: 0
    });
    for (const target of m.rewardNames) {
      const res = optimize(m, inventory, target);
      assert.equal(res.exact, true, target);
      expectExecutable(m, res);
    }
  });

  it("agrees with the exhaustive state search on random small inventories", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let compared = 0;
    for (let trial = 0; trial < 60; trial++) {
      const vec = new Array(m.ingredients.length).fill(0);
      const picks = 3 + Math.floor(rand() * 4);
      for (let k = 0; k < picks; k++) vec[Math.floor(rand() * vec.length)] += 1 + Math.floor(rand() * 3);
      const target = m.rewardNames[Math.floor(rand() * m.rewardNames.length)];
      const fast = optimize(m, vec, target);
      const ref = stateSearch(m, vec, target, { maxStates: 400_000 });
      assert.equal(fast.value, ref.value, `${target} ${vec.join(",")}`);
      // Same tie-break (most ingredients kept).
      assert.equal(
        fast.remaining.reduce((a, b) => a + b, 0),
        ref.remaining.reduce((a, b) => a + b, 0)
      );
      expectExecutable(m, ref);
      compared++;
    }
    assert.equal(compared, 60);
  });

  it("solves large inventories exactly and quickly", () => {
    const big = m.ingredients.map((_, i) => 150 + ((i * 37) % 90));
    for (const target of m.rewardNames) {
      const res = optimize(m, big, target);
      assert.equal(res.exact, true, target);
      assert.ok(res.stats.timeMs < 5000, target);
      expectExecutable(m, res);
    }
  });
});
