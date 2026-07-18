# Loom Loom!

System-agnostic TTRPG worldbuilding and session-management plugin for Obsidian. Tracks
characters, locations, factions, items, quests, events, and sessions as markdown notes with YAML
frontmatter, plus typed relationships between them, visualized through a custom timeline
and a custom layered graph view.

> **Doc upkeep is part of finishing a task, not a separate chore.** Whenever files are
> added, moved, renamed, or a feature is completed, update the file map below,
> `ROADMAP.md`, and (for design changes) `docs/ARCHITECTURE.md` in the same change.

## File map

| Path | Purpose |
| --- | --- |
| `src/main.ts` | Plugin entry: view/command/settings registration, .loom extension, legacy + frontmatter/file-name migrations on load, context-aware project resolution for commands (active view/file, else single-project/picker) |
| `src/types.ts` | Entity types + metadata, record/connection/timeline/date shapes, `FM` frontmatter-key registry (+ legacy spellings), view type IDs |
| `src/fm.ts` | Shared frontmatter read/write helpers: case-insensitive reads with legacy-key fallback, loom-key writes that clean stale spellings |
| `src/naming.ts` | Managed file-name construction (`<Project> <Type label> <name>`), dependency-free for indexer + project use |
| `src/settings.ts` | Global settings: text size, tag vocabulary, graph node colors, collapse threshold, global layer order; tabbed settings UI (General/Entities/Graph, per-project timeline settings under Graph) |
| `src/indexer.ts` | Index cache: project discovery (.loom files), frontmatter → in-memory records, vault event handling, connection queries (incl. native links), JSON snapshot persistence |
| `src/calendar.ts` | Date model: parsing (Gregorian + custom in-game calendars), display formats, per-project `ProjectConfig` (de)serialization |
| `src/columns.ts` | Chronological column layout shared by timeline and graph (sessions anchor columns, session-connected events stack beneath) |
| `src/project.ts` | Project scaffolding (.loom + folders), entity creation (managed session file names), setup/create/pick modals |
| `src/timeline-settings.ts` | Per-project timeline settings editor (date format + custom calendar), embedded in the settings tab's Graph tab, writes to the .loom file |
| `src/views/` | React views: home (FileView over .loom), entity page (FileView over .md), list, graph, focused per-session mini graph (`mini-graph.tsx`) + shared shell/hooks. The timeline is not a view — it's a resizable bottom drawer inside the graph (`timeline-strip.tsx`; sticky "No date" drawer at its left, event bubbles drag between drawer and session columns to re-pin them). Entity pages embed collapsible connected-entity sections with in-place editing (`connected-entities.tsx`). Notes/Description use a CodeMirror live-preview field (`markdown-field.tsx`: rendered links/bold/quotes/bullets/hr, raw at the cursor, [[ pairing + completion) |
| `src/graph/` | Graph-only logic: layered layout (timeline rows + per-type global layers), orthogonal edge routing (trunk lanes/bands in `routing.ts`; every endpoint attaches via diagonal fans with per-side capacity), connections side panel |
| `scripts/deploy.mjs` | Builds are copied to the test vault with `pnpm run deploy` |
| `docs/ARCHITECTURE.md` | Data flow, relationship model, calendar abstraction, design tradeoffs |
| `ROADMAP.md` | Feature checklist with code locations |

## Key architectural decisions

- **Storage**: markdown files + YAML frontmatter are the source of truth; one entity per
  `.md` file, native `[[wikilinks]]` so Obsidian's own backlinks keep working.
- **Projects are .loom files**: any folder holding a `<Name>.loom` file (JSON: per-project
  config — date format, custom calendar) is a project. The .loom file is the visible
  file-explorer entry point (registered extension, like .canvas/.base) and opens the
  React home view. Multiple projects per vault; views carry the project root in state.
- **Index cache**: `LoomIndexer` discovers projects, builds in-memory records from
  `metadataCache` frontmatter, updates incrementally on file events, and persists a
  debug/cold-start JSON snapshot. Indexing has no rendering concerns; views never re-scan files.
- **Link resolution is lazy**: records store unresolved linkpaths; resolution to files
  happens at query time via `metadataCache.getFirstLinkpathDest`, so renames/creations
  can't leave stale resolved paths.
- **Views**: all custom UI is React 18 mounted inside `ItemView`/`FileView` subclasses
  (`LoomReactView` / `LoomFileReactView` bases). Loom-internal clicks open the structured
  entity page view; opening the same .md from the file explorer gives the raw editor.
- **Names**: the user-entered name lives in `loomName` frontmatter (source of truth
  for display); every file name is managed — `<Project> <Type label> <name>`,
  sessions `<Project> Session <date>` (no loomName; they display their date). Editing
  the name renames the file (Obsidian updates links); `aliases` gets the display name
  so native `[[…]]` autocomplete finds notes by it. Plugin-written links always
  target the file basename (`linkTargetOf`); every picker searches/labels by display
  name. A startup migration (`LoomIndexer.migrateFiles`) converts old files.
- **Frontmatter keys are all loom-prefixed** (`FM` registry in types.ts: `loomType`,
  `loomName`, `loomDate`, `loomRelationships`, `loomSessionNotes`, `loomMembers`, …).
  Reads fall back to legacy un-prefixed spellings; writes go through `src/fm.ts`
  helpers which clean legacy keys up; the startup migration rewrites old notes.
  Nested keys inside list entries stay unprefixed; `aliases` is deliberately native.
- **Events section (entity pages)**: character/item/faction/location pages show the
  events they take part in instead of their own session notes. A note's `involved`
  list surfaces the event on each involved entity's page; a note's `places` list (the
  event's per-note location, stored on the event, replacing the old event-level
  `location` relationship) surfaces it on that location **and every ancestor location**
  (city ⊇ tavern ⊇ secret room). Removing the page's own entity from a note warns first
  ("… this event won't be displayed here anymore"). Only event/quest pages keep an
  editable own-`sessionNotes` section; "+ Add an event" pre-links the page's entity
  (`defaultInvolved` / `defaultPlace`).
- **Connections**: typed frontmatter relationships + `sessionNotes` (session-pinned
  note entries `{session, text, involved, places}`; the picked session becomes a
  `session note` connection, `involved`→`involved`, event/quest `places`→`location`) + `parentLocation` on locations (sublocation parent — dedicated field
  with its own page/list/graph UI, never a relationship; typed `sublocation`
  connection) + `members` on factions (member characters, plain links or
  `{ character, role, location }` objects; typed `member` connection; mirrored on
  character pages as an editable "Faction(s)" section — role / faction / optional
  location rows plus "+ Add faction" — writing the faction's file) + plain
  `[[links]]` anywhere in a note (relType `link`), all resolved
  bidirectionally; graph edges undirected. There is no dedicated event→session field
  (`linkedSession` was removed — relationships already cover it; old keys in existing
  notes still connect as plain frontmatter links). Entity tags
  live in `loomTags` (legacy `pluginTags` still read); the tag vocabulary is hardcoded
  (`ENTITY_TAGS` in types.ts), not user-configurable.
- **Hidden connections**: links under the `deathSession` and `sublocationOrder` keys
  never become connections or graph edges. `attendance` is hidden from the generic
  link pass but emits typed `attendance` connections (a ticked PC connects to the
  session). Sessions list attending PCs (`PC` tag); PCs carry `alive` and
  `deathSession` — sessions dated after a PC's death session stop offering them.
- **Dates**: `LoomDate` = raw string + packed sortable number + y/m/d + calendar id.
  Sessions always Gregorian; other entities use the project calendar (custom in-game
  months when enabled). Formatting is per-project config, never JS `Date`.
- **Manual order**: events and quests carry a `loomSeq` frontmatter stamp (falling
  back to file ctime). The timeline event bubbles and the session page's session-note
  hub rows (event + quest groups) both sort by it and both drag-reorder by re-stamping
  the whole list, so a reorder in either place shows in the other. (The old
  settings-based `timelineManualOrder` is superseded and unused.)
- **Entity chips**: every entity reference rendered as a tag/pill goes through
  `EntityChip` (`src/views/common.tsx`) — node-colored, clickable name, optional ✕.
  Never hand-roll chip spans; in non-React surfaces (modals) replicate its exact
  markup (`loom-chip loom-session-chip loom-entity-chip` + inline node colors, see
  `CreateEntityModal.renderChip`). Session chips are special-sized in some spots via
  container CSS but always carry the session node color.

## Constraints

- **No Obsidian 1.13-only APIs** (`setDestructive`, `getSettingDefinitions`, …): 1.13 is
  Catalyst-only early access. `minAppVersion` stays 1.7.2 until 1.13 ships publicly.
  The typings package is 1.13, so a symbol existing in obsidian.d.ts does not mean it's
  safe to call — check when it was introduced.

## Workflow

- `pnpm run build` — typecheck + production bundle; `pnpm run lint` — Obsidian's ESLint
  rules (treat errors as build failures); `pnpm run deploy` — build + copy the three
  release files (`main.js`, `manifest.json`, `styles.css`) into both test vaults:
  `~/Dropbox/Obsidian/Test Vault` and `~/Dropbox/Obsidian/Main vault` (the user's real
  vault — real campaign data lives there, so writes must stay conservative). Deploy at
  every ready-to-test state.
- Releases ship exactly those three files, built by `.github/workflows/release.yml` when
  a GitHub release is created; `main.js` is never committed.

See `ROADMAP.md` for what's built vs. planned and `docs/ARCHITECTURE.md` for the deeper
"why" behind the design.
