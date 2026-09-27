# TeamCreator MVP

Live demo: https://live.teamcreator.ai

TeamCreator helps a project manager review sources, connect team responsibilities and dependencies, compare delivery scenarios, and record decisions. The included streetlight project is synthetic. Names, source excerpts, dates, and portraits are demonstration material.

[Development history, iterations and verification](DEVELOPMENT.md) · [Public commits](https://github.com/Lucian-Adrian/teamcreator-mvp/commits/main/)

## Run locally

Use Node.js 22 or later and npm.

```sh
npm ci
npm run dev
```

The frontend runs on http://127.0.0.1:5173 and the local API on http://127.0.0.1:3001. For the built local app, run `npm run build` and `npm start`.

The local API stores projects outside this repository in the operating system's application-data directory. Set `TC_GIGAHACK_DATA_DIR` to use a dedicated directory. Keep that directory private.

## Browser demo

```sh
npm run build:live
npm run preview:live
```

Open http://127.0.0.1:5187. Projects are stored in this browser using IndexedDB, with a bounded fallback where needed. Snapshot export/import transfers reviewed project state and excerpts; it is not a backup of original files.

The presentation opens directly in Context with 10 synthetic people, 20 tasks and 10 cited sources. Two proposals are ready for review. Browser Back restores the project page, task view and selection. Existing projects remain available in the project picker.

Browser parsing supports text, Markdown, CSV, TSV, XLS, and XLSX. PDF and DOCX require the local runtime. Source extraction produces proposals that a manager must review before they update the project.

## Capabilities and limits

- Context: source coverage, quote references, item-level correction, rejection and acceptance, audit history.
- Team and tasks: people map, task list, Gantt, Kanban, burndown and explained priorities.
- Collaboration: explicitly supplied preferences, soft skills and assessment summaries with source attribution. No personality inference from photographs or CVs.
- Monte Carlo: 10,000 runs by default, seeded durations, dependencies, capacity, common risks and a configurable work calendar. The branch map exposes actual sampled runs; completion families divide the full sample by finish order. The burndown forecast uses all iterations. Results describe the entered assumptions.
- Decisions and reports: source-linked actions, paired intervention comparisons, editable unsent messages, and separate client and sponsor reports. Reports can be prepared before a simulation exists. Markdown downloads directly; PDF uses the browser print dialog.
- Integrations: branded Jira, Trello, Asana, SharePoint, Gmail, Outlook, Claude, ChatGPT and Codex configuration dialogs, directly in Context. The presentation includes clearly marked demo settings. Saving settings does not authenticate an account or start synchronization.

## AI and agent access

The local runtime can call an independently installed and authenticated Codex CLI. Availability and successful extraction are tracked separately. `TC_GIGAHACK_CODEX_MODEL` selects a model available to that CLI account. The repository contains no account credentials.

`agent-tools.mjs` is a local JSON-lines adapter for reading context, locating evidence, tracing impacts, proposing changes and running scenarios. Set `TC_AGENT_API_URL` for a different loopback port. It is not an installed Codex, Claude or ChatGPT plugin and does not grant access to browser-only projects. Proposal application remains a manager action.

The public AI adapter is off until the deployment has its own API credential, model and Cloudflare Access configuration. Configure `TC_AI_API_KEY` as a Worker secret and `TC_AI_MODEL`, `TC_ACCESS_TEAM_DOMAIN`, and `TC_ACCESS_AUD` as deployment settings. Do not reuse personal CLI credentials. The UI asks for explicit text sharing before AI processing.

## Deploy

`wrangler.live.jsonc` is a portable example without an account or custom domain. Choose your own Worker name, authenticate Wrangler to your account, build, and deploy:

```sh
npm run build:live
npm run deploy:live
```

If enabling the public AI endpoint, configure Cloudflare Access and the required environment settings before use. The default deployment remains usable without AI.

## Source scope

This repository contains the MVP source, tests, build configuration and synthetic assets. Runtime projects, uploaded documents, credentials, private exports and internal project records are excluded. The Git history starts with this standalone source release.
