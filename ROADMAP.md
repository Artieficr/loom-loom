# Roadmap

Checklist per feature area. When completing an item, mark it `[x]`, note where the code
lives, and keep `CLAUDE.md`'s file map in sync.

## Project setup

- [x] Project scaffolding (Entities/*, Timelines, default timeline, .loom home file) — `src/project.ts`
- [x] "Set up project" command + modal — `src/project.ts`, `src/main.ts`
- [x] Multiple projects per vault: .loom files in the file explorer are the entry points; commands resolve via single-project fallback or a project picker — `src/indexer.ts`, `src/main.ts`
- [x] Legacy single-root settings migration (auto-creates the .loom file) — `src/main.ts`

## Entities

- [x] Six entity types with basic frontmatter templates (type, pluginTags, description, relationships; role for characters; date for events/sessions; linkedSession for events) — `src/types.ts`, `src/project.ts`
- [x] Creation commands + modal (sessions: date only, managed file name `<Project> Session <date>`) — `src/project.ts`, `src/main.ts`
- [x] Entity page view: structured fields (name renames the file, description, tags, role, date, linked session picker, relationships editor, notes body) over plain .md; loom-internal clicks open it, file explorer still opens raw markdown — `src/views/entity-view.tsx`
- [ ] Deep/final frontmatter schemas per type (deliberate v0.1 non-goal)

## Index cache

- [x] Project discovery (.loom files) + in-memory index from frontmatter, incremental updates on change/delete/rename — `src/indexer.ts`
- [x] Outgoing + incoming (backlink) relationship resolution, including plain [[wikilinks]] in body/frontmatter as `link` connections — `src/indexer.ts`
- [x] JSON snapshot persisted to the plugin folder — `src/indexer.ts`

## Home

- [x] FileView over the project's .loom file: per-type buttons + counts, timeline/graph shortcuts — `src/views/home-view.tsx`

## List views

- [x] Per-type list with search, sort (name/created/modified/date), plugin-tag filter, click opens entity page, new-entity button — `src/views/list-view.tsx`

## Timeline

- [x] Migrated into the graph as a collapsible bottom drawer (Open/Collapse toggle, drag the bar edge to resize); no standalone timeline view — `src/views/graph-view.tsx`, `src/views/timeline-strip.tsx`
- [x] Sessions + events ordered by date; linked events nested + indented beneath their session — `src/views/timeline-strip.tsx`, `src/columns.ts`
- [x] Sessions display only their date; event-anchored columns show the date above the name — `src/views/timeline-strip.tsx`
- [x] Multiple timeline definitions from `/Timelines` frontmatter (types + tag filters), selectable in the drawer bar — `src/indexer.ts`
- [x] Hover tooltip from `description`, click opens entity page — `src/views/timeline-strip.tsx`
- [x] Per-project timeline settings: date display format + custom in-game calendar (month count, names, optional short names); opened from the drawer bar — `src/timeline-settings.ts`, `src/calendar.ts`
- [ ] Proportional time spacing / zoom (currently ordinal spacing)
- [ ] Drag/reflow interactivity

## Graph ("Loom graph")

- [x] Layered layout: sessions row, events grouped beneath linked session, globals on a fixed lower axis pulled toward connections — `src/graph/layout.ts`
- [x] Drag with spring-back physics; single click dims unconnected, double click opens the entity page — `src/views/graph-view.tsx`
- [x] Node colors per entity type, configurable in settings — `src/settings.ts`, `src/views/graph-view.tsx`
- [x] Side panel: connections grouped by type, collapsible, auto-collapse over threshold — `src/graph/side-panel.tsx`
- [x] Horizontal culling of off-screen nodes — `src/views/graph-view.tsx`
- [x] Camera navigation: wheel zoom around cursor, drag-pan with any mouse button, right-click a node to zoom + center, obstructed edges curved (configurable depth) — `src/views/graph-view.tsx`, `src/graph/layout.ts`
- [x] Side panel keeps the selected node visible (auto-pans when the panel would cover it) — `src/views/graph-view.tsx`
- [ ] Visual polish: animations, edge styling/bundling, performance tuning for large graphs
- [ ] Vertical virtualization of culling

## Settings

- [x] Tag vocabulary per entity type, graph collapse threshold (with value label), graph node colors — `src/settings.ts`
- [ ] Adopt the declarative settings API (`getSettingDefinitions`) once Obsidian 1.13 leaves Catalyst-only early access — the remaining lint warning; do not use 1.13-only APIs before then (minAppVersion stays 1.7.2)

## Docs & release

- [x] CLAUDE.md / ROADMAP.md / docs/ARCHITECTURE.md populated with real v0.1 state
- [x] Release workflow building main.js/manifest.json/styles.css on GitHub release — `.github/workflows/release.yml`
- [ ] README with screenshots/GIFs before community plugin submission
