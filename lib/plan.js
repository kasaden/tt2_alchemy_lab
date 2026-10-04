import { applyCraft } from './model.js';
/**
 * Turns "how many times each recipe is used" into an executable, grouped plan.
 *
 * Ordering argument (why grouping is always executable):
 *   - every transform producing ingredient i has inputs of tier < tier(i), and
 *     every transform consuming i produces something of tier > tier(i);
 *   - so running transforms by increasing output tier means all producers of i
 *     run before any transform consumer of i;
 *   - reward crafts only consume, so they go last.
 * If the counts satisfy  initial + produced − consumed ≥ 0  for every ingredient,
 * the stock of i never goes negative in this order. `simulatePlan` re-checks it.
 */
export function buildPlan(model, initial, counts) {
  const used = [...counts.entries()].filter(([, t]) => t > 0);
  const transforms = used
    .filter(([r]) => r.out >= 0)
    .sort(([a], [b]) => model.tier[a.out] - model.tier[b.out] || a.recipe.id - b.recipe.id);
  const rewards = used
    .filter(([r]) => r.out < 0)
    .sort(([a], [b]) => b.recipe.quantity - a.recipe.quantity || a.recipe.id - b.recipe.id);
  const inv = initial.slice();
  const steps = [];
  for (const [r, times] of [...transforms, ...rewards]) {
    for (let t = 0; t < times; t++) {
      if (!applyCraft(inv, r)) {
        throw new Error(`Plan is not executable at recipe ${r.recipe.id} (craft ${t + 1}/${times})`);
      }
    }
    steps.push({
      recipe: r.recipe,
      times,
      phase: r.out >= 0 ? 'transform' : 'reward',
      gained: r.out < 0 ? r.recipe.quantity * times : 0,
      inventoryAfter: inv.slice(),
    });
  }
  return steps;
}
/**
 * Builds the result both engines return. The plan is replayed craft by craft from the initial
 * inventory first: the announced value has to equal the weighted rewards of the replay, otherwise
 * this throws instead of returning something wrong.
 *
 * `counts` is a Map of modelRecipe → times, `weights` the Map from toObjective,
 * `extra` carries what only the engine knows: value, exact, upperBound, stats, notes.
 */
export function describeResult(model, initial, counts, weights, extra) {
  const steps = buildPlan(model, initial, counts);
  const sim = simulatePlan(model, initial, expandPlan(steps));
  if (!sim.ok) throw new Error(`Internal error: plan failed verification — ${sim.error}`);

  let simulated = 0;
  for (const [name, quantity] of Object.entries(sim.rewards)) simulated += (weights.get(name) ?? 0) * quantity;
  if (simulated !== extra.value) throw new Error(`Internal error: plan yields ${simulated}, expected ${extra.value}`);

  const recipeCounts = {};
  for (const [r, times] of counts) if (times > 0) recipeCounts[r.recipe.id] = times;

  return {
    target: weights.size === 1 ? [...weights.keys()][0] : null,
    objective: Object.fromEntries(weights),
    value: extra.value,
    rewards: sim.rewards,
    exact: extra.exact,
    upperBound: extra.exact ? extra.value : extra.upperBound,
    steps,
    recipeCounts,
    totalCrafts: steps.reduce((s, st) => s + st.times, 0),
    initial,
    remaining: sim.final,
    stats: extra.stats,
    notes: extra.notes,
  };
}

/** Expands grouped steps into the individual craft sequence (recipe ids, in order). */
export function expandPlan(steps) {
  const seq = [];
  for (const s of steps)
    for (let t = 0; t < s.times; t++)
      seq.push(s.recipe.id);
  return seq;
}
/**
 * Independently replays a craft sequence from the initial inventory, one craft
 * at a time, checking every craft is possible at that moment.
 */
export function simulatePlan(model, initial, sequence) {
  const byId = new Map(model.recipes.map((r) => [r.recipe.id, r]));
  const inv = initial.slice();
  const rewards = {};
  for (let k = 0; k < sequence.length; k++) {
    const r = byId.get(sequence[k]);
    if (!r)
      return { ok: false, failedAt: k, error: `Unknown recipe ${sequence[k]}`, final: inv, rewards };
    if (!applyCraft(inv, r)) {
      return {
        ok: false,
        failedAt: k,
        error: `Craft #${k + 1} (${r.recipe.ingredient1} + ${r.recipe.ingredient2}) lacks ingredients`,
        final: inv,
        rewards,
      };
    }
    if (r.out < 0)
      rewards[r.recipe.resultName] = (rewards[r.recipe.resultName] ?? 0) + r.recipe.quantity;
  }
  return { ok: true, failedAt: -1, final: inv, rewards };
}
