# TT2 Alchemy Optimizer

A visual planner and **exact optimizer** for the Alchemy Lab event in Tap Titans 2.

Enter how many of each of the 16 ingredients you own, pick the reward you want (Crafting Shards, Pets / Eggs, Wildcards, Skill Points, Raid Cards, Currency…), and the app computes the sequence of crafts that **maximises** that reward. That includes chains through intermediate ingredients (`A + B → C`, `C + D → E`, `E + F → reward`), not only direct recipes.

100 % client-side, plain HTML, CSS and JavaScript: no framework, no build step. No backend, and your inventory stays in your browser (`localStorage`).

## Features

- **Inventory**: the 16 ingredients in CSV order, with −/+ steppers, typed input, arrow keys (Shift for ±10), *Load example*, *+1 to all*, *Clear inventory* and *Reset all*. Saved automatically.
- **Target reward**: generated from the reward recipes in the CSV (`Eggs` is shown as *Pets / Eggs*). Each chip shows the best quantity from a single recipe, for information only.
- **Optimize**: runs in a Web Worker, so the page stays responsive. You get:
  - **Maximum achievable** and whether it is *proven optimal*;
  - **Optimal plan**: grouped steps (`19× Pepper + Berries → Sand`), intermediates first, then the reward crafts, with an optional inventory snapshot after each step and *Copy plan*;
  - **Total rewards**, **Inventory remaining**;
  - a discreet stats line (search nodes, time, exact yes/no).
- **Recipe Book**: all 136 recipes, with full-text search and filters by ingredient, result and kind (ingredient / reward).

## Data: the CSV files are the source of truth

The game data is read from the two CSV files at the repository root. Nothing is copied into the code.

| File | Columns |
| --- | --- |
| `tt2_alchemy_v8_2_ingredients.csv` | `ingredient_id, ingredient` (16 rows, the order is used everywhere) |
| `tt2_alchemy_v8_2_recipes.csv` | `recipe_id, ingredient_1, ingredient_2, result, result_kind, result_quantity, result_name` (136 rows) |

`result_kind` is `ingredient` (the craft produces 1 unit of `result_name`) or `reward` (the craft produces `result_quantity` × `result_name`).

The page fetches the two files at startup and parses them in the browser. To update the recipes, replace the CSVs and reload. `validateAlchemyData` checks the data objectively: unknown ingredients, duplicate pairs, `result` ≠ `quantity + name`, the expected 136 = 16·17/2 unique pairs. Any problem is shown in a banner. **The current CSVs pass every check.** A cycle in ingredient production would be rejected with an explicit error.

## How the optimizer works

Code: `lib/`. It does not touch the DOM, so it runs the same in the page, in the worker and in Node (the tests).

### 1. Reverse-dependency filter (`dependencyGraph.js`)
Starting from the recipes that produce the target, the filter walks the producers backwards to find every ingredient that can contribute to it. Only those transforms and the target recipes are kept. Crafting anything else (another reward, or an ingredient that can never lead to the target) only destroys ingredients, so dropping it never removes an optimal solution.

### 2. Exact formulation as an integer program (`optimizer.js`)
Let `x_r ≥ 0` be the number of times recipe `r` is crafted. For each ingredient `i`:

```
inventory_i + Σ(recipes producing i) x_r − Σ_r uses(r, i)·x_r ≥ 0      (uses = 2 for i + i)
maximise  Σ(target recipes) quantity_r · x_r
```

**Why this is exact and not a relaxation of the real problem:** every craft sequence gives such a vector `x`. Conversely, ingredient production is acyclic: each ingredient gets a *tier*, and a recipe's inputs always have a lower tier than its output. So any integer `x` satisfying these inequalities can be executed by crafting the intermediates in increasing tier order and the rewards last (`plan.js`). Maximising over `x` is therefore exactly maximising over all craft sequences. The search runs over ≤ 62 integer variables instead of an exponential number of inventory states.

### 3. Exact solver: branch & cut (`ilp.js`, `simplex.js`)
- LP relaxations are solved by a small dense two-phase simplex (Bland's rule fallback against cycling).
- Depth-first branch & bound. Rewards are integers, so a node is pruned as soon as `⌊LP bound⌋ ≤ best found`.
- **{0,½}-Chvátal–Gomory cuts**: add a subset of ingredient constraints, halve, round down. Every subset is enumerated (≤ 2¹⁷), at the root (global cuts) and at each node, using the node's branching bounds (local cuts). The objective cut-off `value ≥ best + 1` is included, which captures parity arguments: for example, among the 49 Currency recipes only `Acorn + Acorn → 25` has an odd quantity. Cuts are computed in **exact integer arithmetic** and only remove points that cannot beat the incumbent.
- Primal heuristic: round the LP point down (always feasible here, since each ingredient has a single producer), then complete the small leftover exactly with the state search below. It only supplies good solutions early; it never affects the bound.
- **Tie-break**: a second exact pass keeps the target ≥ the maximum and maximises the ingredients left over, so you keep as much as possible for your next target.

### 4. Verification
Every plan is **replayed craft by craft** from the initial inventory (`simulatePlan`) before it is shown. Each craft must be possible at that moment (A + A needs 2 A), and the replayed total must equal the announced maximum. Otherwise the optimizer throws instead of showing a wrong plan.

### 5. Reference engine: dynamic programming over inventory states (`stateSearch.js`)
This is the memoised recursion `best(state) = max_r gain(r) + best(state after r)`. The state is the ingredient-count vector, the recursion terminates because every craft lowers the total ingredient count, and it includes path reconstruction and the same tie-break. Its state space grows like Π(countᵢ + 1), so it is only used on small inventories: as a cross-check in the tests and to complete the heuristic. It refuses (throws `StateLimitError`) rather than approximate.

### Safety limits
Branch & cut has a node limit (250,000) and a time limit (15 s) per phase. If they are ever reached, the UI shows **"Not proven optimal"**, the best plan found and a proven upper bound ("the true maximum is at most …"). An approximation is never labelled optimal. In testing (realistic inventories of a few dozen per ingredient, and large ones of 150–240 per ingredient, for all 15 targets), every case finished proven optimal, typically in 1–500 ms.

## Getting started

The page loads ES modules, a Web Worker and the CSV files, so it has to be served over http. Opening `index.html` by double-clicking does not work.

```bash
npm start          # http://127.0.0.1:5199, Node.js 18+, nothing to install
```

Any static server does the same job, for example `python -m http.server`.

```bash
npm test           # unit tests, Node's built-in test runner
```

### Deploying
The project is plain static files, so it works from any path: GitHub Pages (serve the repository root), Netlify, Vercel or a plain folder. Nothing to build.

## Project structure

```
index.html  index.js  style.css   # the page
worker.js                         # Web Worker wrapper around the optimizer
server.js                         # tiny static server for local use
lib/                              # the domain and the engine, no DOM
  csv.js                          # CSV parsing + data validation
  model.js                        # indexed model, ingredient tiers, inventory helpers
  dependencyGraph.js              # reverse dependency filter from the target
  simplex.js                      # LP solver
  ilp.js                          # exact branch & cut for integer programs
  optimizer.js                    # Alchemy → integer program, tie-break, verification
  plan.js                         # executable grouped plan, craft-by-craft simulation
  stateSearch.js                  # memoised state-space DP (reference engine)
tests/optimizer.test.js           # unit tests
tt2_alchemy_v8_2_*.csv            # the game data
```

The shapes of the plain objects passed around (recipe, model, plan step, result) are described at the top of `lib/model.js`.

## Tests

`tests/optimizer.test.js` covers:
direct recipe, intermediate chain, longer chain, two non-greedy scenarios, mixed strategies, `A + A` (A=1 impossible, A=2 possible), impossible targets (result 0), repeated recipes, the tie-break, safety limits, CSV parsing/validation, the real chain `Pepper + Berries → Sand → Spirit → 19 Crafting Shards`, executable plans for every reward, **agreement with the exhaustive state search on random inventories**, and large inventories solved exactly. Every plan in the tests is replayed craft by craft from the initial inventory.

## Known limitations

- The optimizer maximises **one** reward at a time; there is no weighted mix of rewards.
- The four equipment types (Common, Rare, Event, Legendary) are separate targets, as in the CSV.
- Exactness is guaranteed when the result says *Proven optimal*. Pathological inventories could in theory hit the safety limits; the UI then says so explicitly and shows an upper bound.
- Counts are capped at 99,999 per ingredient in the UI.

## License

MIT, see [LICENSE](LICENSE). Unofficial fan project, not affiliated with Game Hive.
