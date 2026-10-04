// Runs the optimizer off the main thread so the page stays responsive during large searches.
// The page sends the parsed CSV data with each request, building the model from it is cheap.

import { buildModel } from "./lib/model.js";
import { optimize } from "./lib/optimizer.js";

self.onmessage = (event) => {
  const { id, data, inventory, target } = event.data;

  try {
    const result = optimize(buildModel(data), inventory, target);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
