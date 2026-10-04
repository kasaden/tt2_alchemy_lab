/**
 * Minimal RFC-4180-ish CSV parser: handles a UTF-8 BOM, CRLF/LF line endings,
 * quoted fields with embedded commas, and doubled quotes. Empty lines are skipped.
 */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n')
        i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0)
    return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((cells) => {
    const rec = {};
    header.forEach((h, idx) => {
      rec[h] = (cells[idx] ?? '').trim();
    });
    return rec;
  });
}
function requireColumns(rows, columns, file) {
  if (rows.length === 0)
    throw new Error(`${file}: no data rows`);
  for (const col of columns) {
    if (!(col in rows[0]))
      throw new Error(`${file}: missing column "${col}"`);
  }
}
export function parseIngredients(text) {
  const rows = parseCsv(text);
  requireColumns(rows, ['ingredient_id', 'ingredient'], 'ingredients CSV');
  return rows
    .map((r) => ({ id: Number(r.ingredient_id), name: r.ingredient }))
    .sort((a, b) => a.id - b.id)
    .map((r) => r.name);
}
export function parseRecipes(text) {
  const rows = parseCsv(text);
  requireColumns(rows, ['recipe_id', 'ingredient_1', 'ingredient_2', 'result', 'result_kind', 'result_quantity', 'result_name'], 'recipes CSV');
  return rows.map((r, line) => {
    const kind = r.result_kind;
    if (kind !== 'ingredient' && kind !== 'reward') {
      throw new Error(`recipes CSV row ${line + 2}: unknown result_kind "${r.result_kind}"`);
    }
    const quantity = Number(r.result_quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`recipes CSV row ${line + 2}: invalid result_quantity "${r.result_quantity}"`);
    }
    return {
      id: Number(r.recipe_id),
      ingredient1: r.ingredient_1,
      ingredient2: r.ingredient_2,
      result: r.result,
      kind,
      quantity,
      resultName: r.result_name,
      // optional column: a one-off extra the craft gives besides its result, shown but never counted
      bonus: r.bonus ?? '',
    };
  });
}
export function parseAlchemyData(ingredientsCsv, recipesCsv) {
  return { ingredients: parseIngredients(ingredientsCsv), recipes: parseRecipes(recipesCsv) };
}
/**
 * Objective consistency checks on the raw data. Returns a list of human-readable
 * problems (empty when the data is consistent). Does not modify anything.
 */
export function validateAlchemyData(data) {
  const problems = [];
  const known = new Set(data.ingredients);
  if (known.size !== data.ingredients.length)
    problems.push('Duplicate ingredient names.');
  const seenIds = new Set();
  const seenPairs = new Map();
  for (const r of data.recipes) {
    if (seenIds.has(r.id))
      problems.push(`Recipe id ${r.id} is duplicated.`);
    seenIds.add(r.id);
    for (const ing of [r.ingredient1, r.ingredient2]) {
      if (!known.has(ing))
        problems.push(`Recipe ${r.id}: unknown ingredient "${ing}".`);
    }
    const pair = [r.ingredient1, r.ingredient2].sort().join(' + ');
    const prev = seenPairs.get(pair);
    if (prev !== undefined)
      problems.push(`Recipes ${prev} and ${r.id} use the same pair (${pair}).`);
    seenPairs.set(pair, r.id);
    if (r.kind === 'ingredient') {
      if (!known.has(r.resultName))
        problems.push(`Recipe ${r.id}: produces unknown ingredient "${r.resultName}".`);
      if (r.quantity !== 1)
        problems.push(`Recipe ${r.id}: ingredient result with quantity ${r.quantity}.`);
      if (r.result !== r.resultName)
        problems.push(`Recipe ${r.id}: result "${r.result}" ≠ result_name "${r.resultName}".`);
    } else if (r.result !== `${r.quantity} ${r.resultName}`) {
      problems.push(`Recipe ${r.id}: result "${r.result}" does not match "${r.quantity} ${r.resultName}".`);
    }
  }
  const n = data.ingredients.length;
  const expectedPairs = (n * (n + 1)) / 2;
  if (seenPairs.size !== expectedPairs) {
    problems.push(`Expected ${expectedPairs} unique ingredient pairs, found ${seenPairs.size}.`);
  }
  return problems;
}
