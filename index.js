import { parseAlchemyData, validateAlchemyData } from "./lib/csv.js";
import { bestDirectQuantity, buildModel, toVector } from "./lib/model.js";

const INGREDIENTS_CSV = "tt2_alchemy_v8_2_ingredients.csv";
const RECIPES_CSV = "tt2_alchemy_v8_2_recipes.csv";

const INVENTORY_KEY = "tt2-alchemy:inventory:v1";
const TARGET_KEY = "tt2-alchemy:target:v1";
const MAX_COUNT = 99999;

// friendlier display names; internal values stay the CSV result_name
const REWARD_LABELS = { Eggs: "Pets / Eggs" };

// demo inventory for "Load example", by ingredient name (unknown names are ignored)
const EXAMPLE_INVENTORY = {
  Pepper: 42,
  Berries: 36,
  Mushroom: 31,
  Sand: 9,
  Petal: 8,
  Acorn: 7,
  Feather: 5,
  Shadow: 4,
  Spirit: 4,
  Essence: 3,
  Power: 2,
  Beetle: 3,
  Tooth: 1,
  Flame: 1,
  Steel: 1,
  Scale: 0
};

// stand-ins for the jar icons of the game, which are not shipped here
const ICONS = {
  Pepper: "🌶️",
  Berries: "🫐",
  Mushroom: "🍄",
  Sand: "🏜️",
  Petal: "🌸",
  Acorn: "🌰",
  Feather: "🪶",
  Shadow: "🌑",
  Spirit: "👻",
  Essence: "✨",
  Power: "⚡",
  Beetle: "🪲",
  Tooth: "🦷",
  Flame: "🔥",
  Steel: "🔩",
  Scale: "🐉"
};

const KINDS = [
  ["all", "All"],
  ["ingredient", "Ingredient"],
  ["reward", "Reward"]
];

const state = {
  data: null,
  model: null,
  rewards: [],
  bestDirect: {},
  inventory: [],
  target: "",
  // idle | running | done | error
  optimizer: { status: "idle" },
  showInventory: false,
  filters: { query: "", ing1: "", ing2: "", result: "", kind: "all" }
};

const els = {};
const fields = [];
let worker = null;
let requestId = 0;

/* ---------- small helpers ---------- */

function $(id) {
  return document.getElementById(id);
}

// el("div", { class: "x", onclick: fn }, "text", childNode): enough DOM building for this page
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }

  node.append(...children.flat().filter((child) => child !== false && child != null));
  return node;
}

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

function rewardLabel(name) {
  return REWARD_LABELS[name] ?? name;
}

// the icon of an ingredient, empty for rewards and unknown names
function icon(name) {
  return ICONS[name] ? el("span", { class: "icon", "aria-hidden": "true" }, ICONS[name]) : null;
}

function tierLabel(tier) {
  return tier === 0 ? "Base" : `T${tier}`;
}

function clampCount(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MAX_COUNT, Math.max(0, Math.floor(v)));
}

const inventoryKey = (inventory, target) => `${target}|${inventory.join(",")}`;

/* ---------- storage (failures are ignored: private mode, quota, blocked storage) ---------- */

function readStored(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const defaultTarget = () => (state.rewards.includes("Crafting Shards") ? "Crafting Shards" : state.rewards[0]);

// stored as a name -> count record so a reordered CSV cannot shift counts
function loadInventory() {
  const stored = readStored(INVENTORY_KEY);
  const names = state.model.ingredients;

  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return names.map(() => 0);
  return names.map((name) => clampCount(Number(stored[name] ?? 0)));
}

function saveInventory() {
  const names = state.model.ingredients;
  writeStored(INVENTORY_KEY, Object.fromEntries(names.map((name, i) => [name, state.inventory[i] ?? 0])));
}

function loadTarget() {
  const stored = readStored(TARGET_KEY);
  return typeof stored === "string" && state.rewards.includes(stored) ? stored : defaultTarget();
}

/* ---------- inventory ---------- */

function setInventory(next) {
  state.inventory = next.map(clampCount);
  saveInventory();
  updateInventory();
  updateStale();
}

function setOne(index, count) {
  setInventory(state.inventory.map((v, i) => (i === index ? count : v)));
}

function addAll(delta) {
  setInventory(state.inventory.map((v) => v + delta));
}

function clearInventory() {
  setInventory(state.inventory.map(() => 0));
}

function buildIngredient(name, tier, index) {
  const id = `ing-${name}`;
  const step = (delta) => setOne(index, state.inventory[index] + delta);
  const commit = (text) => {
    const n = Number.parseInt(text.replace(/\D/g, ""), 10);
    setOne(index, Number.isFinite(n) ? n : 0);
  };

  const minus = el(
    "button",
    {
      type: "button",
      class: "step-btn",
      "aria-label": `Decrease ${name}`,
      title: "−1 (Shift: −10)",
      onclick: (e) => step(e.shiftKey ? -10 : -1)
    },
    "−"
  );

  const plus = el(
    "button",
    {
      type: "button",
      class: "step-btn",
      "aria-label": `Increase ${name}`,
      title: "+1 (Shift: +10)",
      onclick: (e) => step(e.shiftKey ? 10 : 1)
    },
    "+"
  );

  // the field can be empty while typing, the stored count only follows once there are digits
  const input = el("input", {
    id,
    class: "count-input",
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    value: "0",
    onfocus: (e) => e.target.select(),
    onblur: (e) => {
      commit(e.target.value);
      e.target.value = String(state.inventory[index]);
    },
    oninput: (e) => {
      const clean = e.target.value.replace(/\D/g, "").slice(0, String(MAX_COUNT).length);
      e.target.value = clean;
      if (clean !== "") commit(clean);
    },
    onkeydown: (e) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        step(e.shiftKey ? 10 : 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        step(e.shiftKey ? -10 : -1);
      }
    }
  });

  const root = el(
    "div",
    { class: "ingredient" },
    el(
      "div",
      { class: "ingredient-head" },
      el("span", { class: "jar", "aria-hidden": "true" }, ICONS[name] ?? ""),
      el("label", { for: id, class: "ingredient-name" }, name),
      el(
        "span",
        {
          class: `tier tier-${Math.min(tier, 6)}`,
          title: tier === 0 ? "Cannot be crafted" : `Crafting depth ${tier}`
        },
        tierLabel(tier)
      )
    ),
    el("div", { class: "stepper" }, minus, input, plus)
  );

  fields[index] = { root, input, minus, plus, shown: 0 };
  return root;
}

// updates the existing controls in place, so a field being typed in keeps its focus and caret
function updateInventory() {
  state.inventory.forEach((value, i) => {
    const field = fields[i];

    if (field.shown !== value) {
      field.input.value = String(value);
      field.shown = value;
    }

    field.root.classList.toggle("has-stock", value > 0);
    field.minus.disabled = value <= 0;
    field.plus.disabled = value >= MAX_COUNT;
  });

  const total = state.inventory.reduce((sum, v) => sum + v, 0);
  els.inventorySub.textContent = `${formatNumber(total)} ingredients · arrow keys adjust, Shift for ±10`;
  els.clearBtn.disabled = total === 0;
}

/* ---------- target ---------- */

function setTarget(reward) {
  state.target = reward;
  writeStored(TARGET_KEY, reward);
  updateTarget();
  updateStale();
}

function buildTargets() {
  els.targetGrid.replaceChildren(
    ...state.rewards.map((reward) =>
      el(
        "button",
        {
          type: "button",
          role: "radio",
          class: "target-chip",
          "data-reward": reward,
          onclick: () => setTarget(reward)
        },
        el("span", { class: "target-name" }, rewardLabel(reward)),
        el(
          "span",
          { class: "target-best", title: "Best quantity from a single direct recipe" },
          `≤${state.bestDirect[reward]}/craft`
        )
      )
    )
  );
}

function updateTarget() {
  for (const chip of els.targetGrid.children) {
    const selected = chip.dataset.reward === state.target;
    chip.classList.toggle("selected", selected);
    chip.setAttribute("aria-checked", String(selected));
  }

  els.targetLabel.textContent = rewardLabel(state.target);
}

/* ---------- optimizer ---------- */

function stopWorker() {
  worker?.terminate();
  worker = null;
}

// a new request cancels the previous one
function runOptimizer() {
  stopWorker();

  const id = ++requestId;
  const target = state.target;
  const inventory = state.inventory.slice();
  const key = inventoryKey(inventory, target);

  worker = new Worker("worker.js", { type: "module" });
  setOptimizer({ status: "running", target });

  worker.onmessage = (e) => {
    if (e.data.id !== requestId) return;

    setOptimizer(
      e.data.ok
        ? { status: "done", result: e.data.result, inventoryKey: key }
        : { status: "error", message: e.data.error }
    );
    stopWorker();
  };

  worker.onerror = (e) => {
    setOptimizer({ status: "error", message: e.message || "Optimizer crashed" });
    stopWorker();
  };

  worker.postMessage({ id, data: state.data, inventory, target });
}

function cancelOptimizer() {
  stopWorker();
  requestId += 1;
  setOptimizer({ status: "idle" });
}

function setOptimizer(next) {
  state.optimizer = next;
  if (next.status === "done") state.showInventory = false;

  const running = next.status === "running";
  els.optimizeBtn.disabled = running;
  els.optimizeBtn.textContent = running ? "Optimizing…" : "Optimize";

  renderResult();
}

function resetAll() {
  clearInventory();
  setTarget(defaultTarget());
  cancelOptimizer();
}

// the result on screen no longer matches the inventory or the target
function updateStale() {
  const notice = $("staleNotice");
  if (!notice) return;

  const { optimizer } = state;
  notice.hidden = !(
    optimizer.status === "done" && optimizer.inventoryKey !== inventoryKey(state.inventory, state.target)
  );
}

/* ---------- result ---------- */

function renderResult() {
  const { optimizer } = state;
  let view;

  if (optimizer.status === "idle") {
    view = el(
      "section",
      { class: "card card-parchment result-card result-empty" },
      el(
        "p",
        { class: "muted" },
        "Enter your ingredients, pick a target and press ",
        el("strong", {}, "Optimize"),
        ". The optimizer explores every crafting chain, including intermediate ingredients, and returns the plan that maximises your target."
      )
    );
  } else if (optimizer.status === "running") {
    view = el(
      "section",
      { class: "card card-parchment result-card result-running", "aria-live": "polite" },
      // placeholder blocks in the shape of the result: a headline, then plan rows
      el("div", { class: "skeleton skeleton-title", "aria-hidden": "true" }),
      el("p", {}, "Searching for the optimal crafting path…"),
      [0, 1, 2, 3].map(() => el("div", { class: "skeleton skeleton-row", "aria-hidden": "true" })),
      el("button", { type: "button", class: "btn", onclick: cancelOptimizer }, "Cancel")
    );
  } else if (optimizer.status === "error") {
    view = el(
      "section",
      { class: "card card-parchment result-card result-error", role: "alert" },
      el("p", {}, el("strong", {}, "Optimization failed."), ` ${optimizer.message}`)
    );
  } else {
    view = resultView(optimizer.result);
  }

  els.result.replaceChildren(view);
  updateStale();
}

function resultView(result) {
  const names = state.model.ingredients;
  const label = rewardLabel(result.target);
  const planList = el("ol", { class: "plan enter" });
  const fillPlan = () =>
    planList.replaceChildren(
      ...planItems(result, label).map((item, i) => {
        item.style.setProperty("--i", Math.min(i, 14));
        return item;
      })
    );

  const copyButton = el("button", { type: "button", class: "btn btn-info btn-sm" }, "Copy plan");
  copyButton.addEventListener("click", async () => {
    const lines = [
      `TT2 Alchemy plan: ${formatNumber(result.value)} ${result.target}${result.exact ? " (optimal)" : ""}`,
      ...result.steps.map(
        (s, i) => `${i + 1}. ${s.times}× ${s.recipe.ingredient1} + ${s.recipe.ingredient2} → ${s.recipe.result}`
      )
    ];

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      copyButton.textContent = "Copied";
      setTimeout(() => (copyButton.textContent = "Copy plan"), 1500);
    } catch {
      /* clipboard unavailable */
    }
  });

  const toggle = el("input", {
    type: "checkbox",
    onchange: (e) => {
      state.showInventory = e.target.checked;
      fillPlan();
    }
  });

  fillPlan();
  // the entrance plays once: later refills (the inventory toggle) must not replay it
  setTimeout(() => planList.classList.remove("enter"), 1200);

  const { stats } = result;
  const time = stats.timeMs < 10 ? stats.timeMs.toFixed(1) : Math.round(stats.timeMs);

  return el(
    "section",
    { class: "card card-parchment result-card", "aria-live": "polite" },
    el(
      "div",
      { id: "staleNotice", class: "notice", hidden: true },
      "Inventory or target changed since this result. Press Optimize to refresh it."
    ),

    el(
      "div",
      { class: "headline" },
      el(
        "div",
        {},
        el("div", { class: "eyebrow" }, "Maximum achievable"),
        el("div", { class: "big-value" }, `${formatNumber(result.value)} `, el("span", { class: "big-unit" }, label))
      ),
      el(
        "span",
        { class: `badge ${result.exact ? "badge-ok" : "badge-warn"}` },
        result.exact ? "Proven optimal" : "Not proven optimal"
      )
    ),

    !result.exact &&
      el(
        "p",
        { class: "warn-text" },
        `The search hit its safety limit. This plan gives ${formatNumber(result.value)}; the true maximum is at most ${formatNumber(result.upperBound)}.`
      ),

    result.value === 0
      ? el(
          "p",
          { class: "muted" },
          `No sequence of crafts can produce ${label} from this inventory. Check the Recipe Book below to see which ingredients you need.`
        )
      : [
          el(
            "div",
            { class: "section-row" },
            el("h3", { class: "section-title" }, "Optimal plan"),
            el(
              "div",
              { class: "toolbar" },
              el("label", { class: "toggle" }, toggle, "Inventory after each step"),
              copyButton
            )
          ),
          planList,
          el("h3", { class: "section-title" }, "Total rewards"),
          el(
            "div",
            { class: "totals" },
            el("div", { class: "total-main" }, `${formatNumber(result.value)} ${label}`),
            el(
              "div",
              { class: "muted small" },
              `${formatNumber(result.totalCrafts)} crafts · ${result.steps.length} distinct recipes`
            )
          )
        ],

    el("h3", { class: "section-title" }, "Inventory remaining"),
    el(
      "div",
      { class: "remaining-grid" },
      names.map((name, i) => {
        const before = result.initial[i];
        const after = result.remaining[i];

        return el(
          "div",
          { class: `remaining${after === 0 ? " zero" : ""}` },
          el("span", { class: "remaining-name" }, name),
          el(
            "span",
            { class: "remaining-count" },
            before !== after && el("span", { class: "was" }, `${formatNumber(before)} → `),
            formatNumber(after)
          )
        );
      })
    ),

    el(
      "details",
      { class: "stats" },
      el(
        "summary",
        {},
        `${result.exact ? "Optimal solution" : "Best found"} · ${formatNumber(stats.nodesExplored)} search nodes · ${time} ms`
      ),
      el(
        "dl",
        {},
        el("dt", {}, "Exact result"),
        el("dd", {}, result.exact ? "yes" : "no"),
        el("dt", {}, "Engine"),
        el("dd", {}, "Branch & cut on an integer program (one variable per useful recipe)"),
        el("dt", {}, "Search nodes"),
        el("dd", {}, formatNumber(stats.nodesExplored)),
        el("dt", {}, "LP relaxations solved"),
        el("dd", {}, formatNumber(stats.lpSolved)),
        el("dt", {}, "Plan verified"),
        el("dd", {}, "yes, replayed craft by craft from your inventory")
      ),
      result.notes.map((note) => el("p", { class: "muted small" }, note))
    )
  );
}

// intermediates first, then the reward crafts; each row needs the inventory before it for the diff
function planItems(result, label) {
  const transforms = result.steps.filter((s) => s.phase === "transform");
  const rewards = result.steps.filter((s) => s.phase === "reward");
  const items = [];

  if (transforms.length > 0) items.push(el("li", { class: "plan-phase" }, "Craft intermediate ingredients"));

  transforms.forEach((step, i) => {
    const prev = i === 0 ? result.initial : transforms[i - 1].inventoryAfter;
    items.push(stepRow(step, i + 1, prev));
  });

  items.push(el("li", { class: "plan-phase" }, `Craft ${label}`));

  rewards.forEach((step, i) => {
    const prev =
      i === 0 ? (transforms.at(-1)?.inventoryAfter ?? result.initial) : rewards[i - 1].inventoryAfter;
    items.push(stepRow(step, transforms.length + i + 1, prev));
  });

  return items;
}

function stepRow(step, index, prev) {
  const r = step.recipe;
  const isReward = step.phase === "reward";

  return el(
    "li",
    { class: "plan-step" },
    el("span", { class: "plan-index" }, String(index)),
    el("span", { class: "plan-times" }, `${step.times}×`),
    el(
      "span",
      { class: "plan-recipe" },
      el("span", { class: "pill" }, icon(r.ingredient1), r.ingredient1),
      el("span", { class: "op" }, "+"),
      el("span", { class: "pill" }, icon(r.ingredient2), r.ingredient2),
      el("span", { class: "op" }, "→"),
      el(
        "span",
        { class: `pill ${isReward ? "pill-reward" : "pill-made"}` },
        isReward ? r.result : [icon(r.resultName), r.resultName]
      )
    ),
    isReward && el("span", { class: "plan-gain" }, `+${formatNumber(step.gained)}`),
    state.showInventory &&
      el(
        "span",
        { class: "plan-inv" },
        state.model.ingredients.map((name, i) => {
          const v = step.inventoryAfter[i];
          const d = v - prev[i];
          if (v === 0 && d === 0) return null;

          return el("span", { class: `inv-chip${d < 0 ? " down" : d > 0 ? " up" : ""}` }, `${name} ${formatNumber(v)}`);
        })
      )
  );
}

/* ---------- recipe book ---------- */

function option(value, text) {
  return el("option", { value }, text);
}

function buildRecipeFilters() {
  const { recipes } = state.data;
  const names = state.data.ingredients;

  const ingredientResults = new Set(recipes.filter((r) => r.kind === "ingredient").map((r) => r.resultName));
  const rewardResults = new Set(recipes.filter((r) => r.kind === "reward").map((r) => r.resultName));

  els.ing1Select.replaceChildren(option("", "Ingredient 1: any"), ...names.map((n) => option(n, n)));
  els.ing2Select.replaceChildren(option("", "Ingredient 2: any"), ...names.map((n) => option(n, n)));
  els.resultSelect.replaceChildren(
    option("", "Result: any"),
    el("optgroup", { label: "Rewards" }, [...rewardResults].map((r) => option(r, rewardLabel(r)))),
    el(
      "optgroup",
      { label: "Ingredients" },
      names.filter((n) => ingredientResults.has(n)).map((n) => option(n, n))
    )
  );

  els.kindFilter.replaceChildren(
    ...KINDS.map(([kind, text]) =>
      el(
        "button",
        {
          type: "button",
          role: "radio",
          "data-kind": kind,
          onclick: () => {
            state.filters.kind = kind;
            renderRecipes();
          }
        },
        text
      )
    )
  );
}

function matchesFilters(r) {
  const { query, ing1, ing2, result, kind } = state.filters;
  const pair = [r.ingredient1, r.ingredient2];

  // ingredient filters match either slot: Pepper + Scale is the same craft as Scale + Pepper
  if (ing1 && !pair.includes(ing1)) return false;

  if (ing2) {
    const rest = ing1 ? (pair[0] === ing1 ? pair[1] : pair[0]) : null;
    if (rest !== null ? rest !== ing2 : !pair.includes(ing2)) return false;
  }

  if (result && r.resultName !== result) return false;
  if (kind !== "all" && r.kind !== kind) return false;

  const q = query.trim().toLowerCase();
  if (q) {
    const hay = `${r.ingredient1} ${r.ingredient2} ${r.result} ${rewardLabel(r.resultName)}`.toLowerCase();
    if (!q.split(/\s+/).every((term) => hay.includes(term))) return false;
  }

  return true;
}

function renderRecipes() {
  const { recipes } = state.data;
  const filters = state.filters;
  const filtered = recipes.filter(matchesFilters);

  els.recipesSub.textContent = `${filtered.length} of ${recipes.length} recipes, loaded from the CSV files`;

  for (const button of els.kindFilter.children) {
    const active = button.dataset.kind === filters.kind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  }

  els.clearFiltersBtn.hidden = !(
    filters.query ||
    filters.ing1 ||
    filters.ing2 ||
    filters.result ||
    filters.kind !== "all"
  );

  const rows = filtered.map((r) =>
    el(
      "tr",
      {},
      el("td", { class: "num muted" }, String(r.id)),
      el("td", {}, icon(r.ingredient1), r.ingredient1),
      el("td", {}, icon(r.ingredient2), r.ingredient2),
      el(
        "td",
        { class: r.kind === "reward" ? "reward-cell" : "made-cell" },
        r.kind === "reward" ? `${r.quantity} ${rewardLabel(r.resultName)}` : [icon(r.resultName), r.resultName]
      ),
      el("td", {}, el("span", { class: `kind kind-${r.kind}` }, r.kind === "reward" ? "Reward" : "Ingredient"))
    )
  );

  if (rows.length === 0) {
    rows.push(
      el("tr", {}, el("td", { colspan: "5", class: "muted empty-row" }, "No recipe matches these filters."))
    );
  }

  els.recipeBody.replaceChildren(...rows);
}

function clearFilters() {
  state.filters = { query: "", ing1: "", ing2: "", result: "", kind: "all" };
  els.searchInput.value = "";
  els.ing1Select.value = "";
  els.ing2Select.value = "";
  els.resultSelect.value = "";
  renderRecipes();
}

/* ---------- start ---------- */

function showDataProblems(problems) {
  els.dataNotice.replaceChildren(
    el("strong", {}, "Data inconsistencies detected in the CSV files:"),
    el("ul", {}, problems.map((p) => el("li", {}, p)))
  );
  els.dataNotice.hidden = false;
}

async function loadData() {
  const [ingredients, recipes] = await Promise.all(
    [INGREDIENTS_CSV, RECIPES_CSV].map(async (file) => {
      const response = await fetch(file);
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      return response.text();
    })
  );

  return parseAlchemyData(ingredients, recipes);
}

function bind() {
  els.loadExampleBtn.addEventListener("click", () => setInventory(toVector(state.model, EXAMPLE_INVENTORY)));
  els.addAllBtn.addEventListener("click", () => addAll(1));
  els.clearBtn.addEventListener("click", clearInventory);
  els.resetAllBtn.addEventListener("click", resetAll);
  els.optimizeBtn.addEventListener("click", runOptimizer);

  els.searchInput.addEventListener("input", (e) => {
    state.filters.query = e.target.value;
    renderRecipes();
  });

  for (const [select, key] of [
    [els.ing1Select, "ing1"],
    [els.ing2Select, "ing2"],
    [els.resultSelect, "result"]
  ]) {
    select.addEventListener("change", (e) => {
      state.filters[key] = e.target.value;
      renderRecipes();
    });
  }

  els.clearFiltersBtn.addEventListener("click", clearFilters);
}

async function init() {
  [
    "dataNotice",
    "inventorySub",
    "loadExampleBtn",
    "addAllBtn",
    "clearBtn",
    "resetAllBtn",
    "inventoryGrid",
    "targetGrid",
    "optimizeBtn",
    "targetLabel",
    "result",
    "recipesSub",
    "searchInput",
    "ing1Select",
    "ing2Select",
    "resultSelect",
    "kindFilter",
    "clearFiltersBtn",
    "recipeBody"
  ].forEach((id) => {
    els[id] = $(id);
  });

  try {
    state.data = await loadData();
  } catch (error) {
    console.error(error);
    els.dataNotice.textContent =
      "Could not load the CSV files. Open this page through a web server (npm start), not from the file system.";
    els.dataNotice.hidden = false;
    els.optimizeBtn.disabled = true;
    return;
  }

  const problems = validateAlchemyData(state.data);
  if (problems.length > 0) showDataProblems(problems);

  // a cyclic recipe set is rejected loudly by buildModel and ends up in the same banner
  try {
    state.model = buildModel(state.data);
  } catch (error) {
    showDataProblems([error.message]);
    els.optimizeBtn.disabled = true;
    return;
  }

  state.rewards = state.model.rewardNames;
  state.bestDirect = bestDirectQuantity(state.model);
  state.inventory = loadInventory();
  state.target = loadTarget();

  els.inventoryGrid.replaceChildren(
    ...state.model.ingredients.map((name, i) => buildIngredient(name, state.model.tier[i], i))
  );

  buildTargets();
  buildRecipeFilters();
  bind();

  updateInventory();
  updateTarget();
  renderRecipes();
  renderResult();

  // like the app always did, whatever was read is written back right away
  saveInventory();
  writeStored(TARGET_KEY, state.target);
}

init();
