/*
 * Data shapes used across lib/ (plain objects, no classes):
 *
 *   recipe       { id, ingredient1, ingredient2, result, kind, quantity, resultName }
 *                kind is "ingredient" (makes 1 resultName) or "reward" (makes quantity x resultName);
 *                result is the raw CSV column, e.g. "19 Crafting Shards" or "Sand".
 *   data         { ingredients: string[] in CSV order, recipes: recipe[] }
 *   model        { ingredients, index: Map(name -> position), recipes: modelRecipe[],
 *                  tier: number[] (production depth, 0 = cannot be crafted), rewardNames: string[] }
 *   modelRecipe  { recipe, in1, in2, out }   in1/in2/out are ingredient positions, out = -1 for a reward
 *   inventory    number[] indexed like model.ingredients
 *   plan step    { recipe, times, phase: "transform" | "reward", gained, inventoryAfter }
 *   result       { target, value, exact, upperBound, steps, recipeCounts, totalCrafts,
 *                  initial, remaining, stats: { engine, nodesExplored, lpSolved, timeMs }, notes }
 */

/**
 * Builds the indexed model used by the optimizer and computes the production
 * tier of every ingredient:
 *
 *   tier(i) = 0                                   if no recipe produces i
 *   tier(i) = 1 + max(tier(inputs of producer))   otherwise
 *
 * Tiers only exist if the "ingredient production" graph is acyclic; a cycle
 * would make the problem fundamentally different, so it is rejected loudly.
 * The tiers give a topological order that the plan builder relies on.
 */
export function buildModel(data) {
  const index = new Map();
  data.ingredients.forEach((name, i) => index.set(name, i));
  const lookup = (name, recipeId) => {
    const i = index.get(name);
    if (i === undefined)
      throw new Error(`Recipe ${recipeId}: unknown ingredient "${name}"`);
    return i;
  };
  const recipes = data.recipes.map((recipe) => ({
    recipe,
    in1: lookup(recipe.ingredient1, recipe.id),
    in2: lookup(recipe.ingredient2, recipe.id),
    out: recipe.kind === 'ingredient' ? lookup(recipe.resultName, recipe.id) : -1,
  }));
  const producers = data.ingredients.map(() => []);
  for (const r of recipes)
    if (r.out >= 0)
      producers[r.out].push(r);
  const tier = new Array(data.ingredients.length).fill(-1);
  const visiting = new Set();
  const computeTier = (i) => {
    if (tier[i] >= 0)
      return tier[i];
    if (visiting.has(i)) {
      throw new Error(`Cyclic ingredient production involving "${data.ingredients[i]}"`);
    }
    visiting.add(i);
    let t = 0;
    for (const p of producers[i])
      t = Math.max(t, 1 + Math.max(computeTier(p.in1), computeTier(p.in2)));
    visiting.delete(i);
    tier[i] = t;
    return t;
  };
  data.ingredients.forEach((_, i) => computeTier(i));
  const rewardNames = [];
  for (const r of data.recipes) {
    if (r.kind === 'reward' && !rewardNames.includes(r.resultName))
      rewardNames.push(r.resultName);
  }
  return { ingredients: data.ingredients, index, recipes, tier, rewardNames };
}
/** Converts a name → count record into a vector in model order (missing = 0). */
export function toVector(model, inventory) {
  return model.ingredients.map((name) => {
    const v = Math.floor(Number(inventory[name] ?? 0));
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
}
export function toRecord(model, vector) {
  const out = {};
  model.ingredients.forEach((name, i) => (out[name] = vector[i] ?? 0));
  return out;
}
/** A + A recipes consume two units of A. */
export function canCraft(inv, r) {
  return r.in1 === r.in2 ? inv[r.in1] >= 2 : inv[r.in1] >= 1 && inv[r.in2] >= 1;
}
/** Applies one craft of `r` to `inv` in place. Returns false (and leaves `inv` untouched) if not craftable. */
export function applyCraft(inv, r) {
  if (!canCraft(inv, r))
    return false;
  inv[r.in1] -= 1;
  inv[r.in2] -= 1;
  if (r.out >= 0)
    inv[r.out] += 1;
  return true;
}
/** Best quantity of each reward obtainable from a single direct recipe (informational only). */
export function bestDirectQuantity(model) {
  const best = {};
  for (const { recipe } of model.recipes) {
    if (recipe.kind === 'reward')
      best[recipe.resultName] = Math.max(best[recipe.resultName] ?? 0, recipe.quantity);
  }
  return best;
}
