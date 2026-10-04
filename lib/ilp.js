import { solveLp } from './simplex.js';
const INT_TOL = 1e-6;
const BOUND_TOL = 1e-6;
const MAX_CUT_ROWS = 17;
const CUTS_PER_ROUND = 16;
const MAX_GLOBAL_CUTS = 120;
const MAX_LOCAL_CUTS = 48;
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++)
    s += a[i] * b[i];
  return s;
}
/** Exact integer feasibility check (no floating point involved for integer inputs). */
export function isFeasible(p, x) {
  if (x.some((v) => v < 0 || !Number.isInteger(v)))
    return false;
  return p.A.every((row, i) => dot(row, x) <= p.b[i]);
}
/**
 * {0,½}-Chvátal–Gomory separation with bound substitution.
 *
 * For a subset S of rows, summing them gives  Σ_j a_j x_j ≤ β  with integer a, β.
 * Each variable with an odd a_j is rewritten with a non-negative integer
 * substitute — x = l + x' (shift by its lower bound) or x = u − x'' (complement
 * against its upper bound), whichever the LP point is closer to. Halving and
 * rounding down then gives a valid inequality (the left side is an integer
 * combination of non-negative integers), which translates back to:
 *
 *     Σ_even (a_j/2) x_j + Σ_L ⌊a_j/2⌋ x_j + Σ_U ⌈a_j/2⌉ x_j
 *         ≤ ⌊β'/2⌋ + Σ_L ⌊a_j/2⌋ l_j + Σ_U ⌈a_j/2⌉ u_j,
 *     β' = β − Σ_L a_j l_j − Σ_U a_j u_j.
 *
 * With trivial bounds (l = 0, u = ∞) the cut is globally valid; otherwise it
 * is valid in the subtree where those bounds hold. All 2^m subsets are
 * enumerated in Gray-code order (m ≤ MAX_CUT_ROWS).
 */
function separateHalfCuts(rows, rhs, x, lower, upper) {
  const m = rows.length;
  const n = x.length;
  const sum = new Array(n).fill(0);
  const useUpper = new Array(n);
  for (let j = 0; j < n; j++)
    useUpper[j] = upper[j] !== Infinity && upper[j] - x[j] < x[j] - lower[j];
  let bsum = 0;
  let gray = 0;
  const found = [];
  for (let k = 1; k < 1 << m; k++) {
    const next = k ^ (k >> 1);
    const bit = 31 - Math.clz32(next ^ gray);
    const sign = next & (1 << bit) ? 1 : -1;
    gray = next;
    const row = rows[bit];
    for (let j = 0; j < n; j++)
      sum[j] += sign * row[j];
    bsum += sign * rhs[bit];
    let lhs = 0;
    let beta = bsum;
    let adjust = 0;
    let odd = false;
    for (let j = 0; j < n; j++) {
      const a = sum[j];
      if (a === 0)
        continue;
      if (a % 2 === 0) {
        lhs += (a / 2) * x[j];
      } else if (useUpper[j]) {
        odd = true;
        const co = Math.ceil(a / 2);
        lhs += co * x[j];
        beta -= a * upper[j];
        adjust += co * upper[j];
      } else {
        odd = true;
        const co = Math.floor(a / 2);
        lhs += co * x[j];
        beta -= a * lower[j];
        adjust += co * lower[j];
      }
    }
    if (!odd && beta % 2 === 0)
      continue; // just half of a valid inequality
    const cutRhs = Math.floor(beta / 2) + adjust;
    const viol = lhs - cutRhs;
    if (viol > 1e-6) {
      const cutRow = sum.map((a, j) => a % 2 === 0 ? a / 2 : useUpper[j] ? Math.ceil(a / 2) : Math.floor(a / 2));
      found.push({ cut: { row: cutRow, rhs: cutRhs }, viol });
    }
  }
  found.sort((p, q) => q.viol - p.viol);
  return found.slice(0, CUTS_PER_ROUND).map((f) => f.cut);
}
/** LP relaxation at a node: pool rows, local cuts, and branching bounds. */
function solveNodeLp(p, node) {
  const n = p.c.length;
  const A = p.A.slice();
  const b = p.b.slice();
  for (const cut of node.cuts) {
    A.push(cut.row);
    b.push(cut.rhs);
  }
  for (let j = 0; j < n; j++) {
    if (node.upper[j] !== Infinity) {
      const row = new Array(n).fill(0);
      row[j] = 1;
      A.push(row);
      b.push(node.upper[j]);
    }
    if (node.lower[j] > 0) {
      const row = new Array(n).fill(0);
      row[j] = -1;
      A.push(row);
      b.push(-node.lower[j]);
    }
  }
  return solveLp(p.c, A, b);
}
function isIntegral(x) {
  return x.every((v) => Math.abs(v - Math.round(v)) <= INT_TOL);
}
export function solveIlp(original, options = {}) {
  const n = original.c.length;
  const c = original.c;
  /** Working problem: original rows + global cut pool. */
  const p = { c, A: original.A.slice(), b: original.b.slice() };
  const maxNodes = options.maxNodes ?? 250_000;
  const deadline = performance.now() + (options.timeLimitMs ?? 15_000);
  let bestX = null;
  let bestValue = -Infinity;
  const offer = (x) => {
    if (x && isFeasible(original, x)) {
      const v = dot(c, x);
      if (v > bestValue) {
        bestValue = v;
        bestX = x.slice();
      }
    }
  };
  offer(options.incumbent);
  /**
   * Rows used for separation: the original constraints plus, once an incumbent
   * exists, the objective cut-off  c·x ≥ incumbent + 1  (as −c·x ≤ −incumbent − 1).
   * Cuts derived from it hold for every solution strictly better than the
   * incumbent — the only solutions the search still needs — and let it see
   * parity arguments (e.g. a single odd-quantity recipe fixes the parity of the total).
   */
  const separationRows = () => bestValue === -Infinity
    ? { rows: original.A, rhs: original.b }
    : { rows: [...original.A, c.map((v) => -v)], rhs: [...original.b, -(bestValue + 1)] };
  const cutRounds = options.cutRounds ?? 8;
  const canCut = cutRounds > 0 && original.A.length + 1 <= MAX_CUT_ROWS;
  const localCuts = canCut && (options.localCuts ?? true);
  const zeros = new Array(n).fill(0);
  const infs = new Array(n).fill(Infinity);
  let nodes = 0;
  let lpSolved = 0;
  // Root: heuristic incumbent, then rounds of global cutting planes.
  let rootBound = Infinity;
  for (let round = 0; round <= (canCut ? cutRounds : 0); round++) {
    const lp = solveLp(c, p.A, p.b);
    lpSolved++;
    if (lp.status === 'unbounded')
      throw new Error('Unbounded relaxation: the model is not well-formed');
    if (lp.status === 'infeasible') {
      rootBound = bestValue; // nothing can beat the incumbent
      break;
    }
    rootBound = Math.floor(lp.value + BOUND_TOL);
    if (round === 0 && options.heuristic && !isIntegral(lp.x))
      offer(options.heuristic(lp.x));
    if (isIntegral(lp.x) || rootBound <= bestValue || round === cutRounds)
      break;
    if (p.A.length >= original.A.length + MAX_GLOBAL_CUTS)
      break;
    const sr = separationRows();
    const cuts = separateHalfCuts(sr.rows, sr.rhs, lp.x, zeros, infs);
    if (cuts.length === 0)
      break;
    for (const cut of cuts) {
      p.A.push(cut.row);
      p.b.push(cut.rhs);
    }
  }
  const stack = [{ lower: zeros.slice(), upper: infs.slice(), cuts: [], parentBound: rootBound }];
  while (stack.length > 0) {
    if (nodes >= maxNodes || performance.now() > deadline) {
      // Every unexplored node is bounded by its parent's LP bound.
      const openBound = stack.reduce((mx, nd) => Math.max(mx, nd.parentBound), -Infinity);
      return { status: 'limit', x: bestX, value: bestValue, bound: Math.max(bestValue, openBound), nodes, lpSolved };
    }
    const node = stack.pop();
    if (node.parentBound <= bestValue)
      continue; // incumbent improved since it was pushed
    nodes++;
    let lp = solveNodeLp(p, node);
    lpSolved++;
    if (lp.status === 'infeasible')
      continue;
    if (lp.status === 'unbounded')
      throw new Error('Unbounded relaxation: the model is not well-formed');
    let bound = Math.floor(lp.value + BOUND_TOL);
    if (bound > bestValue && !isIntegral(lp.x)) {
      if (options.heuristic && (nodes - 1) % (options.heuristicEvery ?? 1) === 0) {
        offer(options.heuristic(lp.x));
        if (bound <= bestValue)
          continue;
      }
      // Node-local cuts (depend on this node's bounds), inherited by its children.
      if (localCuts && node.cuts.length < MAX_LOCAL_CUTS) {
        const sr = separationRows();
        const cuts = separateHalfCuts(sr.rows, sr.rhs, lp.x, node.lower, node.upper);
        if (cuts.length > 0) {
          node.cuts = [...node.cuts, ...cuts];
          lp = solveNodeLp(p, node);
          lpSolved++;
          if (lp.status !== 'optimal')
            continue;
          bound = Math.floor(lp.value + BOUND_TOL);
          if (bound <= bestValue)
            continue;
        }
      }
    }
    if (bound <= bestValue)
      continue;
    // Most fractional variable.
    let branch = -1;
    let bestFrac = INT_TOL;
    for (let j = 0; j < n; j++) {
      const f = Math.abs(lp.x[j] - Math.round(lp.x[j]));
      if (f > bestFrac) {
        bestFrac = f;
        branch = j;
      }
    }
    if (branch < 0) {
      const x = lp.x.map((v) => Math.max(0, Math.round(v)));
      if (!isFeasible(original, x)) {
        // Should be impossible with small integer data; fail loudly rather than return something unproven.
        throw new Error('Numerical issue: integral LP solution is not feasible');
      }
      offer(x);
      continue;
    }
    const v = lp.x[branch];
    const down = { lower: node.lower, upper: node.upper.slice(), cuts: node.cuts, parentBound: bound };
    down.upper[branch] = Math.floor(v);
    const up = { lower: node.lower.slice(), upper: node.upper, cuts: node.cuts, parentBound: bound };
    up.lower[branch] = Math.ceil(v);
    // Explore the "craft more" branch first: it tends to find good incumbents quickly.
    stack.push(down, up);
  }
  if (bestX === null)
    return { status: 'infeasible', x: null, value: -Infinity, bound: -Infinity, nodes, lpSolved };
  return { status: 'optimal', x: bestX, value: bestValue, bound: bestValue, nodes, lpSolved };
}
