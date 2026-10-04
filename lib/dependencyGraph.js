/**
 * Reverse dependency analysis from the target reward.
 *
 * Only two kinds of crafts can ever help maximise a reward R:
 *   1. recipes that produce R;
 *   2. transforms (A + B → C) where C is, transitively, an input of a recipe of kind 1.
 *
 * Every other recipe either produces a different reward or an ingredient that can
 * never reach R; crafting it only destroys ingredients, so excluding it cannot
 * remove an optimal solution. This is a safe (exactness-preserving) filter.
 */
export function relevantRecipes(model, target) {
  const targetRecipes = model.recipes.filter((r) => r.out < 0 && r.recipe.resultName === target);
  const useful = new Set();
  const stack = [];
  const mark = (i) => {
    if (!useful.has(i)) {
      useful.add(i);
      stack.push(i);
    }
  };
  for (const r of targetRecipes) {
    mark(r.in1);
    mark(r.in2);
  }
  // Walk producers backwards: if C is useful, the inputs of any recipe producing C are useful.
  while (stack.length > 0) {
    const c = stack.pop();
    for (const r of model.recipes) {
      if (r.out === c) {
        mark(r.in1);
        mark(r.in2);
      }
    }
  }
  const transforms = model.recipes.filter((r) => r.out >= 0 && useful.has(r.out));
  return { targetRecipes, transforms, usefulIngredients: useful };
}
