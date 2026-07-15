# Roadmap

Checklist per feature area. When completing an item, mark it `[x]`, note where the code
lives, and keep `CLAUDE.md`'s file map in sync.

## Project setup

- [x] Project scaffolding (Entities/*, Timelines, default timeline, .loom home file) — `src/project.ts`
- [x] "Set up project" command + modal — `src/project.ts`, `src/main.ts`
- [x] Multiple projects per vault: .loom files in the file explorer are the entry points; commands resolve via single-project fallback or a project picker — `src/indexer.ts`, `src/main.ts`
- [x] Legacy single-root settings migration (auto-creates the .loom file) — `src/main.ts`

## Entities

- [x] Seven entity types with basic frontmatter templates (type, loomTags, description, relationships; role for characters; date for events/sessions; linkedSession — one or several — for events; quests currently share the basic template, unique fields planned) — `src/types.ts`, `src/project.ts`
- [x] Creation command + modal: one context-aware "Create entity in current project" command with an entity-type suggester (replaced the per-type commands); sessions: date only, managed file name `<Project> Session <date>` — `src/project.ts`, `src/main.ts`
- [x] Entity page view: structured fields (name renames the file, description, tags, role, date, linked session picker, notes body, relationships editor) over plain .md; loom-internal clicks open it, file explorer still opens raw markdown — `src/views/entity-view.tsx`
- [x] Description/Notes textareas resize from any point on the bottom edge (not just the native corner grip) and remember their height per file across sessions (`settings.entityBoxSizes`, keyed by path, migrated on rename) — `src/views/common.tsx`, `src/views/entity-view.tsx`, `src/views/link-textarea.tsx`, `src/settings.ts`, `src/main.ts`
- [x] Relationships editor: target search field offers "+ Create entity…" pinned at the top of its suggestion list, prompting an entity type then the create modal, wiring the new note in as that row's target — `src/views/entity-view.tsx`, `src/views/common.tsx`
- [x] Connected-entities sections on every entity page: one collapsible section per connected type (collapsed by default), entries expand to the target's description + notes with in-place edit/save and a jump-to-page arrow — `src/views/connected-entities.tsx`
- [x] Session attendance: PC-character toggle chips on session pages, stored in `attendance` as hidden connections (no graph edges); PCs get an Alive tick + death-session picker, and later-dated sessions stop offering dead PCs — `src/views/entity-view.tsx`, `src/indexer.ts`
- [x] Entity deletion with confirmation: trash icon on list rows and in the entity page header (Back/list fallback after delete) — `src/views/list-view.tsx`, `src/views/entity-view.tsx`
- [x] Session date entry uses a native `<input type="date">` (calendar picker) in both the creation modal and the entity page, since sessions are always Gregorian; events keep the free-text field + "@today" (they may follow the project's custom calendar) — `src/project.ts`, `src/views/entity-view.tsx`
- [ ] Description/Notes editing closer to Obsidian's native editor — so far only `[[` auto-close and link-name suggestions are replicated (`src/views/link-textarea.tsx`); still missing things like markdown formatting shortcuts/hotkeys, list continuation on Enter, tab/shift-tab indent, and other CM6 editor behaviors a plain `<textarea>` doesn't give for free
- [ ] Deep/final frontmatter schemas per type (deliberate v0.1 non-goal)
- [ ] Quest-specific fields (status, giver, rewards, …) — currently the basic template
- [ ] Sublocations: a "New sublocation" action on a Location's own page creates a child Location entity, auto-connected back to its parent (a relationship declared on creation, not a separate frontmatter field) — otherwise a complete, independent Location entity like any other, not a stripped-down variant

## Index cache

- [x] Project discovery (.loom files) + in-memory index from frontmatter, incremental updates on change/delete/rename — `src/indexer.ts`
- [x] Outgoing + incoming (backlink) relationship resolution, including plain [[wikilinks]] in body/frontmatter as `link` connections — `src/indexer.ts`
- [x] JSON snapshot persisted to the plugin folder — `src/indexer.ts`

## Home

- [x] FileView over the project's .loom file: per-type buttons + counts, timeline/graph shortcuts — `src/views/home-view.tsx`

- [x] Icon-only navigation rail on the left of every page except home (home, entity lists, graph); replaces the header Home button — Back alone stays in the header, greyed out when there's nowhere to return — `src/views/common.tsx`

## List views

- [x] Per-type list with search, sort (name/created/modified/date), plugin-tag filter, click opens entity page, new-entity button — `src/views/list-view.tsx`
- [ ] Nested sublocation lists: in the Locations list, sublocations group/indent under their parent, collapsible per parent (collapsed by default once a parent has more than 5), plus toolbar-level "Collapse all" / "Expand all" buttons

## Timeline

- [x] Migrated into the graph as a collapsible bottom drawer (Open/Collapse toggle, drag the bar edge to resize); no standalone timeline view — `src/views/graph-view.tsx`, `src/views/timeline-strip.tsx`
- [x] Sessions + events ordered by date; linked events nested + indented beneath their session — `src/views/timeline-strip.tsx`, `src/columns.ts`
- [x] Sessions display only their date; event-anchored columns show the date above the name — `src/views/timeline-strip.tsx`
- [x] Multiple timeline definitions from `/Timelines` frontmatter (types + tag filters), selectable in the drawer bar — `src/indexer.ts`
- [x] Hover tooltip from `description`, click opens entity page — `src/views/timeline-strip.tsx`
- [x] Per-project timeline settings: date display format + custom in-game calendar (month count, names, optional short names); edited in the settings tab's Graph tab — `src/timeline-settings.ts`, `src/calendar.ts`
- [ ] Proportional time spacing / zoom (currently ordinal spacing)
- [ ] Drag/reflow interactivity

## Graph ("Loom")

- [x] Layered layout: sessions row, events grouped beneath linked session, globals in one row per type (order configurable in settings, default quests/characters/factions/items/locations) pulled toward connections — `src/graph/layout.ts`
- [x] Drag with spring-back physics; single click dims unconnected, double click opens the entity page — `src/views/graph-view.tsx`
- [x] Node colors per entity type, configurable in settings — `src/settings.ts`, `src/views/graph-view.tsx`
- [x] Side panel: connections grouped by type, collapsible, auto-collapse over threshold — `src/graph/side-panel.tsx`
- [x] Horizontal culling of off-screen nodes — `src/views/graph-view.tsx`
- [x] Camera navigation: wheel zoom around cursor, drag-pan with any mouse button, right-click a node to zoom + center — `src/views/graph-view.tsx`
- [x] Side panel keeps the selected node visible (auto-pans when the panel would cover it) — `src/views/graph-view.tsx`
- [ ] Visual polish: animations, edge styling/bundling, performance tuning for large graphs
- [ ] Vertical virtualization of culling
- [ ] Sticky globals while panning: a global node whose connected timeline nodes are on screen slides along with the pan (e.g. Frodo, linked to sessions 4–10, stays visible while scrolling within that range) — never let one endpoint of a visible connection sit off-screen so the user loses track of what connects to what
- [x] Orthogonal edge routing (replaced the bowed curves): horizontal exits, per-edge vertical trunk lanes in the corridors between columns (corridors widen for branching-heavy nodes — inconsistent date spacing accepted), horizontal runs in per-edge y-lanes in the bands between rows, diagonal fan entries into each cross-row edge's lower node, same-row edges as U shapes beside their row, all bends slightly rounded — `src/graph/routing.ts`, `src/graph/layout.ts`

## Settings

- [x] Tag vocabulary per entity type, graph collapse threshold (with value label), graph node colors — `src/settings.ts`
- [ ] Adopt the declarative settings API (`getSettingDefinitions`) once Obsidian 1.13 leaves Catalyst-only early access — the remaining lint warning; do not use 1.13-only APIs before then (minAppVersion stays 1.7.2)

## Docs & release

- [x] CLAUDE.md / ROADMAP.md / docs/ARCHITECTURE.md populated with real v0.1 state
- [x] Release workflow building main.js/manifest.json/styles.css on GitHub release — `.github/workflows/release.yml`
- [ ] README with screenshots/GIFs before community plugin submission
