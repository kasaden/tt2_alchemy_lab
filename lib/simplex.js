/**
 * Dense two-phase primal simplex for small linear programs:
 *
 *     maximize   c · x
 *     subject to A x ≤ b,  x ≥ 0
 *
 * `b` may contain negative entries (used for branching lower bounds), which is
 * why phase 1 (artificial variables) is needed. Problem sizes here are tiny
 * (≤ ~60 variables, ≤ ~100 rows) so a dense tableau is the simplest robust choice.
 * Dantzig's rule is used first, then Bland's rule to guarantee termination.
 */
const EPS = 1e-9;
const BLAND_AFTER = 200;
const MAX_ITERATIONS = 50_000;
class Tableau {
  /** rows[i][j]: constraint rows; last column is the right-hand side. */
  rows;
  basis;
  obj;
  width;
  constructor(rows, basis, width) {
    this.rows = rows;
    this.basis = basis;
    this.width = width;
    this.obj = new Array(width + 1).fill(0);
  }
  pivot(r, col) {
    const W = this.width;
    const prow = this.rows[r];
    const p = prow[col];
    for (let j = 0; j <= W; j++)
      prow[j] /= p;
    prow[col] = 1;
    const eliminate = (row) => {
      const f = row[col];
      if (f === 0)
        return;
      for (let j = 0; j <= W; j++)
        row[j] -= f * prow[j];
      row[col] = 0;
    };
    for (let i = 0; i < this.rows.length; i++)
      if (i !== r)
        eliminate(this.rows[i]);
    eliminate(this.obj);
    this.basis[r] = col;
  }
  /** Runs simplex iterations on the current objective row. `allowed(j)` restricts entering columns. */
  run(allowed) {
    const W = this.width;
    for (let it = 0; it < MAX_ITERATIONS; it++) {
      const bland = it >= BLAND_AFTER;
      let enter = -1;
      let best = -EPS;
      for (let j = 0; j < W; j++) {
        if (!allowed(j))
          continue;
        const d = this.obj[j];
        if (d < -EPS && (bland ? enter < 0 : d < best)) {
          enter = j;
          best = d;
          if (bland)
            break;
        }
      }
      if (enter < 0)
        return 'optimal';
      let leave = -1;
      let ratio = Infinity;
      for (let i = 0; i < this.rows.length; i++) {
        const a = this.rows[i][enter];
        if (a > EPS) {
          const t = this.rows[i][W] / a;
          if (t < ratio - EPS || (Math.abs(t - ratio) <= EPS && leave >= 0 && this.basis[i] < this.basis[leave])) {
            ratio = t;
            leave = i;
          }
        }
      }
      if (leave < 0)
        return 'unbounded';
      this.pivot(leave, enter);
    }
    throw new Error('Simplex iteration limit exceeded');
  }
}
export function solveLp(c, A, b) {
  const m = A.length;
  const n = c.length;
  const artRows = [];
  for (let i = 0; i < m; i++)
    if (b[i] < 0)
      artRows.push(i);
  const nArt = artRows.length;
  const W = n + m + nArt; // originals, slacks, artificials
  const rows = [];
  const basis = [];
  let k = 0;
  for (let i = 0; i < m; i++) {
    const row = new Array(W + 1).fill(0);
    const sign = b[i] < 0 ? -1 : 1;
    for (let j = 0; j < n; j++)
      row[j] = sign * A[i][j];
    row[n + i] = sign; // slack
    row[W] = sign * b[i];
    if (sign < 0) {
      row[n + m + k] = 1;
      basis.push(n + m + k);
      k++;
    } else {
      basis.push(n + i);
    }
    rows.push(row);
  }
  const T = new Tableau(rows, basis, W);
  const isArt = (j) => j >= n + m;
  if (nArt > 0) {
    // Phase 1: maximise −Σ artificials.
    for (let j = n + m; j < W; j++)
      T.obj[j] = 1;
    for (let i = 0; i < m; i++) {
      if (isArt(T.basis[i]))
        for (let j = 0; j <= W; j++)
          T.obj[j] -= T.rows[i][j];
    }
    T.run(() => true);
    if (T.obj[W] < -1e-7)
      return { status: 'infeasible', x: [], value: -Infinity };
    // Drive remaining (zero-valued) artificials out of the basis when possible.
    for (let i = 0; i < m; i++) {
      if (!isArt(T.basis[i]))
        continue;
      for (let j = 0; j < n + m; j++) {
        if (Math.abs(T.rows[i][j]) > EPS) {
          T.pivot(i, j);
          break;
        }
      }
    }
  }
  // Phase 2: objective row = −c, then price out basic columns.
  T.obj = new Array(W + 1).fill(0);
  for (let j = 0; j < n; j++)
    T.obj[j] = -c[j];
  for (let i = 0; i < m; i++) {
    const bj = T.basis[i];
    const cb = bj < n ? c[bj] : 0;
    if (cb !== 0)
      for (let j = 0; j <= W; j++)
        T.obj[j] += cb * T.rows[i][j];
  }
  const status = T.run((j) => !isArt(j));
  if (status === 'unbounded')
    return { status, x: [], value: Infinity };
  const x = new Array(n).fill(0);
  for (let i = 0; i < m; i++)
    if (T.basis[i] < n)
      x[T.basis[i]] = T.rows[i][W];
  return { status: 'optimal', x, value: T.obj[W] };
}
