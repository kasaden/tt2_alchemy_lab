import { relevantRecipes } from './dependencyGraph.js';
import { canCraft, toObjective } from './model.js';
import { describeResult } from './plan.js';
export class StateLimitError extends Error {
  states;
  constructor(states) {
    super(`State search aborted after ${states} states (inventory too large for exhaustive search)`);
    this.states = states;
  }
}
/**
 * Reference engine: exhaustive dynamic programming over inventory states.
 *
 *   best(state) = max over craftable relevant recipes r of  gain(r) + best(state after r)
 *
 * where gain(r) is the weighted reward of r (see toObjective), 0 for a transform.
 *
 * Each craft lowers the total ingredient count (by 1 for a transform, 2 for a
 * reward), so the state graph is a DAG and the recursion always terminates.
 * Results are memoised per state (key = counts of the useful ingredients in
 * fixed order), which deduplicates every permutation of the same crafts.
 *
 * Ties are broken like the main optimizer: keep the most ingredients.
 *
 * The number of states grows roughly like Π (count_i + 1), so this engine is
 * only meant for small inventories. It is used in tests to cross-check the
 * branch & bound optimizer, and throws StateLimitError instead of approximating.
 */
export function stateSearch(model, inventory, objective, options = {}) {
  const t0 = performance.now();
  const maxStates = options.maxStates ?? 2_000_000;
  const initial = inventory.map((v) => Math.max(0, Math.floor(v)));
  const weights = toObjective(objective);
  const { targetRecipes, transforms } = relevantRecipes(model, weights.keys());
  const moves = [...transforms, ...targetRecipes];
  // value * BIG + leftover lets one number encode the lexicographic (value, leftover) order.
  const total0 = initial.reduce((s, v) => s + v, 0);
  if (total0 > (options.maxTotal ?? 2000))
    throw new StateLimitError(0);
  const BIG = total0 + 1;
  const memo = new Map();
  const best = (inv, total) => {
    const key = inv.join(',');
    const hit = memo.get(key);
    if (hit)
      return hit.score;
    if (memo.size >= maxStates)
      throw new StateLimitError(memo.size);
    let bestScore = total; // stop here: value 0, leftover = current total
    let bestMove = -1;
    for (let m = 0; m < moves.length; m++) {
      const r = moves[m];
      if (!canCraft(inv, r))
        continue;
      inv[r.in1]--;
      inv[r.in2]--;
      if (r.out >= 0)
        inv[r.out]++;
      const gain = r.out < 0 ? r.recipe.quantity * weights.get(r.recipe.resultName) : 0;
      const score = gain * BIG + best(inv, total - (r.out >= 0 ? 1 : 2));
      if (r.out >= 0)
        inv[r.out]--;
      inv[r.in1]++;
      inv[r.in2]++;
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }
    memo.set(key, { score: bestScore, move: bestMove });
    return bestScore;
  };
  const inv = initial.slice();
  const score = best(inv, total0);
  const value = Math.floor(score / BIG);
  // Reconstruct the path by following memoised best moves.
  const counts = new Map();
  for (;;) {
    const entry = memo.get(inv.join(','));
    if (!entry || entry.move < 0) break;
    const r = moves[entry.move];
    inv[r.in1]--;
    inv[r.in2]--;
    if (r.out >= 0) inv[r.out]++;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }

  return describeResult(model, initial, counts, weights, {
    value,
    exact: true,
    upperBound: value,
    stats: { engine: 'state-search', nodesExplored: memo.size, lpSolved: 0, timeMs: performance.now() - t0 },
    notes: [],
  });
}
