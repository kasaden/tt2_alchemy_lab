# Contributing

Thanks for helping. This is a small static site: plain HTML, CSS and JavaScript, no build step and
no dependency to install. The optimizer is the part that has to stay correct, so changes to it come
with a test.

## Run it

The page needs a web server (it loads ES modules, a worker and the CSV files):

```bash
node server.js           # http://127.0.0.1:5199
```

or any static server, for instance `python -m http.server`.

```bash
node --test              # the unit tests
```

`server.js` and the tests need Node.js 22.7 or newer. The CI runs the tests on every pull request.

## Updating the recipes

The game data lives in two CSV files at the root, `tt2_alchemy_v8_2_ingredients.csv` and
`tt2_alchemy_v8_2_recipes.csv`. They are the recipes of the
[community spreadsheet](https://docs.google.com/spreadsheets/d/1o95Ipwx6NIyFV3LCz9LGNbH9_WELHF-pbpkM31YwXyY/edit?gid=1745300311#gid=1745300311),
exported to CSV. Nothing is copied into the code, so an update is a change to those files only.

If the spreadsheet is right and a CSV is not, re-export it. If the mistake is in both, tell the
people who maintain the spreadsheet too.

- Keep the columns (see the README). The ingredient order is the order used everywhere.
- A complete set has 16 ingredients and 136 recipes (one per unordered pair). The tests check it,
  and so does the page, which shows a banner when the data is inconsistent.
- If the game adds ingredients, the test expecting 16 ingredients and 136 recipes has to change with
  the data: say so in the pull request.
- Name the game version or the event date in the pull request.

## Changing the optimizer

The engine is in `lib/` and does not touch the DOM. It runs in the page, in the worker and in Node.

- A change that can alter results needs a test in `tests/optimizer.test.js`. The test that compares
  the optimizer to the exhaustive state search on random inventories is the one to trust: keep it green.
- A plan is never shown without being replayed craft by craft. Do not weaken that check.
- The optimizer must never call a result optimal when it is not. If you touch the limits or the cuts,
  keep `exact` honest.

## Changing the page

- Keep it plain: no framework, no bundler, no npm dependency.
- Match the surrounding code: two spaces, double quotes, semicolons. `.editorconfig` covers the basics.
- Check the page at a desktop width and at a phone width, with and without a result on screen.
- Keep the `localStorage` keys (`tt2-alchemy:inventory:v1`, `tt2-alchemy:target:v1`) unless you
  migrate what users already saved.
- The page deliberately follows the look of the in-game Alchemy Lab window, and shares its width, top
  bar and footer with the Dungeon Eggsplorer site. Keep those three aligned if you change them.

## Commit messages

Short, in the imperative, with a type in front:

```
feat: add a copy button to the plan
fix: keep the cursor in the count field while typing
docs: explain the safety limits
chore(data): update recipes to v8.3
```

`feat`, `fix`, `docs`, `style` (formatting only), `refactor`, `chore`. Recipe updates are `chore(data)`.

## Reporting a problem

Open an issue with your inventory, the target, what you got and what you expected. A plan that looks
wrong is the most valuable report: paste it with *Copy plan*.
