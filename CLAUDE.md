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
| `src/types.ts` | Entity types + metadata, record/connection/timeline/date shapes, `FM` frontmatter-key registry (+ legacy spellings; incl. loom-owned `loomCreated`/`loomModified` timestamps — no legacy fallback so a foreign bare `created`/`modified` is never adopted; `parseTimestamp` reads ISO/epoch, `formatTimestamp` writes Obsidian's Date & time property format `YYYY-MM-DDTHH:mm:ss` local, registered as `datetime` in `main.ts`), view type IDs |
| `src/fm.ts` | Shared frontmatter read/write helpers: case-insensitive reads with legacy-key fallback, loom-key writes that clean stale spellings |
| `src/naming.ts` | Managed file-name construction (`<Project> <Type label> <name>`), dependency-free for indexer + project use |
| `src/settings.ts` | Global settings: text size, tag vocabulary, entity colors + per-type node sizes (`nodeSizes`, `NODE_SIZE_MIN`/`MAX`), collapse threshold, global layer order; per-project saved graph views (`SavedGraphView`/`graphViews` — filter + focus + pin snapshots); tabbed settings UI (General/Entities/Graph, per-project timeline settings under Graph). Entities tab order: "Entities colors and node sizes" (Group color first — no size; then each entity type with a color picker + node-size slider, quest tag colors nested under Quest with no size since tags aren't nodes), then an "Other colors" section (Maps color `mapsColor` + the Loom button colors "Loom original" / custom bg+icon), then "Quests" (`sessionResolvedQuests`) and "Locations". Graph tab is grouped into "Main graph" / "Right side panel" headings (+ the untouched per-project "Timeline" section), with a "Restore defaults" button; the timeline drag-confirm toggle lives on the timeline drawer bar itself, not here |
| `src/indexer.ts` | Index cache: project discovery (.loom files), frontmatter → in-memory records, vault event handling, connection queries (incl. native links), JSON snapshot persistence. Records' `created`/`modified` prefer the loom-managed `loomCreated`/`loomModified` frontmatter (fallback: file ctime/mtime); the single `metadataCache.on('changed')` handler re-stamps `loomModified` on every edit (`stampModified`, per-path `lastStamp` loop-guard that migration/reconcile writes pre-seed so their echoes don't stamp); the startup migration seeds both timestamps from the stats absent-only |
| `src/calendar.ts` | Date model: parsing (Gregorian + custom in-game calendars), display formats, per-project `ProjectConfig` (de)serialization |
| `src/columns.ts` | Chronological column layout shared by timeline and graph (sessions anchor columns, session-connected events stack beneath) |
| `src/project.ts` | Project scaffolding (.loom + folders), entity creation (managed session file names), setup/create/pick modals |
| `src/timeline-settings.ts` | Per-project timeline settings editor (date format + custom calendar), embedded in the settings tab's Graph tab, writes to the .loom file |
| `src/views/` | React views: home (FileView over .loom; wheel layout — Loom button centered, circular node-colored satellite buttons on a ring, Group first at 12 o'clock then entity types clockwise, evenly redistributed by count; icon = full node color, background/border the same hue diluted via color-mix for readability), entity page (FileView over .md), list (right-click context menu on every row: Rename / numbered Copy / Add alias / Add relationship / danger Delete — general block, separator, then per-type commands incl. tag/status/attendance toggles and add-X pickers; asc/desc sort toggle; nested lists get one cycling collapse-all/expand-all icon button + a vertical nesting rail; quest list has a status filter, colored tag chips, and a list/cards toggle reusing the session-page card grid; event list filters by involved entity — group snapshots count — and by location incl. descendants), graph, the virtual Group's page (`group-view.tsx`: faction-page layout, editable name → .loom `groupName`, Alive/Inactive/Dead member sub-sections, events hub with name+note search and multi-PC chip filter, read-only rows with clickable names and rendered note text; first rail entry, `circle-star` icon), focused per-session mini graph (`mini-graph.tsx`) + shared shell/hooks. The timeline is not a view — it's a resizable bottom drawer inside the graph (`timeline-strip.tsx`; sticky "No date" drawer at its left, event bubbles drag between drawer and session columns to re-pin them). Entity pages embed collapsible connected-entity sections with in-place editing (`connected-entities.tsx`). Notes/Description use a CodeMirror live-preview field (`markdown-field.tsx`: rendered links/bold/quotes/bullets/hr, raw at the cursor, [[ pairing + completion; tab-indented bullets hide their raw indent and draw a vertical nesting rail per ancestor level; Ctrl/Cmd+B/I/U toggle `**`/`*`/`<u>` through one guarded `applyFormatting` (a `WeakSet` on the physical event prevents a double toggle) called from BOTH the focused-field app Scope — the only layer that can pre-empt Obsidian's global Ctrl+B/I — and a CM `keydown` handler that catches keys Obsidian doesn't grab (Ctrl+U); `readOnly` keeps the field contenteditable — only `EditorState.readOnly`, no editing extensions — so native selection/copy work, never reveals raw under the selection, and a plain-DOM `copy` handler clipboards the display text instead of the markdown) |
| `src/graph/` | Graph-only logic: layered layout (timeline rows + per-type global layers), orthogonal edge routing (trunk lanes/bands in `routing.ts`; every endpoint attaches via diagonal fans with per-side capacity), connections side panel. Events stack under sessions in `loomSeq` order via a shared longest-path grid (an event's row = one below the deepest event preceding it in any session's list, so shared events align across columns); quests stack vertically (sub-rows) under their session instead of spreading horizontally; a `leftPad` (widest-row overhang ÷ 2) pushes the timeline right so wide global rows center rather than left-align; `computeGraphLayout`/`placeNodes`/`buildColumns` take an optional `restrictTo` set for the "separate graph" filter. The side panel (`side-panel.tsx`) renders the description through the read-only `MarkdownField` and collapses reciprocal typed relationships to what the selected node declares (an outgoing edge to a target hides that target's incoming ones). **Graph interaction (`graph-view.tsx`)**: left-click selects, left-drag moves, left press-and-hold (`HOLD_MS`) zoom-focuses, double-click opens the page, right-click toggles a **pin** (locks the node at a fixed WORLD position via `pinned: id→{wx,wy}`, overriding the force layout; it scrolls with the camera so normal fan routing applies; off-screen pinned nodes get a viewport-edge indicator that pans to them on click; right-click mid-drag pins the dragged node via a capture-phase `contextmenu` listener; unpin springs it home). Dragging a **connected** node just springs it back — placement is pure pull-forces, no reordering; only **unconnected** nodes persist a dropped x/y (`isFreePlacement`, no layer clamp). Node drags run on window pointer listeners (no `setPointerCapture`), and there is NO live relayout during a drag (the full layout runs once on drop). **Perf**: nodes/edges render through memoized `GraphEdge`/`GraphNode` (primitive/position props) and `TimelineStrip`/`GraphSidePanel` are memoized too, so a drag/spring frame only re-renders the moved node + its incident edges, not the whole graph — scales with connection count. **Saved views** (header bookmark popover): named `SavedGraphView` snapshots of the filter + focus-entity restriction + pins (`settings.graphViews`); apply restores all three in one shot, plus update-to-current/rename/delete/save-current. **Animate graph** ("Start time-lapse animation", header play/stop): replays node-creation history — nodes grow in along a smooth ease-out curve (`animGrow`, no bounce) and glide floatily toward their target (`ANIM_FLOAT`, momentum-free ease, no spring) in `loomCreated` order while the force layout re-runs on the growing revealed subset (connections form live, positions shift with the forces) and the camera re-frames every revealed node each batch; duration scales with node count (1.8–15s) with an eased reveal curve (`animEase`, ease-in-out + linear so ends don't drag), isolated nodes bind near their nearest node mid-run (`bindIsolated`, incl. a separation pass so bound nodes don't overlap) and return to their real home on the final batch (settles to the exact normal `layout`, no end jump); edges draw in from both ends to meet in the center once both endpoints have grown (`GraphEdge` `draw` prop, centered `stroke-dasharray` on a `pathLength=100` path); node interaction suspended during play (`AnimState`/`startAnimation`/`animStep`, `scale` prop on `GraphNode`) |
| `src/views/map-view.tsx` | **Maps** (`VIEW_MAP`, `map` icon): a spatial drawing canvas per project (pan/zoom SVG). Zones are polygons drawn by clicking vertices (close by clicking the first vertex, ≥3 pts, live dashed fill preview); **left-click** a zone selects it for vertex editing (handles when unlocked); **right-click** opens an icon-only context panel anchored **above the cursor** (menus are right-click only, close on left-click/Esc, no close button; icon items are `.loom-view .loom-map-icon-btn` — bare icon, hover-tint). `ZonePanel`: grip-move; an inline location **`SearchableSelect`** that becomes the location name + a square-pen "change" once associated (node lands at the menu-open point); a **palette** icon popping a Color+Opacity(+reset) sub-panel; lock; delete. A node is **draggable within its zone** (`clampToPolygon`) and has its own right-click menu (size S/M/L/XL, open location page, lock-in-place, remove association); **left-clicking a node selects its zone** just like clicking the zone. Outline color is a `darker()` shade of the fill. **Editing zone vertices**: select a zone → **double-click its outline** inserts a vertex (`insertVertexAt`, nearest segment), **right-click a vertex handle** deletes it (polygons keep ≥3, roads keep ≥2). **Delete/Backspace** removes the selected zone (guarded against input focus). Zones associate a **main (top-level) location only** (`locationOptions` filters `parentLocation === null`); the entity-page "Turn to a sublocation" warns + deletes the zone from the map JSON if the location has one. Vertex insertion is handled at the **SVG level** (`onCanvasDoubleClick` + `hitZone` + proximity check), not per-path, so it survives the drag machinery. **Undo/redo** is map-local (`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`, guarded against field focus): a `history` ref of `zones` snapshots — discrete actions call `snapshot()` (before the change), continuous gestures (drags + palette sliders) use `beginPending()`/`commitPending()` (snapshot at gesture start, pushed at the global `pointerup` only if the state actually changed), capped at `HISTORY_CAP`. **Roads** (`kind: 'road'`, `route` icon) **connect two locations** (they don't have their own location/node). Drawing: pick the **start location** (first click must land on a location zone, else a Notice), click **waypoints** (`points`), then click a **second location** to finish (`roadDraft` holds the start; `finishRoad` writes `startLoc`/`endLoc`; no double-click/Enter finish; right-click while drawing Notices "click a location to finish", Esc cancels). A road is **its own editable zone** — `points` holds the **full centerline** (including its endpoints); `startLoc`/`endLoc` only drive the VISUAL. Rendered along `roadCenterline(road, squish)`: in **regular view** the first/last segment is **clipped to the start/end zone edge** (`boundaryExit`) so the road doesn't overlap/hide behind the zone; in **node view** the ends anchor to the **main-location nodes** (a sublocation collapses into its main location — `mainLocNode` walks up `parentLocation`); the two ends lerp by `squish` (middle points unchanged). Width-stroked (outline+fill, round joins), `DEFAULT_ROAD_WIDTH`; hit-tested via the centerline (`hitZone` uses `roadCenterline`). **All `points` are editable** — drag/right-click-delete (keeps ≥2), and **double-click inserts a waypoint** anywhere. **Vertex handles render in a separate top layer** (`renderHandles` + `{zones.map(renderHandles)}`) above every zone/road body, so a road over a location zone can't cover or block clicks on that zone's handles. A **Width** slider + revert (roads only) in the palette. A road is **still a full zone** so it can also carry **its own `location`** (its own node, drawn along the road) via the same location picker as a polygon zone — separate from its start/end endpoints (which are drawing/visual-only; a road without its own location shows no node/placeholder). **Right-click cancels** an in-progress road or polygon draw (Esc too). Polygon draw preview: the **fill follows the cursor in real time** (closes through it) while the **dashed outline stays open** (no closing edge back to the first vertex) so the incomplete edge stands out. Hovering any zone outline / road body toggles a `loom-map-edge-hover` class (pointer cursor on the svg, matching vertex handles). Palette reset controls (opacity, width) are bare circled-arrow icons (`loom-map-reset`), and the node-size `<select>` + color swatch use `appearance:none` so they don't pick up the theme's grey `<select>`/round-swatch chrome. **Rectangle tool** ("Draw a rectangle", `square` icon): press-drag defines an axis-aligned 4-vertex zone (`finishRect`, live `rectPreview`). **Node double-click opens the location page**, **middle-click opens it in a new tab** (`openLocation(target, newTab)`). The location picker won't re-offer a **location already placed on the active map** (`usedLocations`). **Vertex alignment**: holding **Ctrl while dragging a vertex** locks it to the dominant axis (X or Y, from its origin). **Marquee multi-select**: **Ctrl+drag on empty space** boxes vertices (`selectVertsInBox` → `selectedVerts`, keys `zoneId:index`); dragging any selected vertex moves the whole group together (handles show for every zone with selected verts; Esc clears). Right-click empty space opens an icon-only global menu (Draw zone; Draw rectangle; Draw road; Import image + Waypoints are stubs). No header draw button — all via context menus. **Multiple map pages per project**: `MapsPanel` is a left navigator that slides out on hover and **pins open** (`loom-map-panel`/`-pinned`, edge tab), has its own **name search**, a **new-map** button, inline **rename** (double-click), right-click Menu (New map inside / Rename / Delete-with-confirm), and **drag-to-nest** (folder-like `parentId`, cycle-guarded). Pages carry `id`/`name`/`parentId`/`order`/`zones`; the active page's zones are the live `zones` state, others live in `pages`. **Storage is `Maps/<Project> Maps.json`** (`MapsFile` = `{version, activeId, maps: MapPage[]}`; `parseMapsFile`), auto-migrating the legacy single-map `Maps/<Project> Map.json` (`{version, zones}`) into a one-page file on first load. The top-left controls moved to top-**right** so the panel never covers them. The panel **stays open while a right-click Menu is up or while renaming** (`forceOpen`); a new map is created with an **empty name that drops straight into an inline rename** (cursor focused) — blank/Esc auto-names the lowest free **"New map N"** (frees when renamed away), and a duplicate name prompts a `ConfirmModal` offering a de-duplicated `"<name> 2"`. New maps open at **regular zoom** centered. The **three draw tools are one `square-dashed` button** that opens an Obsidian Menu (Rectangle / Polygon / Road — "Polygon" = the click-to-place tool, deliberately not called "lasso" since it isn't freeform). **Doors** (`MapZone.doors: {page,x,y}[]`, `door-open` icon in `ZonePanel` → a popover with a map-page `SearchableSelect` excluding the active page + a list of current doors): each door draws a **door-open icon marker + the target page's name** inside the zone (draggable, clamped to the zone), **double-click opens the target page**, and clicking a door in the list opens it too (`switchMap`). Doors **squish into the zone's node and disappear in node view** (same `squishTransform`/opacity as polygon zones). Zones also carry **item pins** (`MapZone.itemPins`, `gem` icon popover → drop items, drawn as gem markers, double-click opens the item) and **sublocation nodes** (`MapZone.subPins`, `list` icon popover with a search + **Title | Node** checkbox list over **all descendant** sublocations, capped at 10 with a `…`; tick to show a location-colored node inside the zone; **drag a row onto the map** to place its node precisely — a ghost preview follows the cursor, `placeSubPin` on drop). Sublocation nodes shrink **per nesting level** (`SUB_NODE_SCALE^depth`, floored at `MIN_SUB_NODE_SIZE` — `subPinRadius`). Item pins and sublocation nodes are draggable (clamped to the zone), shift with a zone-move, and squish like doors — via the shared `door`/`itempin`/`subpin` drag kinds. The zone menu is grouped `[grip][location] │ [subs][doors][items] │ [size][style] │ [lock] │ [delete]`, and **only one popover opens at a time** (`openPanel` state). Each **main node carries an asterisk glyph** (`loom-map-node-star`) so it stands out; **selecting a zone no longer highlights its node** — the node highlight (`selectedNode`, `loom-map-node-sel`) only appears when the node itself is left-clicked. **Left-clicking a main node opens a sublocation graph IN the map** (`SubGraphLayer`, `subGraph` state): a top-down tree of that location's sublocations (nested, sized by depth), **screen-anchored at the node** so **pan/zoom keep working**; the rest of the map **dims via opacity** (the camera `<g>` drops to 0.12) rather than a scrim; the layer SVG is `pointer-events:none` except the tree nodes. Double-click a sublocation node opens it; **click the root node again (or Esc) hides** it. Node press = drag to move, or click (no move) to select the node + open the graph. (Pending: layering the location's other connected entities into this graph like the main graph.) The **camera is remembered per map page** (`settings.mapCameras` keyed `${root}::${pageId}`, `restoreCamera` on switch/load, previous page's camera snapshotted synchronously before a switch). **Phase-2 pending**: sublocation & item node panels (Title|Node), sublocation wheel on node click, background-image import into `Maps/Images`, the waypoints (location-graph) mode, locked-image edge behavior. See ROADMAP "Guided tutorial" for the planned onboarding overlay |
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
  sessions `<Project> Session <date>` (no loomName; they display their date),
  **sublocations `<Project> Sublocation of <parent name> — <name>`** (embeds the
  parent's name so same-named places under different parents stay distinct; setting/
  clearing `parentLocation` renames the file, migration reconciles the whole tree by
  precomputing parent names). Editing the name renames the file (Obsidian updates
  links); `aliases` gets the display name so native `[[…]]` autocomplete finds notes
  by it. Plugin-written links always target the file basename (`linkTargetOf`); every
  picker searches/labels by display name — sublocations label as `Tavern, City A`
  (`locationLabel` in common.tsx). A startup migration (`LoomIndexer.migrateFiles`)
  converts old files.
- **Frontmatter keys are all loom-prefixed** (`FM` registry in types.ts: `loomType`,
  `loomName`, `loomDate`, `loomRelationships`, `loomSessionNotes`, `loomMembers`, …).
  Reads fall back to legacy un-prefixed spellings; writes go through `src/fm.ts`
  helpers which clean legacy keys up; the startup migration rewrites old notes.
  Nested keys inside list entries stay unprefixed; `aliases` is deliberately native.
- **Regions** (`region` entity type): a grouping layer *above* main locations — a way
  to gather locations under a territory without turning them into sublocations. A location
  carries a dedicated `region` field (`FM.region`, "Part of region" on every location page
  right after "Sublocation of"; "Not specified" when empty) that emits a typed `region`
  connection (like `parentLocation`→`sublocation`); `regionOrder` (hidden links) orders a
  region's members. The **region page** reuses the location page shell but shows a
  **Locations** section (its member locations — add existing / create new / remove) instead
  of Sublocations, and **inherits events** from its members via the same `places`
  ancestor-propagation, one layer up (`placeInThisRegion`: a place counts if it or any
  ancestor is a member). Region color is **not configurable** — always a darker shade of the
  location color (`syncRegionColor`/`darkenHex`, run in `mergeSettings` and on any
  location-color change); regions reuse `EntityChip`. Regions are in `GLOBAL_TYPES` (graph
  nodes) but **not** map nodes and are never offered as a map zone's location. The location
  **list groups locations under their Region** (main location under its region header,
  sublocations still under their parent; synthetic "Unspecified Region" for none; flat until
  a region is in use — `UNSPEC_REGION` in list-view). **On the map (node view only)** a region
  draws an auto-computed **padded convex hull** around each *cluster* of its locations' **zones**
  (the actual land areas, hulling every zone vertex — not the collapsed node points): the region's
  zones are clustered by proximity (union-find, threshold = 2.5× the map's median
  nearest-neighbour spacing) so far-apart members wrap **separately** — one hull per cluster,
  labelled, double-click opens the region page (`regionClusters` + `regionHull`/`convexHull` in
  map-view; color = darker location, fades in with the squish).
- **Events section (entity pages)**: character/item/faction/location/**quest** pages
  show the events they take part in instead of their own session notes. A note's
  `involved` list surfaces the event on each involved entity's page (quests included —
  a quest is `involved` in the events that advance it; **locations may be involved too**
  — a place discussed/featured in the event, distinct from where it happened); a note's
  `places` list (the event's per-note location, stored on the event, replacing the old
  event-level `location` relationship) surfaces it on that location **and every ancestor
  location** (city ⊇ tavern ⊇ secret room) — the location page's Events section reads
  `places` only, so an involved-but-not-placed location isn't listed there. Involve
  pickers (page editor + hub rows + create modal) offer every non-session/non-event
  type, locations included. Removing the page's own entity from a note warns first
  ("… this event won't be displayed here anymore"). Only **event** pages keep an
  editable own-`sessionNotes` section (quests no longer author their own notes — the
  session-page hub is labelled **Events** and never shows a Quests subsection). Adding
  an event is a `SearchableSelect`: picking an existing event involves this page's
  entity in that event's first note (`places` for a location page, else `involved`),
  and "+ Create new event" opens the modal pre-linking the page's entity
  (`defaultInvolved` / `defaultPlace`). Creating a quest from an event note's Involve
  search prefills the quest's "Received in session" with that note's session
  (`CreateEntityModal` `receivedSession` — sets `questReceived` without pinning a note).
- **Quest page specifics**: the **Reward** field is a `MarkdownField` (links, multiple
  lines — a reward `[[item]]` connects in the graph as a plain link). An **Objectives**
  section (after Tags, `loomObjectives` frontmatter: ordered `{ name, finishedOn? }`
  entries) splits into **Active** (no `finishedOn`) and **Resolved** (a `finishedOn`
  session, picked like "Received in session"); "+ Add objective" appends a row, active
  rows drag-reorder (a drop rewrites the stored list as reordered-actives then the
  resolved). `finishedOn` links are hidden (no graph edge — `loomobjectives` in
  `HIDDEN_LINK_KEYS`).
- **Session-page Quests section**: three collapsible groups computed as of the session's
  date — **Active**, **Resolved this session** (`questOutcomeSession` is this session),
  **Resolved previously** (resolved in an earlier session, capped by
  `settings.sessionResolvedQuests` — 3/6/9/12/All, default 6, newest by outcome date;
  the count reads "N of total" when capped). Only Active reorders (`loomSeq`).
- **Section order / Events last**: the **Events** hub is big, so it is the last
  content section on every entity page — only **Relationships** and **Connected
  entities** follow it. It's extracted into one `eventsSection` node rendered in a
  SINGLE unconditional spot at the bottom (null on pages that don't show events, e.g.
  event/session), so the page-specific sections above it (item-holder Characters/
  Locations on item pages; Factions → Items → Sublocations on location pages) all come
  first. Per-page differences that can't be a single global order live inline above
  Notes: a location page is Notes → Factions → Items → Sublocations → Events, while a
  character page puts its Faction(s) membership section and the shared `itemsSection`
  ABOVE Notes (Items directly under Faction(s)). The Factions section's members hang
  off a vertical nesting rail (shared `loom-event-nest`) under each faction chip.
- **Items section (character/location pages)**: an ordered `loomItems`
  frontmatter list of item links on the character/location. **A location also has an "Items in
  sublocations" subsection** (`inheritedGroups`) — every descendant sublocation's
  items, **grouped under the sublocation** on a nesting rail (Factions-section layout,
  alphabetical, read-only chips); persistent (shown even if the same item is also on
  this location directly). Each row edits the item
  entity in place (name renames the item file, description writes its `loomDescription`);
  drag-reordering rewrites the page's `loomItems` order (per-page). Adding searches
  existing items (+ "Create new item"). Each row's `<` drawer holds Delete (trashes the
  item note) + Remove (just unlinks it from this page); on a character page a `layers-2`
  button (left of Delete) makes a character-specific copy. The links are visible
  (non-hidden) so items also connect in the graph.
- **Item page reverse sections**: an item page shows **Characters** (after Notes,
  above Events) and **Locations** (after Characters) — the holders that carry this item via their
  `loomItems`. Chips (persistent entities, not editable), an "Add to character/location…"
  search that writes the item into the picked holder's `loomItems`, and a remove ✕ that
  unlinks it. Direct reverse query only (a holder that swapped in a character-specific
  copy no longer credits the original).
- **Character-specific item copies**: the `layers-2` button on a character-page item row
  (standalone next to the row's open arrow, not in the delete/remove drawer; tooltip
  "Replace with a character specific copy of this item") creates a copy item note
  `<Project> Item <original> — <character>`, replaces the original in that character's
  `loomItems` with it, and opens it. The copy carries `loomItemOrigin` (visible link →
  graph edge to the original) + `loomItemOwner` (hidden link — the character already
  connects via `loomItems`); its `loomName`/`aliases` are the `<original> [<character>]`
  label (each original alias also suffixed `[character]`), so pickers and native `[[…]]`
  search show it that way. **The copy note is written with a raw frontmatter string, not
  `processFrontMatter`, so aliases stay quoted (`["Excalibur [Arthur]"]`) — an unquoted
  `[…]` suffix reads as a YAML flow sequence and breaks Obsidian's alias mechanic.**
  `managedEntityFileName` takes an `ownerName` for the `— <owner>` file name; the startup
  migration reconciles copy names from the resolved original + owner. In a character's
  Items row a copy shows read-only (no rename, no re-copy). The entity list nests copies
  under their original (same machinery as sublocations, via `itemOrigin`) with the owner
  as an `EntityChip`. A copy's page has no editable name (original chip + owner chip
  instead); its Description shows the original until edited, at which point the field
  becomes **Alternative description** (writes the copy's own `loomDescription`) with a
  collapsed **Original description** spoiler (read-only `MarkdownField`, `readOnly` prop);
  clearing the alternative reverts to the original.
- **CreateEntityModal existing-match**: when the searchable Name field (session-page
  event/quest add) matches an existing entity, the primary button flips from "Create" to
  "Add" — submit pins it to the session instead of creating a duplicate.
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
- **Virtual "Group" faction**: entity-connecting pickers (Involve… on note rows,
  faction Members, relationship targets, the create-modal's Involved field) offer a
  file-less "Group" entry (`PC_GROUP_NAME`/`PC_GROUP_VALUE`/`pcGroupStub` in types.ts).
  The party at pick time = `LoomIndexer.getGroupMembers`: PC-tagged AND `alive` AND
  `active` (`loomActive`, a PC-page checkbox next to Alive — untick while a character
  is away from the party, re-tick when they rejoin; new picks skip inactive PCs, old
  snapshots keep them). In **involved pickers** the pick writes a `group` snapshot
  list on the note entry (sibling of `involved`; frozen — later deaths don't rewrite
  history) rendered as ONE faction-colored "Group" chip (✕ clears it), while each
  member still connects individually (relType `involved`, individual graph edges).
  In Members/relationship pickers the pick expands to individual entries immediately
  (a relationship draft row becomes one row per member, same type). No entity named
  "Group" ever exists — it never shows in the entity list or graph, the entry hides
  when a type filter excludes characters/factions or nobody's missing, and creating/
  renaming a real faction to "Group" is blocked with a Notice (reserved name). The
  Group also has its own page (`VIEW_GROUP`, `src/views/group-view.tsx`,
  `circle-star` icon): first entry in the nav rail and on the home wheel, laid out
  like a faction page. Its name is editable — stored as `groupName` in the .loom
  config (`groupNameOf` in calendar.ts; '' = the "Group" default, the name is NOT
  reserved for real factions) and used by every picker label, chip, rail/home
  entry. Group chips link to this page. The Group is its own entity color-wise:
  `settings.groupColor` (first "Entities colors" picker, default `#46b5a5`) colors its chips
  (EntityChip + the modal's renderChip special-case the stub's sentinel path),
  home-wheel button, and page header — even though it never appears in the graph.
  Layout: Name, then Members with Alive / Inactive / Dead sub-sections (dead PCs
  pair their chip with the death session's chip), then the Events hub — every
  event/quest where the Group or ANY PC (alive or not, active or not) is on a
  note (snapshot or direct involvement). The hub has a search (event names +
  note texts) and, folded behind a filter icon (accent-lit while active), a
  filter panel: quick-toggle PC chips, an any-entity search with the standard
  type-filter menu (an entry matches when every selected entity is on the note —
  involved, in its group snapshot, or among its places), and a session-month
  filter (year switcher + 3×4 Gregorian month grid, multi-select across years).
  Rows are read-only mirrors of the entity-page event rows — the event NAME is
  the link (no → button) and note text renders through the read-only
  `MarkdownField` (links/bold/bullets). The create modal still accepts
  `defaultGroup` (pre-filled group snapshot).
- **Hidden connections**: links under the `deathSession`, `sublocationOrder`, and
  `itemOwner` (a copy's owning character — already connected via `loomItems`) keys
  never become connections or graph edges. `attendance` is hidden from the generic
  link pass but emits typed `attendance` connections (a ticked PC connects to the
  session). Sessions list attending PCs (`PC` tag); PCs carry `alive`, `active`, and
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
