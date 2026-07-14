# Architecture

The deeper "why" behind Loom Loom's design. `CLAUDE.md` has the short version and the
file map; this file explains the data flow and the tradeoffs, so future sessions don't
reconstruct reasoning from diffs.

## Projects

A project is any folder containing a `<Name>.loom` file. The .loom file serves three
purposes at once: it's the **visible entry point** in Obsidian's file explorer
(registered via `registerExtensions`, like `.canvas`/`.base` — clicking it opens the
React home view as a `FileView`), it **names the project** (its basename), and it
**stores per-project config** as JSON (date format, custom calendar). Multiple projects
coexist per vault; every list/timeline/graph view carries its project root in view
state, and commands resolve a project via single-project fallback or a fuzzy picker.
Pre-.loom installs are migrated on load: the legacy `projectRoot` setting gets a .loom
file scaffolded into it once, then the setting is cleared.

## Data flow

```
.md files (YAML frontmatter, source of truth)      <Name>.loom (project config JSON)
        │  Obsidian metadataCache (parses YAML)            │ cachedRead + JSON.parse
        ▼                                                  ▼
LoomIndexer (src/indexer.ts) — Map<path, EntityRecord> + Map<loomPath, ProjectDef>
        │  'changed' event + version counter        │ debounced JSON snapshot
        ▼                                           ▼
React views (useIndexVersion hook)         <plugin dir>/index-cache.json
```

- **Build**: on `workspace.onLayoutReady`, the indexer finds all .loom files, then walks
  each project root (`Vault.recurseChildren`) and parses each markdown file's
  frontmatter from `metadataCache.getFileCache()` — no YAML parsing of our own.
- **Incremental updates**: `metadataCache.on('changed')` re-indexes one file;
  `vault.on('delete')` drops it; `vault.on('rename')` triggers a full rebuild because a
  rename can retarget wikilink resolution anywhere in the project, and renames are rare
  enough that a rebuild is cheaper than being clever.
- **Separation rule**: indexing code has zero rendering concerns; views query the indexer
  and subscribe via `useIndexVersion` (a `useSyncExternalStore` over the indexer's
  `changed` event). Views never re-derive relationships by scanning files.
- **Persistence**: the JSON snapshot exists for debugging and potential fast cold starts.
  It is *never* read back as a source of truth within a session — the in-memory index is
  authoritative and always freshly derivable. It's written with `vault.adapter` because
  the Vault API can't write into the plugin's config directory.

## Relationship model

Declared one-directionally in frontmatter, matching Obsidian's own outgoing-link model:

```yaml
relationships:
  - type: ally
    target: "[[Sam]]"
```

- **Typed edges**: `type` is freeform text; `related` is the fallback when missing.
- **Bidirectional visibility**: `getOutgoing(path)` resolves the declarations on a note;
  `getIncoming(path)` is a lazily built reverse map over all outgoing edges (invalidated
  on every index change, rebuilt on first query). `getConnections` merges both and
  dedupes, because which side declared an edge never matters for display — the graph
  treats all edges as undirected.
- **Lazy link resolution** (important non-obvious choice): records store *unresolved*
  linkpaths, not resolved file paths. Resolution happens at query time via
  `metadataCache.getFirstLinkpathDest(linkpath, sourcePath)`. If we resolved at index
  time, creating or renaming a target note elsewhere in the vault would leave stale
  resolved paths in every record pointing at it; lazily resolving makes that class of
  bug impossible at negligible per-query cost.
- `linkedSession` on events uses the same mechanism and contributes an edge of type
  `session`.
- **Native links count too**: any plain `[[wikilink]]` in a note's body or frontmatter
  (from `metadataCache` `links`/`frontmatterLinks`) that lands on another indexed entity
  becomes a connection of type `link`. Users shouldn't need the typed syntax just to get
  a graph edge; typed relationships take precedence when both point at the same target.

## Names

Display name = file basename, full stop. There is no `name` frontmatter field: an
earlier version had one and it silently diverged from the file name on rename. The
entity page's Name field *renames the file* (via `fileManager.renameFile`, so links
update). Session file names are managed — `<Project name> Session <date>` — and never
shown inside the plugin; sessions display their formatted date everywhere (timeline,
graph, lists, side panel).

## Calendar & date formats (src/calendar.ts)

`LoomDate` = `{ raw, sortKey, year, month, day, calendar }`. The sort key packs
`y*10000 + m*100 + d`, which is monotonic for *any* calendar — so ordering never
depends on JS `Date` or on month lengths, and a custom calendar needs no epoch.

Per-project config (in the .loom file) holds a display format and an optional custom
in-game calendar (month count, month names with optional short forms; unnamed months
default to "Month N"). Rules:

- **Sessions always parse and display as Gregorian** — they track real-life play dates.
  Events (and any other dated entity) use the project calendar when the custom one is
  enabled. Each `LoomDate` carries its `calendar` id so the formatter picks the right
  month names.
- Display formats are a fixed set (`MMM Do, YYYY` … `DD.MM`); the short-month variants
  are only offered when short names exist (Gregorian always, custom only when enabled).
- The editor UI (src/timeline-settings.ts) is embedded in the plugin settings tab's
  Graph tab (with a project picker when the vault holds several projects) and writes
  JSON back to the .loom file; the indexer's `modify` watcher picks that up and
  rebuilds, so a calendar change reflows everything.

## Shared chronological columns

`buildColumns` (src/columns.ts) is the single source of horizontal ordering for both the
timeline view and the graph view — "same ordering by construction" rather than two
implementations that could drift. A column is anchored by a session (or by an event with
no linked session); events linked to a session stack beneath it *regardless of their own
date*, matching the intended nested-bubble presentation.

## Graph layout (src/graph/layout.ts)

Three fixed layers, custom-built because Obsidian's force-directed graph can't express
this:

1. **Sessions** at a fixed y, x from column order.
2. **Events** beneath their column's anchor, stacked with a fixed dy.
3. **Globals** (characters/locations/factions/items) on one fixed lower axis. Desired x
   is the barycenter of their connections' x positions (two passes so global↔global
   edges exert pull once initial positions exist); then a left-to-right min-spacing sweep
   resolves overlaps. They never leave their row — that's the point: no vertical chaos.

Interaction (src/views/graph-view.tsx):

- **Drag + spring-back**: displacements live in a ref map keyed by node id; a rAF loop
  integrates a damped spring toward the home position. React re-renders are driven by a
  tick counter only while something is moving, so an idle graph costs nothing.
- **Click-to-dim**: selection dims everything *not* connected (contrast, not highlight
  color). Click vs. drag is disambiguated by a 4px slop.
- **Culling**: nodes whose home x falls outside the scrolled viewport (±250px) aren't
  rendered; edges render if either endpoint is visible.

## View pattern

Two React bases in src/views/react-view.ts: `LoomReactView` (`ItemView`; list, timeline,
graph) and `LoomFileReactView` (`FileView`; home over .loom, entity page over .md). Both
mount a React 18 root in `contentEl` on open and unmount on close (the obsidian-kanban
pattern). View-level state that must survive workspace serialization — entity type,
project root, backing file — goes through `getState`/`setState`; everything else is
component state. Navigation between plugin views reuses the same leaf
(`leaf.setViewState`) so Obsidian's back/forward history works; opening an entity always
uses a new tab so the user doesn't lose the view they navigated from.

**Entity pages**: every loom-internal click opens `VIEW_ENTITY` — a structured form
(name/date/description/tags/role/linked session/relationships/notes) over the same .md
file. Registering a second view type for `md` does *not* hijack the default editor:
opening the file from the file explorer still yields normal markdown, which is exactly
the intended split ("app inside Obsidian" vs. plain notes). Field drafts are seeded once
per file (component keyed by path) so index updates triggered by the page's own saves
never clobber in-progress typing; frontmatter writes go through
`fileManager.processFrontMatter`, body writes through `vault.process` preserving the
frontmatter block.

## Tags

`pluginTags` frontmatter field, deliberately namespaced away from Obsidian's `#tags` so
the two systems can't collide. The vocabulary per entity type lives in settings
(defaults: characters get PC/NPC/Cast, everything else empty) because it will grow.
`role` on characters is a separate freeform field per the brief — the creation modal
fills `pluginTags` only.
