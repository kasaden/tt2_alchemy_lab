import { parseAlchemyData, validateAlchemyData } from "./lib/csv.js";
import { MAX_WEIGHT, bestDirectQuantity, buildModel, toVector } from "./lib/model.js";

const INGREDIENTS_CSV = "tt2_alchemy_v8_2_ingredients.csv";
const RECIPES_CSV = "tt2_alchemy_v8_2_recipes.csv";

const INVENTORY_KEY = "tt2-alchemy:inventory:v1";
const TARGET_KEY = "tt2-alchemy:target:v1";
const MODE_KEY = "tt2-alchemy:mode:v1";
const WEIGHTS_KEY = "tt2-alchemy:weights:v1";
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

// the names say what each mode does; the keys stay standard / expert
const MODES = [
  ["standard", "One reward"],
  ["expert", "Mix of rewards"]
];

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
  // standard: one reward, one point a unit. expert: a value per reward, the best mix wins
  mode: "standard",
  weights: {},
  // idle | running | done | error
  optimizer: { status: "idle" },
  showInventory: false,
  planView: "list",
  walkIndex: 0,
  bookView: "table",
  shown: 0,
  filters: { query: "", ing1: "", ing2: "", result: "", kind: "all" }
};

const els = {};
const fields = [];
const weightFields = {};
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

function clampWeight(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MAX_WEIGHT, Math.max(0, Math.floor(v)));
}

const inventoryKey = (inventory, objective) => `${objective}|${inventory.join(",")}`;

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

function loadMode() {
  return readStored(MODE_KEY) === "expert" ? "expert" : "standard";
}

// stored as a name -> weight record, unknown names and bad values are dropped
function loadWeights() {
  const stored = readStored(WEIGHTS_KEY);
  const record = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};

  return Object.fromEntries(state.rewards.map((reward) => [reward, clampWeight(Number(record[reward] ?? 0))]));
}

/* ---------- inventory ---------- */

function setInventory(next) {
  state.inventory = next.map(clampCount);
  saveInventory();
  updateInventory();
  updateStale();
  updateOptimizeBar();
  if (state.optimizer.status === "idle") renderResult();
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
  els.inventorySub.textContent = `${formatNumber(total)} ingredients · saved in this browser only · arrow keys adjust, Shift for ±10`;
  els.clearBtn.disabled = total === 0;
}

/* ---------- objective ---------- */

// what the optimizer is asked for: one reward by name (Standard), or the weights of the rewards
// that count (Expert). Same split as the Sheet and tt2.bagu.biz: a plain target, or a value per reward.
function currentObjective() {
  if (state.mode === "standard") return state.target;
  return Object.fromEntries(Object.entries(state.weights).filter(([, weight]) => weight > 0));
}

const objectiveKey = () => `${state.mode}|${JSON.stringify(currentObjective())}`;

const hasInventory = () => state.inventory.some((count) => count > 0);
const hasValues = () => state.mode === "standard" || Object.values(state.weights).some((weight) => weight > 0);

function canOptimize() {
  return hasInventory() && hasValues();
}

// names of the rewards that currently count, for the highlights of the recipe matrix
function countedRewards() {
  const objective = currentObjective();
  return new Set(typeof objective === "string" ? [objective] : Object.keys(objective));
}

function setTarget(reward) {
  state.target = reward;
  writeStored(TARGET_KEY, reward);
  updateObjective();
  updateStale();
}

function setMode(mode) {
  state.mode = mode;
  writeStored(MODE_KEY, mode);
  updateObjective();
  updateStale();
}

function setWeight(reward, weight) {
  state.weights = { ...state.weights, [reward]: clampWeight(weight) };
  writeStored(WEIGHTS_KEY, state.weights);
  updateObjective();
  updateStale();
}

function resetWeights() {
  state.weights = Object.fromEntries(state.rewards.map((reward) => [reward, 0]));
  writeStored(WEIGHTS_KEY, state.weights);
  updateObjective();
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
          { class: "target-best", title: "The most a single craft of this reward can give" },
          `≤${state.bestDirect[reward]}/craft`
        )
      )
    )
  );
}

function buildModeSwitch() {
  els.modeSwitch.replaceChildren(
    ...MODES.map(([mode, text]) =>
      el("button", { type: "button", role: "radio", "data-mode": mode, onclick: () => setMode(mode) }, text)
    )
  );
}

// a value per reward: whole numbers, 0 leaves the reward out
function buildWeights() {
  els.weightsGrid.replaceChildren(
    ...state.rewards.map((reward) => {
      const id = `weight-${reward}`;

      const input = el("input", {
        id,
        class: "weight-input",
        type: "text",
        inputmode: "numeric",
        autocomplete: "off",
        value: "0",
        onfocus: (e) => e.target.select(),
        onblur: (e) => {
          setWeight(reward, Number.parseInt(e.target.value.replace(/\D/g, ""), 10) || 0);
          e.target.value = String(state.weights[reward]);
        },
        oninput: (e) => {
          const clean = e.target.value.replace(/\D/g, "").slice(0, String(MAX_WEIGHT).length);
          e.target.value = clean;
          if (clean !== "") setWeight(reward, Number.parseInt(clean, 10));
        },
        onkeydown: (e) => {
          const step = e.shiftKey ? 10 : 1;
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setWeight(reward, state.weights[reward] + step);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setWeight(reward, state.weights[reward] - step);
          }
        }
      });

      const row = el("div", { class: "weight-row" }, el("label", { for: id }, rewardLabel(reward)), input);
      weightFields[reward] = { row, input, shown: 0 };
      return row;
    })
  );
}

function updateObjective() {
  const expert = state.mode === "expert";

  for (const chip of els.targetGrid.children) {
    const selected = chip.dataset.reward === state.target;
    chip.classList.toggle("selected", selected);
    chip.setAttribute("aria-checked", String(selected));
  }

  for (const button of els.modeSwitch.children) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  }

  els.targetGrid.hidden = expert;
  els.expertPanel.hidden = !expert;
  els.objectiveSub.textContent = expert
    ? "Give each reward a value in points. The plan is the one with the highest total, so it can mix rewards. 0 leaves a reward out."
    : "Pick the reward you want as much of as possible. The ≤ number is the most one craft can give.";

  // typed text stays as it is while a field is being edited, the others follow the stored values
  for (const [reward, field] of Object.entries(weightFields)) {
    const weight = state.weights[reward] ?? 0;
    if (field.shown !== weight) {
      field.input.value = String(weight);
      field.shown = weight;
    }
    field.row.classList.toggle("counts", weight > 0);
  }

  updateOptimizeBar();
  updateMatrixHits();
}

function updateOptimizeBar() {
  const running = state.optimizer.status === "running";

  els.optimizeBtn.disabled = running || !canOptimize();
  els.optimizeBtn.textContent = running ? "Optimizing…" : "Optimize";

  els.optimizeHint.replaceChildren(
    ...(!hasInventory()
      ? ["Enter your ingredients first"]
      : !hasValues()
        ? ["Give at least one reward a value above 0 first"]
        : state.mode === "standard"
          ? ["Goal: as much ", el("strong", {}, rewardLabel(state.target)), " as possible"]
          : ["Goal: the highest ", el("strong", {}, "total value")])
  );
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
  const objective = currentObjective();
  const inventory = state.inventory.slice();
  const key = inventoryKey(inventory, objectiveKey());

  worker = new Worker("worker.js", { type: "module" });
  setOptimizer({ status: "running" });

  // on a narrow screen the result sits under the form, make sure you see it start
  if (window.matchMedia("(max-width: 1040px)").matches) {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    els.optimizeBtn.closest(".col-result").scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
  }

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

  worker.postMessage({ id, data: state.data, inventory, objective });
}

function cancelOptimizer() {
  stopWorker();
  requestId += 1;
  setOptimizer({ status: "idle" });
}

function setOptimizer(next) {
  state.optimizer = next;

  if (next.status === "done") {
    state.showInventory = false;
    state.planView = "list";
    state.walkIndex = 0;
  }

  updateOptimizeBar();
  renderResult();
}

function resetAll() {
  clearInventory();
  state.mode = "standard";
  writeStored(MODE_KEY, state.mode);
  state.target = defaultTarget();
  writeStored(TARGET_KEY, state.target);
  resetWeights();
  cancelOptimizer();
}

// the result on screen no longer matches the inventory or the objective
function updateStale() {
  const notice = $("staleNotice");
  if (!notice) return;

  const { optimizer } = state;
  notice.hidden = !(
    optimizer.status === "done" && optimizer.inventoryKey !== inventoryKey(state.inventory, objectiveKey())
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
      state.inventory.every((count) => count === 0)
        ? el(
            "p",
            { class: "muted" },
            "Your inventory is empty. Enter what you own on the left, or press ",
            el("strong", {}, "Load example"),
            " to see how it works."
          )
        : el(
            "p",
            { class: "muted" },
            "Choose what you want, then press ",
            el("strong", {}, "Optimize"),
            ". You get the crafts to make, in order, and what they bring. Crafts that only make a stepping stone ingredient are included."
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
  // one reward worth 1 point a unit reads as "N of that reward", anything else as points
  const plain = result.target !== null && result.objective[result.target] === 1;
  const label = plain ? rewardLabel(result.target) : "points";
  const rewardEntries = Object.entries(result.rewards).sort(
    ([a, p], [b, q]) => q * result.objective[b] - p * result.objective[a]
  );

  const planBox = el("div", { class: "plan-box" });
  const planList = el("ol", { class: "plan enter" });
  const fillPlan = () =>
    planList.replaceChildren(
      ...planItems(result, plain ? label : "rewards").map((item, i) => {
        item.style.setProperty("--i", Math.min(i, 14));
        return item;
      })
    );

  const toggleLabel = el("label", { class: "toggle" });
  const viewSwitch = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Plan view" });

  // the plan is either the whole list or one step at a time, like the "Next step" of the Sheet
  const renderPlanBox = (focus) => {
    const walking = state.planView === "walk";
    toggleLabel.hidden = walking;

    for (const button of viewSwitch.children) {
      const active = button.dataset.view === state.planView;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    }

    planBox.replaceChildren(walking ? walkView(result, renderPlanBox) : planList);
    if (focus) planBox.querySelector(focus)?.focus();
  };

  viewSwitch.append(
    ...[
      ["list", "List"],
      ["walk", "Step by step"]
    ].map(([view, text]) =>
      el(
        "button",
        {
          type: "button",
          role: "radio",
          "data-view": view,
          onclick: () => {
            state.planView = view;
            renderPlanBox();
          }
        },
        text
      )
    )
  );

  const toggle = el("input", {
    type: "checkbox",
    onchange: (e) => {
      state.showInventory = e.target.checked;
      fillPlan();
    }
  });
  toggleLabel.append(toggle, "Inventory after each step");

  const copyButton = el("button", { type: "button", class: "btn btn-info btn-sm" }, "Copy plan");
  copyButton.addEventListener("click", async () => {
    const summary = plain
      ? `${formatNumber(result.value)} ${result.target}`
      : `${formatNumber(result.value)} points (${rewardEntries.map(([n, q]) => `${formatNumber(q)} ${n}`).join(", ")})`;
    const lines = [
      `TT2 Alchemy plan: ${summary}${result.exact ? " (optimal)" : ""}`,
      ...result.steps.map(
        (s, i) =>
          `${i + 1}. ${s.times}× ${s.recipe.ingredient1} + ${s.recipe.ingredient2} → ${s.recipe.result}${s.recipe.bonus ? ` (+ ${s.recipe.bonus})` : ""}`
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

  fillPlan();
  renderPlanBox();
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
      "Inventory or objective changed since this result. Press Optimize to refresh it."
    ),

    el(
      "div",
      { class: "headline" },
      el(
        "div",
        {},
        el("div", { class: "eyebrow" }, plain ? "The most you can get" : "Best total value"),
        el("div", { class: "big-value" }, `${formatNumber(result.value)} `, el("span", { class: "big-unit" }, label))
      ),
      el(
        "span",
        {
          class: `badge ${result.exact ? "badge-ok" : "badge-warn"}`,
          title: result.exact
            ? "Checked by the optimizer: no other sequence of crafts does better with this inventory"
            : "The search stopped early, a better plan may exist"
        },
        result.exact ? "Best possible" : "Best found, not proven"
      )
    ),

    result.exact &&
      result.value > 0 &&
      el(
        "p",
        { class: "result-lead" },
        plain
          ? `No other sequence of crafts gives more ${label} from this inventory.`
          : "No other sequence of crafts gives a higher total from this inventory."
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
          plain
            ? `No sequence of crafts can produce ${label} from this inventory. Check the Recipe Book below to see which ingredients you need.`
            : "No sequence of crafts can produce a reward with a value above 0 from this inventory. Check the Recipe Book below to see which ingredients you need."
        )
      : [
          el(
            "div",
            { class: "section-row" },
            el("h3", { class: "section-title" }, "What to craft, in order"),
            el("div", { class: "toolbar" }, viewSwitch, toggleLabel, copyButton)
          ),
          el("p", { class: "plan-help" }, "Read each line as: do this craft that many times, top to bottom."),
          planBox,
          el("h3", { class: "section-title" }, "What you get"),
          el(
            "div",
            { class: "totals" },
            el("div", { class: "total-main" }, `${formatNumber(result.value)} ${label}`),
            el(
              "div",
              { class: "muted small" },
              `${formatNumber(result.totalCrafts)} crafts · ${result.steps.length} distinct recipes`
            )
          ),
          !plain &&
            el(
              "div",
              { class: "reward-list" },
              rewardEntries.map(([name, quantity]) =>
                el(
                  "div",
                  { class: "reward-chip" },
                  el("span", { class: "reward-qty" }, formatNumber(quantity)),
                  el("span", { class: "reward-name" }, rewardLabel(name)),
                  el(
                    "span",
                    { class: "reward-pts" },
                    `× ${formatNumber(result.objective[name])} = ${formatNumber(quantity * result.objective[name])}`
                  )
                )
              )
            )
        ],

    el("h3", { class: "section-title" }, "What you have left"),
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
        `How it was computed · ${formatNumber(stats.nodesExplored)} search nodes · ${time} ms`
      ),
      el(
        "dl",
        {},
        el("dt", {}, "Best possible?"),
        el("dd", {}, result.exact ? "yes, proven" : "not proven, the search hit its safety limit"),
        el("dt", {}, "Method"),
        el("dd", {}, "an integer program with one variable per useful recipe, solved exactly (branch and cut)"),
        el("dt", {}, "Search nodes"),
        el("dd", {}, formatNumber(stats.nodesExplored)),
        el("dt", {}, "LP relaxations solved"),
        el("dd", {}, formatNumber(stats.lpSolved)),
        el("dt", {}, "Plan checked"),
        el("dd", {}, "yes, replayed craft by craft from your inventory")
      ),
      result.notes.map((note) => el("p", { class: "muted small" }, note))
    )
  );
}

// intermediates first, then the reward crafts; each row needs the inventory before it for the diff
function planItems(result, rewardsLabel) {
  const transforms = result.steps.filter((s) => s.phase === "transform");
  const rewards = result.steps.filter((s) => s.phase === "reward");
  const items = [];

  if (transforms.length > 0) items.push(el("li", { class: "plan-phase" }, "First, make these ingredients"));

  transforms.forEach((step, i) => {
    const prev = i === 0 ? result.initial : transforms[i - 1].inventoryAfter;
    items.push(stepRow(step, i + 1, prev));
  });

  items.push(el("li", { class: "plan-phase" }, `Then craft ${rewardsLabel}`));

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
      ),
      r.bonus && el("span", { class: "bonus-tag", title: "A one-off extra, not counted in the total" }, `+ ${r.bonus}`)
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

/* ---------- step by step ---------- */

// the start, one entry per grouped step, the end: what you do and what you hold afterwards
function walkSteps(result) {
  const all = [
    {
      text: "This is your starting inventory. Press Next to begin.",
      inventory: result.initial
    }
  ];

  for (const step of result.steps) {
    const r = step.recipe;

    all.push({
      text:
        step.phase === "transform"
          ? `Craft ${formatNumber(step.times)} ${r.resultName} by combining ${r.ingredient1} and ${r.ingredient2}.`
          : `Craft ${r.ingredient1} + ${r.ingredient2}, ${formatNumber(step.times)} ${step.times === 1 ? "time" : "times"}, to get ${formatNumber(step.gained)} ${rewardLabel(r.resultName)}${r.bonus ? `, plus ${r.bonus}` : ""}.`,
      inventory: step.inventoryAfter
    });
  }

  all.push({ text: "There is nothing left to craft. This is what remains.", inventory: result.remaining });
  return all;
}

function walkView(result, rerender) {
  const all = walkSteps(result);
  const last = all.length - 1;
  const index = Math.min(state.walkIndex, last);
  const previous = all[Math.max(0, index - 1)].inventory;

  const go = (delta, focus) => {
    state.walkIndex = Math.max(0, Math.min(last, index + delta));
    rerender(focus);
  };

  const count = index === 0 ? "Start" : index === last ? "Done" : `Step ${index} of ${last - 1}`;

  return el(
    "div",
    {
      class: "walk",
      tabindex: "0",
      role: "group",
      "aria-label": "Step by step crafting, use the left and right arrow keys",
      onkeydown: (e) => {
        if (e.key === "ArrowRight" && index < last) {
          e.preventDefault();
          go(1, ".walk");
        } else if (e.key === "ArrowLeft" && index > 0) {
          e.preventDefault();
          go(-1, ".walk");
        }
      }
    },
    el(
      "div",
      { class: "walk-top" },
      el("span", { class: "walk-count" }, count),
      el(
        "div",
        { class: "walk-bar", "aria-hidden": "true" },
        el("span", { style: `width: ${(index / last) * 100}%` })
      )
    ),
    el("p", { class: "walk-text" }, all[index].text),
    el(
      "div",
      { class: "walk-nav" },
      el(
        "button",
        { type: "button", class: "btn", disabled: index === 0, "data-walk": "prev", onclick: () => go(-1, '[data-walk="prev"]') },
        "← Previous"
      ),
      el(
        "button",
        { type: "button", class: "btn btn-info", disabled: index === last, "data-walk": "next", onclick: () => go(1, '[data-walk="next"]') },
        "Next →"
      )
    ),
    el(
      "div",
      { class: "remaining-grid" },
      state.model.ingredients.map((name, i) => {
        const now = all[index].inventory[i];
        const before = previous[i];
        const change = index === 0 ? 0 : now - before;

        return el(
          "div",
          { class: `remaining${now === 0 && change === 0 ? " zero" : ""}${change > 0 ? " up" : change < 0 ? " down" : ""}` },
          el("span", { class: "remaining-name" }, icon(name), name),
          el(
            "span",
            { class: "remaining-count" },
            change !== 0 && el("span", { class: "was" }, `${formatNumber(before)} → `),
            formatNumber(now)
          )
        );
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

  state.shown = filtered.length;
  updateBookSub();

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
        r.kind === "reward" ? `${r.quantity} ${rewardLabel(r.resultName)}` : [icon(r.resultName), r.resultName],
        r.bonus && el("span", { class: "bonus-tag" }, `+ ${r.bonus}`)
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

function updateBookSub() {
  const total = state.data.recipes.length;

  els.recipesSub.textContent =
    state.bookView === "table"
      ? `${state.shown} of ${total} recipes. Every pair of ingredients gives one result.`
      : `All ${total} pairs, like the recipe matrix of the Sheet. Gold cells pay the rewards that count in your objective.`;
}

function setBookView(view) {
  state.bookView = view;
  els.tableView.hidden = view !== "table";
  els.matrixView.hidden = view !== "matrix";

  for (const button of els.bookView.children) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  }

  updateBookSub();
}

function buildBookView() {
  els.bookView.replaceChildren(
    ...[
      ["table", "Table"],
      ["matrix", "Matrix"]
    ].map(([view, text]) =>
      el("button", { type: "button", role: "radio", "data-view": view, onclick: () => setBookView(view) }, text)
    )
  );
}

function matrixCell(recipe) {
  const reward = recipe.kind === "reward";

  return el(
    "td",
    {
      class: `mx ${reward ? "mx-reward" : "mx-made"}`,
      "data-result": recipe.resultName,
      title: `${recipe.ingredient1} + ${recipe.ingredient2} = ${recipe.result}${recipe.bonus ? `, plus ${recipe.bonus}` : ""}`
    },
    reward
      ? [el("strong", {}, formatNumber(recipe.quantity)), el("span", {}, rewardLabel(recipe.resultName))]
      : [icon(recipe.resultName), el("span", {}, recipe.resultName)],
    recipe.bonus && el("em", { class: "mx-bonus" }, `+ ${recipe.bonus}`)
  );
}

// every pair once: a + b is the same craft as b + a, so only the upper triangle is filled
function buildMatrix() {
  const names = state.data.ingredients;
  const byPair = new Map();

  for (const r of state.model.recipes) {
    byPair.set(`${Math.min(r.in1, r.in2)},${Math.max(r.in1, r.in2)}`, r.recipe);
  }

  const head = el(
    "tr",
    {},
    el("th", { class: "mx-corner", scope: "col" }, "+"),
    names.map((name) => el("th", { class: "mx-head", scope: "col" }, icon(name), el("span", {}, name)))
  );

  const rows = names.map((rowName, i) =>
    el(
      "tr",
      {},
      el("th", { class: "mx-side", scope: "row" }, icon(rowName), rowName),
      names.map((_, j) => {
        const recipe = byPair.get(`${i},${j}`);
        return j < i || !recipe ? el("td", { class: "mx mx-skip", "aria-hidden": "true" }) : matrixCell(recipe);
      })
    )
  );

  els.matrixView.replaceChildren(
    el("table", { class: "matrix", "aria-label": "Recipe matrix" }, el("thead", {}, head), el("tbody", {}, rows))
  );
}

function updateMatrixHits() {
  const counted = countedRewards();

  for (const cell of els.matrixView.querySelectorAll("td[data-result]")) {
    cell.classList.toggle("hit", counted.has(cell.dataset.result));
  }
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
  els.resetWeightsBtn.addEventListener("click", resetWeights);

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
    "modeSwitch",
    "objectiveSub",
    "expertPanel",
    "weightsGrid",
    "resetWeightsBtn",
    "optimizeBtn",
    "optimizeHint",
    "result",
    "recipesSub",
    "searchInput",
    "ing1Select",
    "ing2Select",
    "resultSelect",
    "kindFilter",
    "clearFiltersBtn",
    "recipeBody",
    "bookView",
    "tableView",
    "matrixView"
  ].forEach((id) => {
    els[id] = $(id);
  });

  try {
    state.data = await loadData();
  } catch (error) {
    console.error(error);
    els.dataNotice.textContent =
      "Could not load the CSV files. Open this page through a web server (node server.js), not from the file system.";
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
  state.mode = loadMode();
  state.weights = loadWeights();

  els.inventoryGrid.replaceChildren(
    ...state.model.ingredients.map((name, i) => buildIngredient(name, state.model.tier[i], i))
  );

  buildTargets();
  buildModeSwitch();
  buildWeights();
  buildRecipeFilters();
  buildBookView();
  buildMatrix();
  bind();

  updateInventory();
  updateObjective();
  renderRecipes();
  setBookView(state.bookView);
  renderResult();

  // like the app always did, whatever was read is written back right away
  saveInventory();
  writeStored(TARGET_KEY, state.target);
  writeStored(MODE_KEY, state.mode);
  writeStored(WEIGHTS_KEY, state.weights);
}

init();
