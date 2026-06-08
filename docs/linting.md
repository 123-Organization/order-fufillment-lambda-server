# Linting (Platform APIs)

ESLint and Prettier are configured for **Shopify, Squarespace, and Wix** API code only. Other parts of the repo are not linted yet.

## Setup (one time)

```bash
npm install
```

Recommended: install the [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) and [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) extensions. This repo includes [`.vscode/settings.json`](../.vscode/settings.json) for format-on-save and ESLint auto-fix.

## Commands

| Task | Command |
|------|---------|
| Lint one file | `npm run lint:file -- src/controllers/wix-products.js` |
| Lint all platform APIs | `npm run lint:platform` |
| Auto-fix ESLint issues (platform scope) | `npm run lint:fix:platform` |
| Format platform files | `npm run format:platform` |
| Check formatting only (platform scope) | `npm run format:check:platform` |
| Lint entire repo (only files in ESLint scope) | `npm run lint` |
| Format entire repo | `npm run format` |

## What is in scope

**Controllers**

- `src/controllers/shopify-*.js`
- `src/controllers/squarespace-*.js`
- `src/controllers/wix-*.js`
- `src/controllers/platform-order-sync.js`
- `src/controllers/disconnect-store.js`

**Helpers**

- `src/helpers/shopify-*.js`
- `src/helpers/squarespace-*.js`
- `src/helpers/wix-*.js`
- `src/helpers/platform-connections.js`

Config lives in [`eslint.config.js`](../eslint.config.js) and [`.prettierrc`](../.prettierrc).

## Checklist for new platform APIs

1. **File naming** — Put new code under `src/controllers/{platform}-*.js` or `src/helpers/{platform}-*.js` so it matches existing globs automatically.
2. **New platform** — If you add a store that does not match those patterns (e.g. `src/controllers/etsy-auth.js`), add the path to:
   - `platformFiles` in [`eslint.config.js`](../eslint.config.js)
   - The glob strings in `lint:platform`, `lint:fix:platform`, `format:platform`, and `format:check:platform` in [`package.json`](../package.json)
3. **Before PR** — Run `npm run lint:file -- path/to/your-file.js` and ensure the file is formatted (format-on-save or `npm run format:platform`).
4. **Rule disables** — Avoid `eslint-disable` unless necessary; add a short comment explaining why.

## Shared cross-platform files

Changes to [`platform-order-sync.js`](../src/controllers/platform-order-sync.js) or [`platform-connections.js`](../src/helpers/platform-connections.js) must pass platform lint.

## Expanding lint to the full repo (later)

1. Broaden `platformFiles` in `eslint.config.js` to cover `src/**/*.js` (or remove the path filter).
2. Run `npm run format` and `npm run lint:fix` in batches.
3. Optionally add a CI lint job when the team wants merge-time enforcement.

## CI

Lint is **local-only** for now. Developers run the commands above before opening a PR.
