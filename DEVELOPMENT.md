# Development history

TeamCreator was developed locally before this repository was published on 27 September 2026. The initial public commit, [51f0e13](https://github.com/Lucian-Adrian/teamcreator-mvp/commit/51f0e13), contains the existing MVP. Earlier milestones below are recovered from dated local development records and synthetic screenshots. They are not claims that matching Git commits existed at those earlier times.

Subsequent commits preserve real changes in reviewable groups. Commit dates are their actual creation dates. The initial public history has not been rewritten.

## Product direction and implementation

Lucian directed the product, reviewed the interface, approved the v7 visual direction and requested the white simulation map. Codex and Luna agents implemented and checked the software under that direction. This page does not attribute agent implementation to Lucian's personal coding work.

## Milestones

| Date of source record | Problem or decision | Delivered change and evidence |
|---|---|---|
| 26 September 2026 | A project manager needed to trace people, tasks and decisions back to documents. | Local source ingestion, reviewable proposals, dependencies and a synthetic streetlight project. Recovered from the local changelog dated 26 September; the resulting source is in the initial public commit. |
| 27 September 2026, first Live release | A browser demo needed to work without exposing the local project store. | Separate browser storage, deterministic table intake, Monte Carlo, reports and a dedicated Worker. The recorded first Cloudflare version was `8097f3b7-8ef5-4d48-a960-8b90fcbfa875`. |
| 27 September 2026, visual review | Lucian found the first interface too far from the proposed images. | The approved v7 direction was applied across Context, people and task views, decisions and report previews. Current synthetic captures are below. |
| 27 September 2026, source release | The MVP needed a public, portable source package. | A fresh repository with 78 explicitly selected source/configuration/asset files, a portable Worker configuration and no runtime project data. Initial commit: [51f0e13](https://github.com/Lucian-Adrian/teamcreator-mvp/commit/51f0e13). |
| 27 September 2026, simulation review | Sample labels could misstate a run's empirical rank; a remaining-work forecast needed correlated run data. | Actual completion ranks and full-sample remaining-work quantiles, with focused tests: [45dc529](https://github.com/Lucian-Adrian/teamcreator-mvp/commit/45dc529). |
| 27 September 2026, intake review | Upload progress could reach 100% before processing finished, and history mixed languages. | Progress stays below completion until the service responds; source/history labels are localized: [a7dbb1d](https://github.com/Lucian-Adrian/teamcreator-mvp/commit/a7dbb1d). |
| 27 September 2026, profile and mobile review | Saving an unchanged profile field could disturb its evidence; the selected member could be hard to reach on mobile. | Save only changed fields and bring the selected member inspector into view: [68331d3](https://github.com/Lucian-Adrian/teamcreator-mvp/commit/68331d3). |
| 27 September 2026, forecast review | The burndown needed the full-sample forecast and small deadline risks must remain visible. | Connected the correlated forecast and kept one decimal place for probabilities: [857f242](https://github.com/Lucian-Adrian/teamcreator-mvp/commit/857f242). |
| 27 September 2026, simulation interface review | Lucian rejected dark simulation concepts. An earlier white plot also placed the chart too low and did not show a common starting point. | A white diagram with a shared origin, actual sampled runs, task selection, completion-group filters, zoom, pan and a side inspector: [c4d2a1a](https://github.com/Lucian-Adrian/teamcreator-mvp/commit/c4d2a1a). |
| 27 September 2026, report review | The client report footer fell below the desktop preview, and renamed sources could leave stale draft labels. | Tighter desktop spacing and source-name-sensitive draft updates: [297a305](https://github.com/Lucian-Adrian/teamcreator-mvp/commit/297a305). |

## Recovered synthetic snapshots

These are application captures recovered from the 27 September local verification session. People, documents, dates and portraits belong to the synthetic demo. Screenshots are evidence of the rendered views at that point; they do not establish customer use or successful external integrations.

### Context and source review

![Synthetic source list and evidence inspector](docs/context-v7.png)

### People and responsibilities

![Synthetic people map and member evidence](docs/people-v7.png)

### Simulation before the final visual correction

The earlier view used task finish days vertically and placed a long legend above the chart. This recovered snapshot explains the correction; it is not the current interface.

![Earlier simulation layout, before the common-origin map](docs/simulation-before.png)

### White simulation map

The horizontal direction follows task stages. The vertical layout groups sampled runs by their empirical completion third. It is a diagram layout, without a numeric time scale or inferred cause of delay. Dates and durations are shown for the actual selected run.

![White interactive simulation map with actual sampled runs](docs/simulation-white.jpg)

### Client report

![Synthetic client report with explicit unknowns and source references](docs/client-report-v7.png)

## Verification recorded on 27 September 2026

- Production TypeScript/Vite builds passed in both the working project and the separate public checkout.
- 27 focused tests passed for simulation, collaboration validation, the isolated records API, reports and browser parsing/storage. The Worker boundary check passed separately, for 28 focused checks in this revision.
- Browser checks covered a real synthetic CSV file selection, correction, selective acceptance, rejection, reload persistence and retained profile citations.
- A paired 10,000-run intervention reduced the final task by one modeled day. In that saved test workspace, baseline P50 was 21 days and intervention P50 was 20 days, using paired random draws. This is a model result, not an observed delivery improvement.
- The white map was checked at 1586 × 992 and in a 390 × 844 mobile viewport. A separate Luna review found no blocking visual issue. The mobile overview remains small at default zoom; zoom, pan and the run list provide access.
- Family filtering, keyboard task selection, modeled start/finish dates, zoom, pan and reset were exercised in the browser. The burndown displays the forecast separately from confirmed completion history.

To repeat the focused checks from this checkout:

```sh
npm ci
npm run build:live
node --import tsx --test shared/simulation.test.ts shared/collaboration-profile.test.ts server/records-api.test.ts frontend/src/project-report.test.ts frontend/src/public-parser.test.ts frontend/src/public-runtime.test.ts live-worker.test.mjs
```

## Current boundaries

Public AI still requires project-owned API access, a configured model and Cloudflare Access. Integration cards show setup requirements; they do not demonstrate connected Jira, Trello, mail or assistant accounts. The local agent adapter is not an installed assistant plugin. Reports and message drafts remain unsent until a person acts.

The public repository excludes private source documents, local project stores, internal conversation records and credentials. The screenshots above contain synthetic application content only.

[Browse the complete public commit history](https://github.com/Lucian-Adrian/teamcreator-mvp/commits/main/)
