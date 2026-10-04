import { relevantRecipes } from './dependencyGraph.js';
import { solveIlp } from './ilp.js';
import { buildPlan, expandPlan, simulatePlan } from './plan.js';
import { StateLimitError, stateSearch } from './stateSearch.js';
const COMPLETION_LIMITS = { maxStates: 1500, maxTotal: 120 };
const HEURISTIC_EVERY = 16;
/**
 * Primal heuristic used inside branch & bound (it only supplies incumbents,
 * never bounds, so it cannot affect exactness):
 *
 * 1. Round the LP point down. Each ingredient here has a single producer with
 *    coefficient 1, so flooring keeps every constraint satisfied (the LHS grows
 *    by < 1 and is an integer). Feasibility is re-checked by the solver anyway.
 * 2. Execute it and complete the small leftover inventory: greedily with the
 *    best target recipes when it is large, then exactly with the state search.
 */
function roundAndComplete(model, initial, target, vars, lpX) {
  const x = lpX.map((v) => Math.max(0, Math.floor(v + 1e-9)));
  const inv = initial.slice();
  vars.forEach((r, j) => {
    inv[r.in1] -= x[j];
    inv[r.in2] -= x[j];
    if (r.out >= 0)
      inv[r.out] += x[j];
  });
  if (inv.some((v) => v < 0))
    return null;
  const varIndex = new Map(vars.map((r, j) => [r.recipe.id, j]));
  const addCounts = (counts) => {
    for (const [id, t] of Object.entries(counts)) {
      const j = varIndex.get(Number(id));
      if (j !== undefined)
        x[j] += t;
    }
  };
  const complete = () => {
    try {
      addCounts(stateSearch(model, inv, target, COMPLETION_LIMITS).recipeCounts);
      return true;
    } catch (e) {
      if (!(e instanceof StateLimitError))
        throw e;
      return false;
    }
  };
  if (complete())
    return x;
  // Leftover too large for exhaustive completion: greedy on direct target recipes, then retry.
  const direct = vars.filter((r) => r.out < 0).sort((p, q) => q.recipe.quantity - p.recipe.quantity);
  for (const r of direct) {
    const t = r.in1 === r.in2 ? Math.floor(inv[r.in1] / 2) : Math.min(inv[r.in1], inv[r.in2]);
    if (t <= 0)
      continue;
    inv[r.in1] -= t;
    inv[r.in2] -= t;
    x[varIndex.get(r.recipe.id)] += t;
  }
  complete();
  return x;
}
/**
 * Exact optimizer.
 *
 * Model: let x_r ≥ 0 be the number of times recipe r is crafted. For every
 * ingredient i:
 *
 *     inventory_i + Σ_{r produces i} x_r − Σ_r uses(r, i) · x_r ≥ 0
 *
 * (uses(r, i) = 2 for an i + i recipe). Objective: maximise Σ quantity_r · x_r
 * over recipes producing the target reward.
 *
 * Because ingredient production is acyclic (see buildModel / buildPlan), ANY
 * integer vector x satisfying these inequalities can be executed in tier order,
 * and conversely every craft sequence yields such an x. So maximising over x is
 * exactly maximising over all craft sequences — but on ≤ ~60 integer variables
 * instead of an exponential number of inventory states.
 *
 * Phase 1 finds the maximum V (exact branch & bound).
 * Phase 2 (tie-break) keeps the target ≥ V and minimises ingredients consumed.
 */
export function optimize(model, inventory, target, options = {}) {
  const t0 = performance.now();
  const initial = inventory.map((v) => Math.max(0, Math.floor(v)));
  const { targetRecipes, transforms, usefulIngredients } = relevantRecipes(model, target);
  const vars = [...transforms, ...targetRecipes];
  const ingredientRows = [...usefulIngredients].sort((a, b) => a - b);
  const notes = [];
  // A x ≤ b with one row per useful ingredient: consumption − production ≤ inventory.
  const A = ingredientRows.map((i) => vars.map((r) => (r.in1 === i ? 1 : 0) + (r.in2 === i ? 1 : 0) - (r.out === i ? 1 : 0)));
  const b = ingredientRows.map((i) => initial[i]);
  const gain = vars.map((r) => (r.out < 0 ? r.recipe.quantity : 0));
  let nodes = 0;
  let lpSolved = 0;
  let x = new Array(vars.length).fill(0);
  let value = 0;
  let exact = true;
  let upperBound = 0;
  if (vars.length > 0 && targetRecipes.length > 0) {
    const phase1 = { c: gain, A, b };
    const r1 = solveIlp(phase1, {
      incumbent: x,
      maxNodes: options.maxNodes,
      timeLimitMs: options.timeLimitMs,
      heuristic: (lpX) => roundAndComplete(model, initial, target, vars, lpX),
      heuristicEvery: HEURISTIC_EVERY,
    });
    nodes += r1.nodes;
    lpSolved += r1.lpSolved;
    x = r1.x ?? x;
    value = r1.value;
    upperBound = r1.bound;
    if (r1.status === 'limit') {
      exact = false;
      notes.push(`Search stopped by the safety limit after ${r1.nodes.toLocaleString('en-US')} nodes. ` +
        `Best plan found: ${value}; the true maximum is at most ${upperBound}.`);
    }
    if ((options.preferLeftovers ?? true) && value > 0) {
      // Minimise net ingredients consumed (transform: −1, reward craft: −2) with target ≥ value.
      const phase2 = {
        c: vars.map((r) => (r.out >= 0 ? -1 : -2)),
        A: [...A, gain.map((g) => -g)],
        b: [...b, -value],
      };
      const r2 = solveIlp(phase2, { incumbent: x, maxNodes: options.maxNodes, timeLimitMs: options.timeLimitMs });
      nodes += r2.nodes;
      lpSolved += r2.lpSolved;
      if (r2.x)
        x = r2.x;
      if (r2.status === 'limit')
        notes.push('Tie-break (keep most ingredients) stopped early; the target total is unaffected.');
    }
  }
  const counts = new Map();
  const recipeCounts = {};
  vars.forEach((r, j) => {
    if (x[j] > 0) {
      counts.set(r, x[j]);
      recipeCounts[r.recipe.id] = x[j];
    }
  });
  const steps = buildPlan(model, initial, counts, target);
  // Independent verification: replay every single craft from the initial inventory.
  const sim = simulatePlan(model, initial, expandPlan(steps));
  if (!sim.ok)
    throw new Error(`Internal error: optimal plan failed verification — ${sim.error}`);
  const simulated = sim.rewards[target] ?? 0;
  if (simulated !== value)
    throw new Error(`Internal error: plan yields ${simulated}, expected ${value}`);
  return {
    target,
    value,
    exact,
    upperBound: exact ? value : upperBound,
    steps,
    recipeCounts,
    totalCrafts: steps.reduce((s, st) => s + st.times, 0),
    initial,
    remaining: sim.final,
    stats: { engine: 'branch-and-bound', nodesExplored: nodes, lpSolved, timeMs: performance.now() - t0 },
    notes,
  };
}
