# Roadmap

Checklist per feature area. When completing an item, mark it `[x]`, note where the code
lives, and keep `CLAUDE.md`'s file map in sync.

## Project setup

- [x] Project scaffolding (Entities/*, Timelines, default timeline, .loom home file) — `src/project.ts`
- [x] "Set up project" command + modal — `src/project.ts`, `src/main.ts`
- [x] Multiple projects per vault: .loom files in the file explorer are the entry points; commands resolve via single-project fallback or a project picker — `src/indexer.ts`, `src/main.ts`
- [x] Legacy single-root settings migration (auto-creates the .loom file) — `src/main.ts`
- [ ] Export/import loom projects: package a project (its .loom config + all entity/timeline notes) into a portable archive and import one into another vault — handle name collisions with existing notes and re-anchor the project root path on import. **Deferred (late-game):** it serializes the whole data model, so every new frontmatter key / config field would have to be maintained here — build once the core data model stabilizes.

## Licensing

Freemium: one project of each kind is free with every feature available; a license key
unlocks unlimited projects, activatable on up to 3 devices; must not break offline (30-day
cached grace period). See CLAUDE.md's "Key architectural decisions" for the full reasoning.

- [x] Provider-agnostic `LicenseProvider` seam + types (`CachedLicenseState`, `LicenseStatus`) — `src/license/provider.ts`, `src/license/types.ts`
- [x] 30-day offline grace period, pure + boundary-verified — `src/license/grace.ts`
- [x] Per-device cache (device id + activation), `App.loadLocalStorage`/`saveLocalStorage` so it never syncs with the vault, feature-detected fallback for pre-1.8.7 Obsidian — `src/license/cache-store.ts`
- [x] Free-tier gate (`canCreateProjectOfKind`) — `src/license/gating.ts`
- [x] `LicenseManager` (activate/deactivate/revalidate, recheck throttle, offline "forget locally" fallback) — `src/license/manager.ts`
- [x] `StubLicenseProvider` (in-memory, 3-device cap simulation, network-down toggle) — the active provider for now — `src/license/stub-provider.ts`
- [x] Settings → License tab (key field, activate/deactivate/re-check, status) — `src/settings.ts`
- [x] `main.ts` wiring: manager construction, startup re-check, recurring background re-check interval — `src/main.ts`
- [x] Gate `SetupProjectModal` (disabled Create button + inline upsell, authoritative re-check in `submit()`) — `src/project.ts`
- [ ] **Blocked on a Polar.sh account existing:** verify `PolarLicenseProvider`'s wire format against the live API (field-name casing is currently a documented guess), then flip `main.ts` from `StubLicenseProvider` to it — `src/license/polar-provider.ts`
- [ ] Purchase/checkout link UI (not designed yet — out of scope until the provider is live)
- [ ] **Unresolved, blocking any public pricing:** confirm with Obsidian whether the community plugin directory allows paywalling in-app functionality itself (vs. paywalling a backend service called from the plugin) — research during planning could not confirm either way
- [ ] Decide whether to bump `minAppVersion` past `1.7.2` (to `1.8.7`, for `loadLocalStorage`/`saveLocalStorage`) or keep the current session-only fallback for older Obsidian indefinitely
- [ ] README network-use disclosure once the real provider is live (the stub makes no real network calls, so the current disclosure already covers it, but it needs a fresh pass once `PolarLicenseProvider` is wired up)

## Entities

- [x] Seven entity types with basic frontmatter templates (type, loomTags, description, relationships; role for characters; date for events/sessions; quests currently share the basic template, unique fields planned) — `src/types.ts`, `src/project.ts`
- [x] Creation command + modal: one context-aware "Create entity in current project" command with an entity-type suggester (replaced the per-type commands); sessions: date only, managed file name `<Project> Session <date>` — `src/project.ts`, `src/main.ts`
- [x] Entity page view: structured fields (name renames the file, description, tags, date, notes body, relationships editor) over plain .md; loom-internal clicks open it, file explorer still opens raw markdown — `src/views/entity-view.tsx`
- [x] All text boxes auto-size to their content, both growing and shrinking, one-line minimum — no scrolling, no manual sizing (resize edges hidden, height memory retired; `settings.entityBoxSizes` no longer read) — `src/views/common.tsx` (`autoGrowTextarea`), all views
- [x] Relationships editor: target search field offers "+ Create entity…" pinned at the top of its suggestion list, prompting an entity type then the create modal, wiring the new note in as that row's target — `src/views/entity-view.tsx`, `src/views/common.tsx`
- [x] Connected-entities sections on every entity page: one collapsible section per connected type (collapsed by default), entries expand to the target's description + notes with in-place edit/save and a jump-to-page arrow — `src/views/connected-entities.tsx`
- [x] Session attendance: PC-character toggle chips on session pages, stored in `attendance` as hidden connections (no graph edges); PCs get an Alive tick + death-session picker, and later-dated sessions stop offering dead PCs — `src/views/entity-view.tsx`, `src/indexer.ts`
- [x] Session number: each session page shows its chronological counter (far-right of the Date title row, styled as a copy of the "Date" title) — its 1-based position among the project's sessions ordered by date (ties → creation time → path). Computed live, never stored, so it self-corrects when a session is deleted or a wrong date is fixed — `src/views/entity-view.tsx` (`sessionNumber`), `styles.css`
- [x] Entity deletion with confirmation: trash icon on list rows and in the entity page header (Back/list fallback after delete) — `src/views/list-view.tsx`, `src/views/entity-view.tsx`
- [x] Session notes on every non-session entity page: "+ Add a session note" under the Notes field adds a header row with a compact-date session picker (input-sized chip once picked, always `MMM Do, YYYY` regardless of project format, already-noted sessions not offered again, "+ New session…" pinned in the dropdown; remove ✕ at the row's right edge, confirmed when text exists) and a full-width 5-line note textarea beneath it, so what was written when is tracked; stored as `sessionNotes: [{session, text}]` frontmatter, and each picked session becomes a `session note` connection (graph edge) automatically — `src/types.ts`, `src/indexer.ts`, `src/calendar.ts` (`formatLoomDateShort`), `src/views/entity-view.tsx`
- [x] Session date entry uses a native `<input type="date">` (calendar picker) in both the creation modal and the entity page, since sessions are always Gregorian; events keep the free-text field + "@today" (they may follow the project's custom calendar) — `src/project.ts`, `src/views/entity-view.tsx`
- [x] `linkedSession` removed (and with it the short-lived event↔session mirror sync): relationships already express event↔session membership, so the dedicated field, its entity-page picker, and the "Link to this session" graph drop are gone; old notes carrying the key keep their connections via the generic frontmatter-link mechanism — `src/columns.ts`, `src/indexer.ts`, `src/views/entity-view.tsx`, `src/views/graph-view.tsx`
- [x] Description/Notes editing — delivered by the `MarkdownField` (CodeMirror 6 live-preview): `[[` pairing + completion, bold/italic/underline hotkeys, Enter list continuation, Tab indent + nesting rails, quotes/bullets/hr. **Resolved — scope closed here on purpose:** no more hand-coded formatting features. `link-textarea.tsx` is now type-only (`LinkOption`); the component isn't rendered anywhere. (Only revisit if a package can activate Obsidian's *native* editor behaviors wholesale rather than us re-implementing each one) — `src/views/markdown-field.tsx`
- [x] ~~Deep/final frontmatter schemas per type~~ — **dropped**: was a deliberate v0.1 non-goal (strict per-type validated schemas); the frontmatter grew organically and is good as-is, so this is moot
- [x] Quest fields + page layout: quest givers (several characters, chip list + picker), received-in session, outcome (Active/Completed/Abandoned/Failed) with an outcome session shown once set, reward text ("Not specified" placeholder) — frontmatter keys `questGiver` (list), `questReceived`, `questOutcome`, `questOutcomeSession`, `reward`; all fields also in the quest creation modal (single giver dropdown there) — `src/types.ts` (`QUEST_OUTCOMES`), `src/indexer.ts`, `src/views/entity-view.tsx`, `src/project.ts`
- [x] Quest page layout: quest givers sit left of a full-height vertical separator (picker above the chip list); right of it a row of "Received in session" / "<Outcome> in session" / "Outcome" with the reward beneath — the separator stretches with whichever side grows (wrapping givers, long reward); received/outcome session chips match one-line input height while giver chips stay small — `src/views/entity-view.tsx` (`loom-quest-grid`), `styles.css`
- [x] Deletion confirmations on entity pages: removing a session note that holds text, or a relationship row with a target, asks first (still-empty rows go silently) — `src/views/entity-view.tsx`
- [ ] Further quest layout polish if the current form proves insufficient
- [x] Sublocations: dedicated `parentLocation` frontmatter link (deliberately NOT a relationship — it has its own UI and a typed `sublocation` connection/graph edge); every location page has a "Sublocations" section between session notes and Relationships with the clickable child list, a "+ New sublocation" button (creates a full Location with `parentLocation` prefilled, opens it, Back returns to the parent), and — for locations without a parent — a header "Turn to a sublocation" button (left of "Open as markdown") opening a fuzzy-search picker (`RecordSuggestModal`) over every other location, sublocations included (the whole child hierarchy moves along; self and descendants excluded, so cycles can't be built — a search, not a menu, since projects can get huge); a sublocation shows "Sublocation of [parent]" under its Name as a plain clickable link (no detach there — releasing a sublocation happens on the parent's page, ✕ per list row); the parent's list is reorderable by holding the left grip — rows slide in real time (CSS-transform slots, the row is never carried by the cursor), committed on release as `sublocationOrder` links in the parent's frontmatter (a hidden-link key — children already connect via `parentLocation`); sublocations nest arbitrarily deep; big page sections (Session notes, Sublocations, Relationships, Connected entities) are separated by rules (`loom-field-sep`) — `src/types.ts`, `src/indexer.ts`, `src/project.ts`, `src/views/entity-view.tsx`

## Index cache

- [x] Project discovery (.loom files) + in-memory index from frontmatter, incremental updates on change/delete/rename — `src/indexer.ts`
- [x] Outgoing + incoming (backlink) relationship resolution, including plain [[wikilinks]] in body/frontmatter as `link` connections — `src/indexer.ts`
- [x] JSON snapshot persisted to the plugin folder — `src/indexer.ts`

## Home

- [x] FileView over the project's .loom file: per-type buttons + counts, timeline/graph shortcuts — `src/views/home-view.tsx`

- [x] Icon-only navigation rail on the left of every page except home (home, entity lists, graph); replaces the header Home button — Back alone stays in the header, greyed out when there's nowhere to return — `src/views/common.tsx`
- [x] Entity-list context menu (right-click a row): general block — Rename (prompt; not for item copies/sessions), Copy as "<name> 1/2/…" (not for item copies), Add alias, Add relationship (identifier + target modal), danger-styled Delete (list delete button restyled to match pages) — then per-type commands: characters (tag toggles PC/NPC/Cast, add a faction/an event/an item), locations (add an event/an item/sublocation), factions (add a member/an event), items (add an event, add to multiple characters/locations via a chip-collecting modal), quests (tag + status toggles, add a quest giver/a session note), events (add a session note, add/change the date), sessions (change the date — renames the file, attendance toggles, add an event/a quest pinned to the session) — `src/views/list-view.tsx`, `src/project.ts` (`TextInputModal`, `AddRelationshipModal`, `AddToHoldersModal`, `renameEntityRecord`, `copyEntityRecord`, `renderChipEl`, `recordPickLabel`)
- [x] Fixes: character-page faction picker matched options (link targets) by display name so picking did nothing; the faction modal's member rows lost their character/location input values on every re-render (adding a 2nd member looked like it wiped the 1st); faction "Add a member…" gained "+ Create new character"; live-preview fields kept the parked cursor's line raw after focus left (reveal now requires focus, decorations rebuild on focusChanged) — `src/views/entity-view.tsx`, `src/project.ts`, `src/views/markdown-field.tsx`
- [x] List controls: ascending/descending toggle for every sort; nested lists (locations, items) collapse/expand via ONE cycling icon button (`list-chevrons-up-down`/`-down-up`, fallback to plain chevrons) and draw a vertical nesting rail along subtrees; quest list adds a status filter (active/completed/abandoned/failed), configured-color tag chips with icons (shared `QuestTagChip` in common.tsx), and a list/cards view toggle whose cards reuse the session-page 3-column quest-card layout; event list adds involved-entity (group snapshots count) and location (descendants included) filters — `src/views/list-view.tsx`, `src/views/common.tsx`, `styles.css`

## List views

- [x] Per-type list with search, sort (name/created/modified/date), plugin-tag filter, click opens entity page, new-entity button — `src/views/list-view.tsx`
- [x] Nested sublocation lists: in the Locations list, sublocations indent under their parent (recursively, non-bold; child count beside the parent's name), collapsible per parent via a caret (auto-collapsed once a parent holds more than 5; the caret slot is reserved on every row so names left-align per level), with toolbar "Collapse all" / "Expand all" buttons; each main location's subtree scrolls horizontally on its own when deep nesting would cut off; searching flattens the list so matches can't hide inside collapsed parents; parent cycles fall back to top level — `src/views/list-view.tsx`

## Timeline

- [x] Migrated into the graph as a collapsible bottom drawer (Open/Collapse toggle, drag the bar edge to resize); no standalone timeline view — `src/views/graph-view.tsx`, `src/views/timeline-strip.tsx`
- [x] Sessions + events ordered by date; linked events nested + indented beneath their session — `src/views/timeline-strip.tsx`, `src/columns.ts`
- [x] Sessions display only their date; event-anchored columns show the date above the name — `src/views/timeline-strip.tsx`
- [x] Multiple timeline definitions from `/Timelines` frontmatter (types + tag filters), selectable in the drawer bar — `src/indexer.ts`
- [x] Hover tooltip from `description`, click opens entity page — `src/views/timeline-strip.tsx`
- [x] Per-project timeline settings: date display format + custom in-game calendar (month count, names, optional short names); edited in the settings tab's Graph tab — `src/timeline-settings.ts`, `src/calendar.ts`
- [x] Timeline hover tooltip: the full name renders as a header above the description; shown when the name is ellipsized in the strip (measured on hover) or a description exists — a fully visible name with no description shows no tooltip — `src/views/timeline-strip.tsx`
- [x] ~~Proportional time spacing / zoom~~ — **cancelled**: too much detail to manage in a virtual timeline; a distant long-ago event would land far off in an inaccessible spot on the graph. Ordinal (equal-spacing) stays.
- [x] Drag interactivity: event bubbles drag between the "No date" drawer and session columns (see the drawer entry below) — `src/views/timeline-strip.tsx`

## Graph ("Loom")

- [x] Layered layout: sessions row, events grouped beneath their connected session, globals in one row per type (order configurable in settings, default quests/characters/factions/items/locations) pulled toward connections — `src/graph/layout.ts`
- [x] Events respect sessions above all other connections: an event connected to one session stacks beneath it; connected to several, it centers between its earliest and latest session columns; quests do the same via their fields — under the received session, centered between received and outcome sessions once an outcome is set (re-pinned every relaxation pass, so other connections and drags don't pull them off) — `src/columns.ts`, `src/graph/layout.ts`
- [x] Repel forces for events: free-floating events (dateless, unconnected) are pushed out of overlaps with column anchors, stacked events, and each other when placed or drag-dropped — `src/graph/layout.ts`
- [x] Sublocations layer: locations carrying `parentLocation` leave the locations row and form a hierarchical grid right under it — each location's direct children sit one grid row below it, clustered under it 4 wide (wrapping pushes deeper levels down: 5th starts the next row), so a sublocation's own sublocations always land beneath it; child order follows the parent's `sublocationOrder`; entries sharing a grid row sweep apart, and the grid rows are real layers (bands/edge routing/checker apply) — `src/graph/layout.ts` (`SUB_COLS`)
- [x] Checker pattern against label overlap: row neighbors whose names would collide alternate slightly above/below their row (runs of overlapping labels zigzag; nodes with room stay flat); label widths and the stagger amplitude are estimated from the text-size setting (compact/normal/large), so the pattern adapts when it changes — `src/graph/layout.ts` (`applyLabelChecker`), `src/views/graph-view.tsx` (`LABEL_FONT_PX`)
- [x] Connections side panel width is adjustable by dragging its left edge (min = the original 260px), remembered with the rest of the graph's UI state — `src/graph/side-panel.tsx`, `src/views/graph-view.tsx`
- [x] Force-based ordering within global rows: iterative 1D relaxation (40 passes) pulls each connected global to the mean x of its neighbors (timeline nodes anchor, global↔global links converge mutually) with a min-spacing collision resolve between passes — replaced the old 2-pass barycenter whose ties degenerated to alphabetical order on globals-only projects — `src/graph/layout.ts` (`resolveRowOverlaps`)
- [x] Sublocation list reorder: grip-drag with the grabbed row stuck to the cursor (raw dy, no transition) while the other rows slide one slot to open the gap (`loom-subloc-row-slide`/`-dragging`) — `src/views/entity-view.tsx`, `styles.css`
- [x] ~~Drag-to-reorder in global rows~~ — **removed**: connected nodes are placed purely by the pull forces (dragging one just springs it back — reordering never really worked against the forces anyway). Only **fully-unconnected** nodes persist a dropped position now (`isFreePlacement`), holding BOTH x and y where dropped (no one-frame offset ghost — the drag displacement is cleared before the relayout). Free-Y is clamped to the node's real **layer band** (replacing the flat ±55px): an unconnected event roams the whole event stack (EVENT_Y0…eventsBottom) and into the gap below; an unconnected global roams half-way to the adjacent layer rows — `src/views/graph-view.tsx`, `src/graph/layout.ts`, `src/settings.ts`
- [x] Drag with spring-back physics; single click dims unconnected, double click opens the entity page — `src/views/graph-view.tsx`
- [x] ~~Live reflow while dragging~~ — **removed**: re-running the full layout (force relaxation + `leftPad`) every animation frame made the whole graph shift under the cursor and pulled other rows toward the held node (and was the heaviest per-frame cost). A drag now just moves the dragged node under the cursor — the full layout (all rules: forces, repel, routing) runs once on drop, sliding into place via the displacement-carry springs. `liveManual` retained but inert. (Missed pointerups still abort the drag; the dragged node still renders at the cursor's world position) — `src/views/graph-view.tsx`, `src/graph/layout.ts`
- [x] Node colors AND sizes per entity type, configurable in settings (`nodeColors` + `nodeSizes`, an 8–44px radius slider per type in the Entities tab; `radiusOf` reads them in the graph + mini-graph, edge attach radii, drop hit-test and animation separation) — `src/settings.ts`, `src/views/graph-view.tsx`, `src/views/mini-graph.tsx`
- [x] Side panel: connections grouped by type, collapsible, auto-collapse over threshold — `src/graph/side-panel.tsx`
- [x] Horizontal culling of off-screen nodes — `src/views/graph-view.tsx`
- [x] Camera navigation: wheel zoom around cursor, drag-pan with any mouse button, right-click a node to zoom + center — `src/views/graph-view.tsx`
- [x] Side panel keeps the selected node visible (auto-pans when the panel would cover it) — `src/views/graph-view.tsx`
- [x] Trash-can drop zone: a hidden quarter-circle sector in the graph's bottom-right corner fades in with a trash icon as a dragged node approaches (proximity-based opacity, red when armed); dropping inside opens the delete confirmation and trashes the note — `src/views/graph-view.tsx` (`TRASH_R`), `styles.css`
- [x] BUG — nodes froze mid-drag, then sprang back to their old spot: node drags used `setPointerCapture` on the node `<g>` plus that element's own `onPointerMove`/`onPointerUp`, but a re-render (index refresh or live reflow) can unmount/replace the `<g>`, silently dropping the capture and firing `pointercancel` → `abortDrag` mid-drag. Rebuilt on window-level `pointermove`/`pointerup`/`pointercancel` listeners (gated by a `dragActive` state, latest closures via a ref) with no pointer capture at all, and the dragged node now always renders even if it slides out of the cull range — the drag no longer depends on the node element's lifecycle. Panning was already safe (it captures the stable `<svg>`). This should also cover the old "stuck under fast drags / lands in random spots" report — `src/views/graph-view.tsx`
- [x] Graph search: a search box in the graph header — matching nodes (by displayed label) stay lit, everything else dims, edges dim unless an endpoint matches; clears to restore selection-based dimming — `src/views/graph-view.tsx`
- [x] Edge bends follow drags: route waypoints shift with each endpoint's displacement (exit bend rides the upper node, approach bends ride the lower, the trunk slants between), so connections stay organically attached during drags/springs instead of pinning at the old geometry — `src/graph/routing.ts` (`edgePoints` da/db)
- [x] Graph filter: funnel button beside the search opens a popover with tick-able entity types and an eye toggle — eye-dashed dims filtered nodes/edges, eye-closed hides them completely (accent-tinted funnel while active); search bar has an inline ✕ to clear. The filter state (ticked types + eye mode) persists per project across restarts (`settings.graphFilters`) — src/views/graph-view.tsx, src/settings.ts
- [x] Drag performance — scale to many connections: every drag/spring frame used to re-render the whole graph (all ~E edge paths recomputed) plus the timeline and side panel. Split rendering into memoized `GraphEdge` / `GraphNode` (`React.memo`, primitive/position props) so only the dragged node + its incident edges + the drop-target recompute per frame — cost is now O(node degree), not O(all edges). Also memoized `TimelineStrip` and `GraphSidePanel` (with stabilized props) so they no longer re-render on drag frames — `src/views/graph-view.tsx`, `src/views/timeline-strip.tsx`, `src/graph/side-panel.tsx`
- [ ] Visual polish: animations, edge styling/bundling, further performance tuning for large graphs (next candidates if needed: throttle the reorder live-relayout, spatial index for the drop-target hit test, isolate the tick-driven SVG into its own subtree so the parent's header/drawer chrome stops re-rendering per frame)
- [ ] Vertical virtualization of culling
- [x] ~~Sticky globals while panning~~ — **cancelled, replaced by pins**: automatic stickiness had little practical value; user-driven pinning is lighter (only picked nodes stick) and more useful.
- [x] Pin nodes (lock on the canvas): right-click a node toggles a pin — it locks at a fixed WORLD position (overriding the force layout) and scrolls with the camera like any node, so its edges keep the normal fan routing (diagonal tips, no arch) and it can go off-screen. Once a pinned node is FULLY off the viewport (so it never overlaps a still-visible node), a node-colored **edge indicator** with a slowly pulsing radial halo clamps to the viewport border pointing at it; clicking it pans the camera to center the node. Node culling is position-based (a far-pinned/dragged node no longer vanishes because its layout home is off-screen). Right-click MID-DRAG pins the dragged node where it sits and ends the drag (capture-phase `contextmenu` listener). Zoom-focus moved off right-click to a press-and-hold (`HOLD_MS` 450ms, still, no move; a move cancels it into a drag, a quick release stays a select). Pinned nodes render on top, stay exempt from filter/pick hiding, and show an accent ring + 📌. Dragging a pinned node repositions its pin; unpinning eases it back to its force home (seeded displacement + spring, so it doesn't stick at the pinned spot). A header "clear pins" button (shown when any) and Esc (after clearing selection) clear all (both ease every node home via the shared `unpinAll`). Pins persist across restarts (`settings.graphPins` per project → world positions, rename/delete-migrated with manualX/Y) — `src/views/graph-view.tsx`, `src/settings.ts`, `src/main.ts`, `styles.css`
- [x] Drag a node onto another node to connect them — the declaring side is configurable (`graphDropEdits`, Settings → Graph → "Drop-to-connect edits"): default `target` = the node dropped onto declares (dropping A on B adds A into B), or `dragged` = the dragged node declares (connecting A to B); the hover ring's remove cue follows the setting. Field-aware drops are unaffected. Original semantics: if its note doesn't yet declare a relationship to the target, drop prompts for an identifier (default `related`) and writes it into the dragged note (even when the target declares one back — that's how mutual pairs like wife/husband are built, one drag each way); if it already declares one, drop offers to remove the dragged note's own declaration only (typed relationships; the other side's stay). Hover cue: accent ring = will connect, dashed warning ring = will offer removal — `src/views/graph-view.tsx`, `src/project.ts` (`RelationshipPromptModal`)
- [x] Field-aware drops: pairs with a dedicated field open a menu at the drop point offering to fill it — character↔quest: "Add as quest giver"; character↔faction: "Add as member" (faction's `members`, default role); item↔character/location: "Add item" (holder's `loomItems`); quest↔item: "Add as reward" (appends `[[item]]` to the quest's free-form reward); session↔quest: "Set as received session" or "Completed/Abandoned/Failed in this session"; session↔PC: "Mark as attending" (session `attendance`) alongside "Add session note"; event↔any involvable entity: "Involve in event" (event's first session note's `involved`, creating one if needed), and event↔location additionally "Add as place" (`places`) — a location can be both; location↔location: "Make sublocation of <target>" (whole child hierarchy reparents; hidden when already its child or would cycle). All write to the note that owns the field regardless of drag direction; the generic "Add/Remove relationship…" is always the last option (declaring side per `graphDropEdits`); already-satisfied fills are hidden; a single remaining option acts immediately without a menu — `src/views/graph-view.tsx`
- [x] Locations are selectable in event "involved" pickers again (page session-note editor + hub event rows + their type-filter menus; the create modal already allowed them): a location can live in BOTH `involved` (a place discussed/featured in the event) and `places` (where it happened — surfaces on the location page) — `src/views/entity-view.tsx`
- [x] Direction arrowheads on edges: an arrow at the endpoint a relationship is declared at (A declares → arrow into B; mutual same-relType declarations merge into one edge with arrows both ends; different relTypes stay separate edges), tips at the node rims following each route's true end tangent; size adjustable in settings (`graphArrowSize`, 4–20 px) — `src/graph/layout.ts`, `src/graph/routing.ts` (`edgeEndDirs`), `src/views/graph-view.tsx`, `src/settings.ts`
- [x] Orthogonal edge routing (replaced the bowed curves): per-edge vertical trunk lanes in the corridors between columns (corridors widen for branching-heavy nodes — inconsistent date spacing accepted), horizontal runs in per-edge y-lanes in the bands between rows, same-row edges as U shapes beside their row, all bends slightly rounded; runs converging on one node take lanes by trunk distance (farther = lower) so same-target runs can't cross each other's trunks — `src/graph/routing.ts`, `src/graph/layout.ts`
- [x] Unified angled connection style: every edge endpoint attaches with a diagonal fan segment — exits leave the upper node diagonally to their trunk top (`DEPART_DROP` below the node; replaced the horizontal exits and the old orthogonal-Z `orth` kind, which is now the same `fan` route), entries fan in above the target, and same-row U turn points spread across each node's side; a node side fits `FAN_CAP` connections at full `FAN_GAP` spacing (available space first), beyond that the spread compresses evenly across ±`FAN_MAX` and overlapping is accepted; applies to timeline and global nodes alike — `src/graph/routing.ts`, `src/graph/layout.ts`

## Settings

- [x] Tag vocabulary per entity type, graph collapse threshold (with value label), graph node colors + per-type node sizes — `src/settings.ts`
- [x] Entity layers section (user-facing name; internally still "global" layers): reorderable row list with a labeled "Reset order" button at the bottom right of the section (deliberate exception to the per-setting ↺ icon — a lone icon by the heading read as noise) — `src/settings.ts`
- [x] Horizontal + vertical line spacing: distance between parallel graph edge lines (px, min/default 10, up to 40 each) — `lineGap`/`trunkGap` params of `computeGraphLayout`; vertical spacing is enforced by a trunk-separation pass (any two vertical trunks with overlapping y-spans get pushed `trunkGap` apart, re-clearing node collisions after each round) that also covers global-origin trunks hugging their node's side, which corridor fanning never spaced — `src/settings.ts`, `src/graph/layout.ts`, `src/views/graph-view.tsx`
- [ ] Adopt the declarative settings API (`getSettingDefinitions`) once Obsidian 1.13 leaves Catalyst-only early access — the remaining lint warning; do not use 1.13-only APIs before then (minAppVersion stays 1.7.2)

## Undo (Ctrl+Z)

Plugin-wide undo of the last action, phased. Core design: an `UndoManager` on the plugin holding a stack of `{label, undo()}` actions with Ctrl+Z/Ctrl+Shift+Z handling scoped to loom views — must not fire while focus is in an input/textarea (native input undo wins) and must not steal Ctrl+Z from markdown editors in other panes. Undo shows a Notice naming what was undone. File-content actions use full-text snapshots taken just before the write (undo = restore old text), so no per-action inverse logic is needed.

**Deferred until the feature set stabilizes.** Runtime cost is negligible (a bounded stack of small snapshots), but every write path must funnel through the wrapper and every new feature must register — miss one and undo silently corrupts. Obsidian's File Recovery + trash already cover catastrophic loss, so this is convenience, not safety. Same "build once the data model settles" logic as export/import.

- [ ] Phase 1 — frontmatter/body writes: snapshot wrapper around all `processFrontMatter`/body saves (date changes, description/notes edits, tag toggles, relationship add/remove, attendance, graph connect/disconnect); covers most user actions
- [ ] Phase 2 — everything else: settings-side actions (graph drag-reorder `graphManualX`), entity create (undo = delete) and delete (undo = recreate from snapshotted content), and composite actions grouped as one undo step (e.g. session date change = frontmatter write + managed file rename)

## Docs & release

- [x] CLAUDE.md / ROADMAP.md / docs/ARCHITECTURE.md populated with real v0.1 state
- [x] Release workflow building main.js/manifest.json/styles.css on GitHub release — `.github/workflows/release.yml`
- [ ] README with screenshots/GIFs before community plugin submission

## Queued (2026-07-17 backlog, not started)

- [x] Graph forces fixed: manual-x pseudo-edges no longer apply to nodes with real connections (stale drag spots kept connected clusters stretched apart) — connections always win; manual x/y only position fully-unconnected nodes — `src/graph/layout.ts` (`manualPull`)
- [x] Merge bidirectional connections: when both notes declare any connection to each other, draw ONE edge with arrowheads on both ends instead of two parallel edges (today only same-relType pairs merge)
- [x] Drop on/of a session prompts: "Create session note…" (opens/creates the entity's sessionNotes row for that session) or "Add relationship…"
- [x] Session pages: focused "Session graph" section (collapsed by default) — interactive but not editable mini graph (`src/views/mini-graph.tsx`): pan, wheel zoom, node drag with spring-back, click-select dimming, Esc unselect, double-click opens the page; filter popover + fit icon float at its top right; positions borrowed from the full layout, no drops/reorder/persistence
- [x] Session pages rework: Notes body removed; "Session notes" hub — every note in the project pinned to this session listed with its place/owner as a clickable header, editable/deletable in place (writes go to the owning file), "+ Add an event" on top — the created event starts with a session note already pinned to this session, and its creation modal gains an "Involved entities" picker (characters, items, … written as involves relationships); order: Attendance, Quests, Description, Session notes; Quests section with Active/Finished collapsible lists, states computed AS OF the session's date — `src/views/entity-view.tsx`
- [x] Graph interaction: right-click on a node opens its entity page (edit), middle-click takes over the zoom+center focus currently on right-click
- [x] Sublocations: new child appends to the END of the parent's list (write it into sublocationOrder on creation instead of inheriting alphabetical placement); do NOT auto-open the new sublocation's page
- [x] Faction members: dedicated list on faction pages (separate from relationships) for adding characters
- [x] "Faction(s)" on character pages: relationship-style rows (`[role] of faction [faction] at [location]`, role `Member` by default, location optional) mirroring every faction whose `members` list holds the character, plus a "+ Add faction" picker; all edits write the faction's file, so both pages always agree; entries emit a typed `member` connection; replaced the freeform character `role` field — `src/types.ts`, `src/indexer.ts`, `src/project.ts`, `src/views/entity-view.tsx`
- [x] Virtual "Group" faction: selectable searches (Involve… pickers on note rows, faction Members, relationship targets, the create-modal's Involved field) offer a file-less "Group" entry connecting the whole party at once. Party = PC-tagged + `alive` + `active` (`loomActive` checkbox next to Alive on PC pages — untick while a character is away, new picks skip them, old snapshots keep them). Involved pickers store a frozen `group` snapshot list on the note entry, shown as one "Group" faction chip while each member connects individually (involved connection + graph edge + Events section); Members/relationship pickers expand into individual entries. "Group" is a reserved faction name (creation/rename blocked with a Notice); never in the entity list or graph — `src/types.ts`, `src/indexer.ts`, `src/project.ts`, `src/views/entity-view.tsx`
- [x] Group page (`circle-star`): a file-less party hub in the faction-page layout — editable name stored as `groupName` in the .loom config (used by all pickers/chips/rail/home; "Group" is only the default, not reserved); Members with Alive / Inactive / Dead sub-sections (dead = chip + death-session chip); Events hub listing every event/quest where the Group or any PC (regardless of alive/active) is on a note, searchable by event name + note text and filterable by multi-select PC chips (group snapshots count), rows read-only with clickable event names and note text rendered via read-only `MarkdownField`; Group chips everywhere link to this page; FIRST entry in the nav rail and on the home wheel — `src/views/group-view.tsx`, `src/views/common.tsx`, `src/calendar.ts`, `src/project.ts`, `src/main.ts`, `src/types.ts`
- [x] Loom button colors: "Loom, original" — plum `#4c3d57` / cream `#fff8e6`, applied bg/icon in the light theme and reversed in the dark theme, flipping live with the app theme (CSS `body.theme-dark`) — or a custom bg+icon pair; dropdown + pickers under the Entities tab's "Loom button" heading — `src/settings.ts`, `src/views/home-view.tsx`, `styles.css`
- [x] Settings reshuffle: node colors moved from the Graph tab to the Entities tab as "Entities colors" — Group first, then entity types, quest tag colors nested under Quest — `src/settings.ts`, `styles.css`
- [x] Read-only markdown fields (Group page notes, original-description spoiler) keep their rendered formatting while selecting (raw reveal — line and inline — is edit-only) and copy what's on screen: the field stays contenteditable with only `EditorState.readOnly` (a non-editable view leaves the native selection empty, so Ctrl+C never fires) and strips all editing extensions; a plain-DOM `copy` handler puts the display text on the clipboard (wikilinks → their labels, markers stripped, bullets as •) — `src/views/markdown-field.tsx`
- [x] Group page ← Back button: the page records an `origin` (rail, home wheel, and Group chips all pass theirs) and Back returns exactly there, greyed out without one — `src/views/group-view.tsx`, `src/views/common.tsx`, `src/views/home-view.tsx`, `src/views/entity-view.tsx`
- [x] Group as its own entity color-wise: `settings.groupColor` (first Entities-colors picker, default teal) colors every Group chip, the home-wheel button, and the Group page header; the events filter moved behind a filter icon into a panel with quick PC chips + an any-entity search with type-filter menu (match = every selected entity on the note via involved/group/places) + a session-month filter (year switcher, 3×4 month grid, multi-select) — `src/settings.ts`, `src/views/group-view.tsx`, `src/views/common.tsx`, `src/project.ts`, `styles.css`
- [x] Home wheel: the 3×3 grid became a radial layout — the Loom button enlarged in the center, circular satellite buttons (Group first at 12 o'clock, then entity types clockwise) evenly spaced on a ring, redistributing automatically as entries are added; each satellite is tinted with its entity node color (full-color icon, same-hue diluted background/border via color-mix so the icon stays readable in both themes) — `src/views/home-view.tsx`, `styles.css`
- [x] `EntityChip` — the one standard entity tag (node-colored pill, clickable name, optional ✕) used everywhere an entity renders as a tag: involved lists, members, quest givers, memberships, session/date links (session chips keep their special sizes but always get the session color) — `src/views/common.tsx`, `styles.css`
- [x] Custom membership roles label the `member` connection (graph edge + side panel show e.g. "Captain" instead of "member"); fix: entity-page session-note commits round-trip every field (`involved`/`places`/`seq` were silently dropped, so involving an entity from an event/quest page never saved) — `src/indexer.ts`, `src/views/entity-view.tsx`
- [x] Write-path consolidation: one `editFmList` helper behind every cross-file list edit (members, other notes' session notes/relationships); `commitSessionNotes` merges drafts over stored entries by seeded index so unknown fields survive; storage registry table in `docs/ARCHITECTURE.md` — `src/views/entity-view.tsx`, `src/fm.ts`
- [x] Managed entity file names: `loomName` frontmatter = user-entered display name; files named `<Project> <Type label> <name>` (renamed on name edit; native `aliases` keeps [[…]] autocomplete working); all plugin links target file basenames while pickers search/label by display name — `src/naming.ts`, `src/project.ts`, `src/indexer.ts`, `src/views/*`
- [x] Notes/Description live-preview editing (`MarkdownField`, CodeMirror 6 from Obsidian's bundled packages): wikilinks render without brackets (alias shown) until the cursor enters them, click opens the entity; `[[` auto-pairs, backspacing an empty pair removes both sides, inline completion inserts `target|display`; bold/italic/strike/highlight, `>` quotes, bullet lists, `---` separators — `src/views/markdown-field.tsx`, `styles.css`
- [x] Link completions scoped to the project's entities only, searched by short name (sessions by date); a "+ Create …" entry spawns the type picker + creation modal with the typed short name prefilled and links the new entity in place; relationship target inputs show sessions by their date instead of the managed file name — `src/views/entity-view.tsx`, `src/views/markdown-field.tsx`, `src/project.ts`
- [x] Markdown field polish: blockquotes get breathing room after the bar + tinted background; Enter continues `>` / bullet / numbered formatting (marker-only line exits); Ctrl/Cmd+B/I/U toggle `**`/`*`/`<u>` (with `<u>` rendering); inline tokens render the moment they're completed (raw only while the cursor is strictly inside) — `src/views/markdown-field.tsx`, `styles.css`
- [x] Aliases on entity pages: Name (70%) + Aliases (30%) share a row (wrapping when long), the alias box has an inline + button; added aliases show as neutral chips with ✕ below; reads/writes Obsidian's native `aliases` frontmatter (what link suggestions use), the display-name alias stays plugin-managed and hidden — `src/views/entity-view.tsx`, `styles.css`
- [x] All plugin frontmatter keys loom-prefixed (`FM` registry: `loomType`, `loomDate`, `loomRelationships`, …), legacy spellings still read; automatic idempotent startup migration rewrites keys, seeds `loomName`+alias, renames files to the convention — `src/types.ts`, `src/fm.ts`, `src/indexer.ts` (`migrateFiles`), `src/main.ts`
- [x] **Sync-safe writes** (vaults in Dropbox/iCloud/…, especially open on two machines at once): the startup migration decides every change against the cached frontmatter and only writes notes that actually differ (`applyFmMigration` dry run — `processFrontMatter` always rewrites the file, so the old unconditional pass re-uploaded the whole vault on every load and the two machines' collisions came back as conflict copies); `stampModified` never re-stamps a change that already moved `loomModified` (`knownModified`), which is what makes the cross-machine write ping-pong structurally impossible; managed-name collisions skip instead of appending " 2", " 3", … (numbered duplicates multiplied without bound once both machines produced them); sync conflict files are never indexed (`isSyncConflictPath`); renames are skipped when the target name isn't fully known yet (unresolved parent/origin links); startup waits for the metadata cache and a quiet vault before migrating (`waitForVaultSettled`) and an automatic run wanting more than `BULK_RENAME_LIMIT` renames defers to the new **Apply managed file names** command; the map's deleted-note scrub waits out a sync's delete-then-recreate — `src/indexer.ts`, `src/main.ts`, `src/types.ts` (`parseTimestamp` also accepts Date), `src/views/map-view.tsx`
- [x] Creation modal rework: event modal gains an optional Session search (tag with ✕ once picked; unspecified = lore event) and an Involve… search with type filter + chips; quest modal quest giver became the same search+chips (multiple givers), Received session a search→tag, Outcome/Outcome-session dropped (new quests are always active), Description added after Reward — `src/project.ts`
- [x] Character pages: Events section replaces Session notes — "+ Add an event" pre-involves the character; the section shows full session-page-style hub rows (`hubEntryRow`, shared with session pages) for every event involving the character, nested under one session chip per session (input-height chip; session-less lore events group under "No session", last); removing the character themself from an event's involved list warns that the event will disappear from the page — `src/views/entity-view.tsx`, `src/project.ts`
- [x] Quest and event pages: session-note rows gain a Location… picker right of Involve… (writes `location` relationships on the note's entity, chips with ✕); everywhere (session hub + these rows) Involve and Location are two side-by-side columns with each picker's chips wrapping directly beneath it, pickers uncapped to the full 400px column — `src/views/entity-view.tsx`, `styles.css`
- [x] Location session notes with places: inside a location/sublocation's session note, allow picking one or several locations/sublocations; the note propagates up every ancestor level grouped under the same session + labeled with the sublocation it came from (City → Tavern → Hidden door: a Tavern note shows in City too)
- [x] Free placement for unconnected nodes: drops persist y alongside x (`graphManualY`, rename/delete-migrated like manualX); honored only for fully-unconnected nodes, live-reflow included — `src/settings.ts`, `src/graph/layout.ts`, `src/views/graph-view.tsx`, `src/main.ts`
- [x] Entity pages: the type chip in the header is tinted with the entity's node color (from graph settings) — src/views/entity-view.tsx
- [x] Creation modal tags as segmented pill buttons (— / PC / NPC / Cast; rounded outer corners, shared inner borders, accent fill when picked) — `src/project.ts`, `styles.css`
- [x] Map view (started) — a spatial alternative to the graph where locations sit in *relative space*. Now its own drawing canvas (`VIEW_MAP`), not a reworking of the graph's locations layer. See the dedicated **Maps** section below for the built vs. pending checklist.
- [x] Timeline: "No date" side panel — full drawer height, slides out of the strip's left edge behind a vertical toggle bar that mirrors the timeline drawer's bar (whole bar toggles, centered chevron, width animates, edge strip drag-resizes 120–400px; open/width remembered in-session); holds dateless session-less events, empty state says "No event with unspecified date or session"; always mounted (mounting mid-drag cancelled HTML5 drags). Event bubbles drag: onto a session column to pin (session-note pins retarget in place so their text survives; event- and session-side relationships move too; body [[links]] get a Notice), onto the panel to unpin AND clear the date, within its own list to reorder with live feedback — pointer-based dragging (no native DnD): the grabbed bubble sticks to the cursor freely on both axes (so it can leave its column for another session/the panel), a dashed translucent **ghost** previews the exact landing slot (replaces the old drop-zone outline), and siblings slide one slot at a time. Racing-free: the dragged bubble is `pointer-events:none` so the `elementFromPoint` hit test reads the column underneath rather than the bubble's origin, and sibling positions/insertion index are measured from a **snapshot taken at drag start** (live rects would chase the sliding bubbles in a feedback loop). Persisted in `settings.timelineManualOrder`, rename/delete-migrated. Left-button drag on empty space pans within scroll bounds; Ctrl+wheel scrolls horizontally (native non-passive listener), plain wheel vertically; right-click opens a create menu (new event pinned to the clicked session, or with a session picker on empty space); session-to-session moves confirm first, "Confirm timeline moves" toggle (Graph tab) skips — `src/views/timeline-strip.tsx`, `src/views/graph-view.tsx`, `src/settings.ts`, `src/main.ts`, `styles.css`
- [x] Location session notes: drag-reorder entries (grip + live slide, like the sublocation list); every note carries a creation/reorder stamp (seq) so appending lands at the group's end and the order reads identically on every ancestor page — src/views/entity-view.tsx, src/indexer.ts
- [x] Session pages as connection hubs — delivered by the event-driven revamp: Notes body removed, "+ Add an event" / session-note is the primary action with place + involved pickers, and every note surfaces (end-to-end editable) on each involved entity's page. Superseded the original session-note model — `src/views/entity-view.tsx`
- [x] Location pages: event-driven history — location pages show the Events section (events placed here via `places`, including descendant sublocations, segmented by session); the location-side session-note editor is retired (own-`sessionNotes` editor is gated to `record.type === 'event'` only) — `src/views/entity-view.tsx`
- [x] Involved entities moved off relationships and into the session note itself (no dual-read) — extend `sessionNotes` entries with an `involved` link list (mirroring how events are edited on session pages); on an event's own page, each session-note row shows the session (date) picker with the same Involve search bar to its right and the colored chips list on the next row; the session-page hub reads/writes the same per-note `involved` list, so both views stay one data model
- [x] Quests are event-driven, not note-authoring: quest pages get the same Events section as characters/items/factions/locations (`showsEvents` includes `quest`; a quest is `involved` in the events that advance it, "+ Create new event" pre-involves it), losing their own editable session-note section (event pages keep theirs); the session-page hub is relabelled **Events** with the Quests subsection and "+ Add a quest" removed (quest owners filtered out); creating a quest from an event note's Involve search prefills "Received in session" with that note's session (`CreateEntityModal.receivedSession`) — `src/views/entity-view.tsx`, `src/project.ts`, `src/types.ts`, `src/indexer.ts`
- [x] Quest Objectives: an Objectives section after Tags (`loomObjectives` frontmatter, ordered `{ name, finishedOn? }`) split into Active (no session) / Resolved (a "Finished on…" session picked like Received-in-session); "+ Add objective" appends a row, active rows drag-reorder with live sliding; `finishedOn` links are hidden (`loomobjectives` in `HIDDEN_LINK_KEYS`) — `src/types.ts`, `src/indexer.ts`, `src/views/entity-view.tsx`, `styles.css`
- [x] Session-page Quests split into three groups (Active / Resolved this session / Resolved previously) computed as of the session's date; "Resolved previously" is capped by a new Entities-tab → Quests setting (`sessionResolvedQuests`: 3/6/9/12/All, default 6, newest by outcome date, shows "N of total" when capped) — `src/settings.ts`, `src/views/entity-view.tsx`
- [x] Quest Reward field became a `MarkdownField` (multi-line, links — a reward `[[item]]` connects in the graph); creation modal Reward is a wide textarea — `src/views/entity-view.tsx`, `src/project.ts`
- [x] Graph side panel: description renders through the read-only `MarkdownField` (links/formatting, not plain text); reciprocal typed relationships collapse to what the selected node declares (A→B "husband" hides B→A "wife" on A's panel) — `src/graph/side-panel.tsx`, `src/views/graph-view.tsx`
- [x] Graph layout: events stack under sessions in `loomSeq` (session-note) order via a shared longest-path grid, so a shared event aligns across every session it's in (columns leave gaps); quests stack vertically under their session instead of spreading across one row; a leading pad pushes the timeline right so wide global rows center under it rather than left-aligning at the margin — `src/graph/layout.ts`
- [x] Graph zoom-out floor dropped to 0.02 (effectively unlimited for big graphs) — `src/views/graph-view.tsx`
- [x] Graph search Prev / All / Next: All fits every match, Prev/Next zoom to each result in reading order (first Next → first match, first Prev → last), with an n/total counter — `src/views/graph-view.tsx`
- [x] Graph filter "Focus on entities": a searchable multi-select (leftward-opening dropdown, clickable chips) restricts the graph to the picked entities plus their level-1 neighbors (what a left-click focus shows, unioned across picks — no deeper hops, which would pull in the whole interconnected graph). A **Render** segmented toggle switches in-place (hide the rest) vs separate graph (re-lay-out just the subgraph via `restrictTo`). Picks pulse with a synced, zoom-independent (screen-space) node-colored ring — `src/views/graph-view.tsx`, `src/graph/layout.ts`, `src/columns.ts`
- [x] ~~Graph: drag an event node up/down within its session stack to reorder it~~ — **cancelled**: tried imagining the gesture; reordering by dragging inside the graph doesn't feel natural, and the graph gets too big/complex to manage such precise actions. Reordering stays on the timeline drawer + session page.
- [x] Sublocation chips show full ancestry ("Secret room, Tavern, City"), toggisable via Entities-tab → Locations → "Full ancestry on sublocation chips" (`subChipFullAncestry`, default on); `locationLabel`/modal `locLabel` walk the chain; location pickers list top-level locations above sublocations (`mainLocationFirst`) — `src/settings.ts`, `src/views/common.tsx`, `src/views/entity-view.tsx`, `src/project.ts`
- [x] Location page "Factions" section: characters serving each faction at this location (reverse of the membership `location`), grouped by faction, read-only; each faction's members hang off a vertical nesting rail (shared `loom-event-nest`) beneath the faction chip — `src/views/entity-view.tsx`, `styles.css`
- [x] Entity-page section order — Events (a big section) is now the LAST content section on every page, with only Relationships + Connected entities after it. The shared `eventsSection` node is rendered in one unconditional spot at the bottom (was two conditional placements, `!isLocation`/`isLocation`), so page-specific sections above it render first: item pages put the reverse Characters/Locations holder lists after Notes and above Events; location pages keep Notes → Factions → Items → Sublocations → Events; character pages keep Faction(s) + Items above Notes. A single global order can't unify all pages (character puts Items above Notes, location below), so those stay inline above Notes — `src/views/entity-view.tsx`
- [x] Location page section order: Notes → Factions → Items → Sublocations → Events (the Events hub, shared by every entity page, is extracted to a `eventsSection` node and rendered at the bottom for locations, in its usual near-top spot elsewhere) — `src/views/entity-view.tsx`
- [x] Character-page faction role field widened 2× — `styles.css`
- [x] Group-page notes render as plain text (read-only markdown field: no caret, no input box; caret suppression applies to every read-only field incl. the graph side-panel) — `src/views/markdown-field.tsx`, `src/views/group-view.tsx`, `styles.css`
- [x] Session mini-graph reaches one hop through connected events, so it also shows the entities involved in the session's events — `src/views/mini-graph.tsx`
- [x] Event creation modal gains a Locations picker after Involved (writes the starting note's `places`) — `src/project.ts`
- [x] Session-page add-event modal: a picked existing event shows its description read-only, and its per-session-note involved/group/places are written into the new session note (`pinExisting`) — `src/project.ts`
- [x] Timeline no-date panel: resize handle moved to the toggle bar's outer (timeline-facing) edge — `styles.css`
- [x] Cascade delete: `purgeEntityReferences` strips a deleted entity from every other note's frontmatter (relationships, members, involved/group/places, items, quest givers, attendance, sublocation order, objective finish sessions, and scalar link fields) before trashing — body `[[links]]` left intact; wired into all delete paths — `src/project.ts`, `src/views/list-view.tsx`, `src/views/entity-view.tsx`
- [x] Link completions also suggest by native `aliases` (inserting the real target) — `src/views/entity-view.tsx`
- [x] Editor: Tab indents (nests bullets) instead of leaving the field; completion still accepts on Tab when open — `src/views/markdown-field.tsx`
- [x] Editor: Ctrl+B / Ctrl+I (Ctrl+U already worked) — verified working in Obsidian. Obsidian grabs Ctrl+B/I (global bold/italic) before CodeMirror, so the focused-field app Scope is the only layer that can intercept them; Ctrl+U reaches CodeMirror directly. Both the Scope and a CM `keydown` handler call one guarded `applyFormatting` (a `WeakSet` keyed on the physical event stops a double toggle when a key hits both paths), replacing the two independent `toggleWrap` bindings that could cancel each other out — `src/views/markdown-field.tsx`
- [x] Editor: nesting rail visual on sub-bullets — a tab-indented bullet hides its raw indent; the line's padding restores the indent and a faint vertical rail is drawn per ancestor level (one line at the start of each indent step), so nested bullets read as an outline like Obsidian's live preview — `src/views/markdown-field.tsx`, `styles.css`

## Maps (in progress)

A spatial drawing canvas per project — zones (polygons) associated with locations, an alternative to the graph organized around place. `src/views/map-view.tsx`, `VIEW_MAP`.

- [x] Foundation: `VIEW_MAP` + `MapView` registered; "Maps" on the home wheel **and the nav rail** right after Locations (`map` icon, `mapsColor`); a Maps shortcut on the Locations list toolbar; `mapsColor` in settings under a renamed "Other colors" section (with the Loom button); the **camera is remembered per project** (`settings.mapCameras`) — `src/main.ts`, `src/views/home-view.tsx`, `src/views/common.tsx`, `src/views/list-view.tsx`, `src/settings.ts`, `src/types.ts`
- [x] Zone drawing: pen tool; click to place vertices, close by clicking the first vertex (≥3), live dashed fill preview; draggable vertices to reshape a selected zone; pan/zoom canvas — `src/views/map-view.tsx`
- [x] Interaction split: **left-drag** a zone body moves it, a **left-click** selects it for editing (vertex handles, if unlocked) — no menu; **right-click** opens the context menu. Menus are icon-only (bare icons, hover-tint, no button box — `.loom-view .loom-map-icon-btn` beats Obsidian's base button; only `aria-label`, no native `title`, so no double tooltip), anchored above the cursor, and close on left-click/Esc (no close button). A zone menu is **world-anchored so it follows the zone** when grip/drag-moved
- [x] Zone menu (right-click; a node's right-click falls through to it — no separate node menu), grouped with vertical separators (`grip loc │ size style lock │ delete`): grip is a grab-cursor drag handle (no hover box); an inline **location `SearchableSelect`** (auto-focused, prefilled when changing, eraser-clear) that becomes a clickable **`EntityChip` link** (opens the location page) + a square-pen "change" once associated (fixed-width group so the menu stays one size); a **node-size** S/M/L/XL dropdown; a **palette** icon popping a Color(rectangular swatch) + Opacity(+reset) sub-panel; lock; delete (standard danger hover). Global menu: a vertical list (icon + short label + chevron per row), not bare icons — "Draw a zone" / "Background image"
- [x] The location **node is draggable within its zone** (`clampToPolygon`); nodes render in a **separate layer on top of every zone**. **Sizing blends world-fixed → screen-space** via `squish` (`nodeUnit = (1 - squish) * scale + squish / camera.k`, applied `* nodeUnit` to nodes/pins/labels/ghost; strokes + vertex handles stay screen-space): at regular/close-up (`squish 0`) markers are a fixed world size — the page's **element scale** — that scales with the map, and crossing into node view (`squish 1`) they grow to their old constant on-screen size (`preset / camera.k`) so node view is unchanged
- [x] **Scale slider** (top-left, 3 stops — Close up / Regular / Node view) **coupled to the camera zoom**: the mode is derived from `camera.k` (`CLOSEUP_K`/`NODEVIEW_K`), so wheel-zooming flips the mode automatically, and clicking a stop eases the zoom to that mode (`MODE_K`, `animateCameraK`); zooming past Node view still works (mode just stays). A **find-a-location search** above it (solid field bg) pans to a picked node. **Close up**: main node see-through (`CLOSEUP_NODE_OPACITY`). **Node view**: each zone **squishes/warps into its node** and vanishes (`squish` eased animation), leaving just the nodes; **unassociated zones fade in a light-grey placeholder node** (opacity tied to `squish`); **dragging a node in node view moves its whole zone**
- [ ] Sublocation node sizing: a node's size = its zone's `nodeSize` (main default **M**), each nesting level **one step smaller** with a **minimum** floor (so sublocations-of-sublocations don't vanish); sublocation nodes are **canvas-sized** (scale with zoom) and render **behind** the main node — pending the sublocation feature
- [x] **Drawing tweaks**: double-click a zone outline **adds a vertex** (`insertVertexAt`); right-click a vertex handle **deletes it** (polygons ≥3, roads ≥2); **Delete/Backspace** removes the selected zone; **left-click a node selects its zone**
- [x] **Rectangle tool** ("Draw a rectangle", `square`): press-drag defines an axis-aligned 4-vertex zone (`finishRect`, live `rectPreview`) — `src/views/map-view.tsx`
- [x] **Vertex alignment + multi-select**: **Ctrl+drag a vertex** axis-locks it (X/Y by dominant direction); **Ctrl+drag empty space** marquees vertices (`selectVertsInBox`/`selectedVerts`) that then move together — `src/views/map-view.tsx`
- [x] **Node double-click opens the location page**, middle-click opens it in a new tab (`openLocation(target, newTab)`); the location picker skips a location already placed on the active map (`usedLocations`) — `src/views/map-view.tsx`
- [x] **Multiple map pages per project** (`MapsPanel`): left navigator that slides on hover + pins open, name search, new-map, inline rename, right-click Menu (New inside / Rename / Delete), **drag-to-nest** (`parentId`, cycle-guarded). Panel stays open during menu/rename (`forceOpen`); new map creates with an empty name → inline rename with cursor focused, blank/Esc auto-names **"New map N"** (lowest free), duplicate names prompt a de-dup suggestion; new maps open at regular zoom. Storage is `Entities/Maps/<Project> Maps.json` (`MapsFile`/`MapPage`, `parseMapsFile`) — `src/views/map-view.tsx`, `styles.css`, `src/views/entity-view.tsx`
- [x] **Doors** (`MapZone.doors`): a `door-open` popover in `ZonePanel` links a zone to other map pages (page `SearchableSelect` excluding active + a list); each door draws a 🚪 marker in the zone (draggable), **double-click / list-click opens the target page** (`switchMap`) — `src/views/map-view.tsx`, `styles.css`
- [x] Consolidated the three draw tools into one `square-dashed` button → Obsidian Menu (Rectangle / Polygon / Road); the location picker de-dups (skip a location already on the active map) — `src/views/map-view.tsx`
- [x] **Road tool**: "Draw a road" global-menu entry (`route` icon) draws an **open centerline** (right-click / Enter / **double-click last vertex** finishes — not closed), rendered as a **width-stroked path** (a long box that bends: outline + fill round-joined strokes at `width`). A road is a **full zone with a different draw method** — it takes a location/node/size/color/lock and squishes into its node in node view like any zone; `distToPolyline`/`clampToCapsule` treat its body as a capsule; **Width** slider (roads only) in the palette popover — `MapZone.kind: 'zone'|'road'` + `width` — `src/views/map-view.tsx`
- [x] Cursor turns to a pointer over a zone outline / road body (`loom-map-edge-hover`), matching vertex-handle hover; zone color picker is a wide horizontal rectangle (`appearance:none`) — `src/views/map-view.tsx`, `styles.css`
- [x] Zones associate a **main location only** (`locationOptions` filters `parentLocation === null`); entity-page "Turn to a sublocation" **warns + deletes** the location's map zone when it becomes a sublocation — `src/views/map-view.tsx`, `src/views/entity-view.tsx`
- [x] **Undo / redo** (map-local): `Ctrl+Z` / `Ctrl+Shift+Z` (+`Ctrl+Y`), field-focus guarded — a `zones` snapshot `history` ref, discrete actions push before-change snapshots and drag/slider gestures coalesce to one step (`snapshot`/`beginPending`/`commitPending`, `HISTORY_CAP`) — `src/views/map-view.tsx`
- [x] Combo searches (`SearchableSelect` + `SuggestInput` → `.loom-combo-*`) render as a **plain edge-to-edge list** (no per-item button chrome), matching Obsidian's native suggestion popup — `styles.css`
- [ ] **Sublocations panel** (zone menu "list" button → sub-panel, columns **Title | Node**): Title = clickable `EntityChip` link; Node = checkbox (checked ⇒ sublocation shows as a node in the zone); chips are **drag-and-drop** (ghost on cursor, drop inside the zone places the node); **Add all** (warn `"There is not enough space for all sublocation nodes in this zone"` when it won't fit) and **Remove all** (confirm `"This will remove all sublocation nodes from the zone."`, button `"Yes, remove"`). Introduces sublocation nodes → wire in the sizing rule above
- [ ] **Items panel** — same Title|Node panel for a location's items (checkbox, draggable chips, add/remove all). PREREQ: confirm/implement **item inheritance up the location ancestry** on entity pages (a sublocation's item should surface in ancestor locations' Items section, noting which sublocation holds it — `src/views/entity-view.tsx` + `src/indexer.ts`)
- [x] **Size dropdown fixes** (`ZonePanel` S/M/L/XL select): no longer clipped to the 28px icon-btn width (was hiding the selected value and overlapping neighbours) — it's a plain inline `.loom-map-size-btn` select now, hover-tint only, showing the current S/M/L/XL
- [x] Persistence: `Entities/Maps/<Project> Maps.json` (multi-map `MapsFile`, debounced) — maps belong under `Entities/` with the rest of the project's content, not in a folder beside it. A one-shot migration moved existing stores there (and their `Maps/Images`, rewriting stored `MapImage.path` prefixes); **that migration code has since been deleted** — every vault had moved, so it was dead weight, and the new path is now the only one read. `mapsFilePath`/`mapsImagesPath`/`findMapsFile`/`countMapPages` are exported from map-view and used by entity-view's zone scrub and home-view's count — `src/types.ts`, `src/views/map-view.tsx`, `src/views/entity-view.tsx`, `src/views/home-view.tsx`
- [x] **Node single-click opens a focus graph in the map** (`FocusGraphLayer`, replacing the old sublocation-tree `SubGraphLayer`): the location's connected entities (`focusNeighborhood` in `mini-graph.tsx` — focus + `getConnections` + one event hop, so sessions come in via events) rendered in **WORLD space** (sibling `<g>` under the camera transform, full opacity) so it pans/zooms with the map while the map camera `<g>` stays dimmed to 0.12. Laid out in a **maps-specific vertical hierarchy** (`focusLayerOf`: region straight above → focus + main locations → sublocations → items → quests → characters → factions → events → sessions), main-graph-style routed edges (see the entry below), **checker row stagger** when labels would overlap. **Grows out like a web** on open (local rAF `prog`, per-layer stagger) and plays the **reverse animation on close** (`focusClosing` keeps it mounted until `prog`→0). A short `NODE_DBL_MS` manual double-click opens the page (so open/close clicks aren't swallowed). Double-click a node opens it, click the focus node / Esc hides — `src/views/map-view.tsx`, `src/views/mini-graph.tsx`, `styles.css`
- [x] **Roads track a moved location**: whole-zone translate (grip/`zone-move` + node-drag in node view) routes through `translateZoneWithRoads`, shifting the endpoint of every road attached to that location so roads stay connected; a road's own node re-`clampToCapsule`s onto the reshaped centerline — `src/views/map-view.tsx`
- [x] **Region hulls morph instead of snapping**: per-cluster hull resampled to a fixed ring (`resampleRing`/`ringCentroid`), matched frame-to-frame by nearest centroid (biggest cluster keeps its key), an rAF eases each display ring toward its target in node view — a cluster split retracts the surviving border and grows a new one out of the split-off centroid ("rip + hug back"); a vanishing/merged cluster fades (`alpha`) and shrinks its pad so it disappears behind the node instead of leaving a circle — `src/views/map-view.tsx`
- [x] **Orphaned map nodes cleaned up on entity deletion**: `vault.on('delete')` removes sub/item pins + unassociates zones/roads pointing at the deleted entity across all pages; the loader also drops orphaned pins (index-ready guarded) — `src/views/map-view.tsx`
- [x] **Focus-graph connections follow the main graph's grammar**: the hand-rolled `focusElbow` is gone — cross-row edges are routed `fan`s (diagonal exit → vertical trunk lane → optional horizontal run in the band above the target row → diagonal entry fanned across the target's side) and same-row pairs are `rowU`s, both rendered through the shared `edgePoints`/`roundedPath`. Parallel lines keep a minimum distance: trunks whose row spans overlap are swept apart by `FG_LANE_GAP`, and horizontal runs / U lanes get separate y-lanes via `laneIndices` (greedy interval coloring) with band heights grown to fit however many lanes a row needs. Multi-row trunks step clear of the nodes they pass (`FG_TRUNK_CLEAR`) — `src/views/map-view.tsx`
- [x] **Focus graph is sized in unit space**: the layout is computed in units (`FG_*`) and multiplied by the page's **element scale** at render, so it's proportional to the map it grows out of. Open/close animations shortened (420 / 260 ms) — `src/views/map-view.tsx`
- [x] **No focus graph in node view**: the map already *is* a node graph there, so a second one on top was noise. A node click in node view only selects, and zooming out into node view retracts an open graph. (It's also why the graph takes `scale` rather than `nodeUnit` — a retraction across the squish crossfade would otherwise balloon.) — `src/views/map-view.tsx`
- [x] **Element scale per map page** (`MapPage.scale`, "Elements" popover in the top-right controls, `ruler` icon): the anchor the map was missing. Everything on a map is relative, so a page now carries **world px per size unit** — it multiplies every world-fixed marker (nodes, pins, labels, new road widths, the road-width slider's range) and **divides the view-mode zoom thresholds** (`CLOSEUP_K`/`NODEVIEW_K`/`MODE_K`/`MIN_ZOOM`/`MAX_ZOOM`), so Close up / Regular / Node view land where the map's own geometry says. Existing pages **infer** it from what's already drawn (`inferScale`: median polygon zone reads ~`REF_ZONE_UNITS` regular nodes across), so old big-zone maps need no redrawing; a log slider + a wand button re-fit it, and a new page inherits the current one's — `src/views/map-view.tsx`, `styles.css`
- [x] **Node size per node** (not just per zone): sublocation nodes and item pins carry an optional `size` (`MapZone.subPins[].size` / `itemPins[].size`) overriding the zone-derived default, set from a **right-click menu on the marker itself** (`openPinMenu`: Size S/M/L/XL + Default size, open, remove from map) — `src/views/map-view.tsx`
- [x] **Search flies the camera** instead of snapping: picking a location in the find-a-location field eases the camera there (`flyTo`, ease-in-out, zoom unchanged) — `src/views/map-view.tsx`
- [x] **Road width keeps its contents**: changing (or resetting) a road's width re-fits its own location node, doors, item pins and sublocation nodes into the new body (`reclampToWidth`), so narrowing no longer strands them outside the road — `src/views/map-view.tsx`
- [x] **Background images** (`MapPage.images`, `MapImage`, `parseImages`): the global menu's "Background image" row opens a **second page of the menu** (not a native submenu, which silently capped at 20 items and could run off the view): a back row, "Import image…" (a hidden file picker copies into `Entities/Maps/Images`, de-duplicating the name so an existing backdrop is never overwritten), and **every** already-imported file to place again without a second copy — thumbnailed, searchable once past 6, scrolling inside a fixed height, and flipped to whichever side of the cursor has room (`IMAGE_PICKER_W`/`_H`). Thumbnails are **downscaled and cached**, never the raw file: a 28px `<img>` of the real image still decodes it in full (~36 MP ≈ 145 MB each — 32 of them meant ~4.6 GB and a frozen panel), so `buildThumb` decodes straight to 64px via `createImageBitmap`'s `resizeWidth` into a data URL cached by path+mtime, built only when a row scrolls into view and one at a time (`ImageThumb`/`thumbQueue`). An image lands **centred on the menu point at its real pixel size** (1 image pixel = 1 world unit — trace over a scanned map, and the element-size readout says how big a node is against it). It always renders as the **bottom layer**, under every zone/road/marker, and is `pointer-events:none` so the svg's own hit-testing (zones first, then images) decides every press.
  - **Resize keeps the aspect ratio**: eight grips (`IMAGE_HANDLES`/`imageHandlePos`/`resizeImage`) — corners anchor the opposite corner, edges anchor the opposite edge and grow centred — derive the width from whichever axis was pulled furthest and take the height from the natural ratio. Each whole side also carries an invisible wide drag band (`imageSidePoints`, `pointer-events:stroke`), so grabbing the **edge** resizes and not just the square at its midpoint; per-handle resize cursors via `IMAGE_GRIP_CURSOR`. Grips render in the same **top layer** as vertex handles, so zones drawn over a backdrop can't cover them.
  - Selection outline is screen-sized (stroke width *and* dash divided by the zoom, no `vector-effect`) and shows for **any** clicked image, locked ones included — it's the only hint that a locked image's edge is where its menu answers. Its class is `.loom-map-image-box`, deliberately not `.loom-map-image-sel > rect`: that also matched the grip rects and, out-specifying `.loom-map-vertex`, made every grip click-through.
  - **Locked = backdrop only**: its interior counts as empty space (left-drag pans the camera exactly like a locked zone, right-click gives the global menu, nothing to grab), and only the **edge band** (`IMAGE_EDGE_PX`, `hitImage(..., 'menu')`) opens its own menu — flagged by the same `loom-map-edge-hover` cursor.
  - Menu (`openImageMenu`, ObsidianMenu): Lock/Unlock, Reset to real size, Opacity 100/75/50/25%, Bring to front / Send to back, Remove from map (the file stays in `Maps/Images`). Delete/Backspace removes a selected image; Esc deselects.
  - Undo covers images: a history step is now the page's whole drawable state (`MapState = {zones, images}`), so undoing an image move can't roll back a zone edit — `src/views/map-view.tsx`, `styles.css`
- [x] **Waypoints mode dropped** (icon removed from the global menu): the in-map focus graph already answers "what is this place connected to", and anyone wanting the full web has the main graph, where every connection is already laid out. A half-baked third graph wasn't worth it — `src/views/map-view.tsx`
- [x] **Zone popovers scroll instead of truncating** (sublocations / doors / items): the whole list renders, wrapped in `.loom-map-subs-list` (`max-height` ≈ the old ten rows, `overflow-y: auto`) with the search box and column head pinned above it — the panel keeps the size it had and the `…` more-row is gone — `src/views/map-view.tsx`, `styles.css`
- [x] **Maps counter on the home wheel**: the Maps satellite now carries a count like every other one — the project's map PAGES. They aren't notes, so it can't come from the index: `countMapPages`/`mapsFilePath`/`legacyMapFilePath` (exported from map-view) read the Maps JSON, and `useMapPageCount` re-reads it on any vault create/modify/delete of that path — `src/views/home-view.tsx`, `src/views/map-view.tsx`
- [ ] **Scaling + view-mode thresholds still aren't right** (element scale / "Elements" ruler helped but didn't solve it). Deliberately parked — revisit as its own pass.
  - What exists: `MapPage.scale` multiplies every world-fixed marker, and the three modes are derived from the camera zoom by dividing fixed constants by it — `camera.k >= CLOSEUP_K / scale` → close up, `<= NODEVIEW_K / scale` → node view, else regular (`CLOSEUP_K = 0.7`, `NODEVIEW_K = 0.08`, slider targets `MODE_K`, limits `MIN_ZOOM`/`MAX_ZOOM`, all in `src/views/map-view.tsx`).
  - Why it's still off: those constants were tuned by feel for one map, and `inferScale` is a single-number guess (median polygon zone ≈ `REF_ZONE_UNITS = 5` regular nodes across). One scalar can't express both "how big is a marker" *and* "at what zoom should zones collapse" — a map of a few huge continents and a map of many small rooms want different threshold *ratios*, not just a different scale.
  - Directions to weigh (don't just re-tune the numbers): derive the thresholds from the map's actual content instead of constants — e.g. node view starts when the median zone's on-screen size drops below N px, close up when it exceeds M px, which is scale-free by construction; and/or split the one `scale` into a marker scale and an independent set of threshold stops; and/or let a page pin its own thresholds (the ruler popover is the natural home). Check how it reads on the real campaign map AND a small interior map before committing.

## Project types

A per-project **kind** that reshapes the plugin for a different workflow, chosen at project
creation and switchable in settings, stored in the .loom config. Player mode is the baseline.

- [x] **The kind layer itself** — `src/project-kind.ts`: `PROJECT_KINDS` + meta, per-kind type
  lists (`typesFor`), the anchor/beat **role map** (`roleType`/`roleOf`) and `KindFeatures`.
  `ProjectConfig.kind` in the .loom file (absent = `player`); kind picker in
  `SetupProjectModal`; a **Projects** section on the settings General tab to switch a kind.
  Scaffolding creates only the kind's folders; `EntityTypeSuggestModal`, the nav rail, home
  wheel, graph type filter and graph right-click menu all offer only that kind's types.
  See CLAUDE.md "Project kinds" for the design rule.
- [x] **Roles instead of type literals** in the shared machinery, so one implementation serves
  both chronologies: `columns.ts`, `graph/layout.ts` (its `NodeKind` is now
  `anchor`/`beat`/`global`), `timeline-strip.tsx`, `list-view.tsx`, `entity-view.tsx`,
  `graph-view.tsx`, `group-view.tsx`, `mini-graph.tsx`, `common.tsx`.
- [x] **Player** — the current experience; the default kind, unchanged.
- [ ] **Game Master** — running a campaign. Frontmatter and index are in place
  (`FM.eventKind` / `FM.happened` / `FM.npcLines`, `EVENT_KINDS`, the `eventPlanning` +
  `npcLines` feature flags); **no UI yet**.
  - `planned` — a pre-planned event that *may* happen in a session.
  - `locked` — a planned event ruled out by player action (an NPC it needed is dead), kept
    on file rather than deleted. Likely a cascade: when a required entity dies or is
    removed, dependent planned events auto-lock.
  - `improvised` — an event the GM added during/after the game that wasn't in the "book".
  - `happened` — the tick that turns a speculative planned event into a real one.
  - Most-likely NPC replies: preplanned lines or speech-style examples on the character page.
  - Open questions: how dependencies are declared (which entity's fate locks which event),
    and how the states read on the timeline and graph.
- [ ] **Writer** — authoring/plot planning. Entity types, kind features and terminology are
  in place; the script is not. See "Writer: Fountain script" below.
  - [x] Chapters replace Sessions and Scenes replace Events, as their **own** entity types
    playing the same roles (`Entities/Chapters`, `Entities/Scenes`).
  - [x] Attendance is gone (`attendance: false`), and so is the virtual Group
    (`group: false` — it's the party, built on the PC tag).
  - [x] Chapters order by `loomSeq` rather than by a date (`anchorOrder: 'sequence'`), and
    carry a **Display title** field (`FM.displayTitle`) — see the export note below.
  - [x] Quests and descriptions are kept as-is (game design / main plot pushers).
  - [x] The session graph is the Chapter graph — same code, role-driven label.
  - [ ] Chapter reordering UI (drag to re-stamp `loomSeq`), and a Scene page shell beyond
    the shared one.
  - The Map view is a core part of this kind (spatial level/room layout).

## Writer: Fountain script (in progress)

The script is a **single `<Project>.fountain` file at the project root**, registered like the
.loom home file rather than stored as markdown (`SCRIPT_EXTENSION` in types.ts). Two reasons
it can't be a .md note: Fountain's note syntax **is** `[[…]]`, so Obsidian would index every
non-exporting script note as a wikilink and pollute backlinks and the graph; and an own
extension round-trips byte-for-byte with external Fountain apps (Better Fountain, Highland,
Fade In), which is what makes an "Open in external app" button honest. The cost, accepted:
Obsidian core search only indexes .md, so searching script text needs our own index.

Fountain facts the design has to respect (several corrected during design):

- **Fountain has no page concept.** Pagination is computed by the renderer from fixed
  screenplay metrics (Courier 12, ~55 lines/page, per-element margins). So a scene's page
  range must be **derived, never stored** — which is exactly what makes it shift for free
  when an earlier scene grows.
- **INT./EXT. and time of day belong to the scene, not the location.** The same house is
  `INT. HOUSE - DAY` in one scene and `EXT. HOUSE - NIGHT` in the next. The Scene entity
  stores the actual one (parsed from its heading); a Location page may hold a *default* the
  autocomplete offers first. Separator is a hyphen, not an em dash.
- **Scene numbers go at the end of the heading** (`INT. HOUSE - DAY #7#`); a leading `.` is
  the *forced scene heading* marker. Production numbers are deliberately locked (hence 12A,
  12B), so auto-renumber on reorder needs a "lock numbers" escape hatch eventually.
- **Character detection** is an uppercase line preceded by a blank line **and followed by a
  non-blank line** — that trailing condition is the only thing separating `SARAH` from the
  transition `CUT TO:`. Extensions (`(V.O.)`, `(CONT'D)`) must be stripped before resolving
  to a Character entity; `@` force-marks a name.
- **Sections (`#`) never export.** An act/chapter title that must appear in the PDF has to be
  emitted separately as centered bold (`>**ACT ONE**<`) — hence `FM.displayTitle` on chapters.
- **Title page keys**: Title, Credit, Author, Draft date (plus Source, Contact, Copyright,
  Notes). These live in the .fountain file's own title page — no sidecar needed, exact
  round-trip.

Built so far:

- [x] **Parser** (`src/fountain.ts`): title page (unknown keys and their order preserved),
  full element tokenizer, scene-heading parts, and derived pagination. Dependency-free and
  side-effect-free, so the grammar is testable on its own.
- [x] **Scene ids**: `ensureSceneIds` / `readLoomId` / `stripLoomIds`. Additive and
  idempotent — an existing id is never changed or removed.
- [x] **Script view** (`src/views/script-view.tsx`, `.fountain` registered like `.loom`):
  title-page editor (body stays byte-identical across rewrites), scene outline grouped by
  section with page ranges and cast, "Open in external app", live-preview Fountain editor.
- [x] **Scene → note mirroring** (`syncScenes`): matched by loom id, additive only (a removed
  heading leaves an orphan, surfaced in the view, never deleted), and skipped entirely when a
  note's data already matches, so it doesn't re-upload notes through the user's sync. Ids are
  written on load and on blur, never mid-typing. Scenes get `loomSceneIntExt`/`loomSceneTime`
  plus visible links to their location and cast, so they connect in the graph.
- [x] **Backward compatible import**: dropping an existing script in gives every heading an
  id and creates its Scene notes; characters and locations found in it are matched by name
  and offered as an explicit "create N" button (they're shared entities that may already
  exist, so bulk-creating them on load isn't the plugin's call).

Still to build:

- [x] **Chapters ↔ sections.** A scene's chapter is the TOP-level `#` section it sits under
  (`FM.sceneChapter`, a visible link — which is also what stacks it under its chapter in the
  graph and timeline, since `buildColumns` takes any connection to an anchor). Chapters are
  created automatically from the sections and ordered by first appearance (`loomSeq`), like
  scenes: the script owns them, unlike characters/locations which are shared and stay
  explicit. **A scene must always have a chapter** — the create modal requires it
  (`anchorRequired`), and the script view lists any scene sitting outside every `#` section.
- [x] **Import** (`reattachSceneIds` + the Export menu's "Import a script…"). Replaces the
  script from an OS file picker after a confirmation that spells out exactly what is
  destroyed (the script text) and what is not (every entity — existing characters and
  locations keep their pages and are simply referenced by the incoming script). An incoming
  file that still carries its `[[loom:…]]` markers re-attaches exactly; one that lost them
  (export → edit elsewhere → import) is matched back by heading text, walking in script order
  so repeated headings pair up in sequence. Unmatched scene notes become orphans; nothing is
  deleted.
- [x] **`loomDisplayTitle` reaches the script** as `>**…**<` under its section
  (`applyDisplayTitles`) — idempotent, updates in place. **Falls back to the chapter's own
  name** when the display title is left blank (never drops the line entirely), which is also
  what fixed display titles getting lost on reimport — a blank line meant a reimported script
  had nothing for `reattachSectionIds` (below) to even match against. Written on script commit
  and whenever the field is edited on a Chapter page (`pushChapterTitles`).
- [x] **Chapter (section) reattachment on import** (`reattachSectionIds`, mirrors
  `reattachSceneIds`): an export → edit elsewhere → reimport round trip strips `[[loom:…]]`
  markers from top-level sections too, not just scenes — without matching those back by title,
  every reimport orphaned the old Chapter notes (silently losing their display titles, which
  looked like "chapter names get stripped on import"). Chained after scene reattachment in
  `importScript`; the confirmation dialog reports both counts.
- [x] **Chapter page exposes both Title and Display title, both editable.** A dedicated **Title**
  field (the script's `#` section text) now sits above the existing **Display title**. The first
  attempt at this relabeled the generic top-of-page "Name" field — which turned out to never
  render for chapters at all (chapters take the `isSession`/anchor branch of the page shell,
  which the generic Name block explicitly excludes), so the "fix" was invisible. The real Title
  field is editable (`renameSectionTitle`, `commitChapterTitle`): typing a new title writes into
  the script's `#` line, and `syncScenes` reflects it back into the note's own frontmatter/file
  name. "The script owns names" was always about not authoring a rival copy of the text, not
  about the field being read-only — same relationship the Scene page's modular fields have with
  the scene heading. Along the way, fixed a related gap: `syncScenes`'s chapter-matching only
  ever updated a renamed chapter's `loomName` frontmatter, never its FILE, so the managed name
  and the actual file silently disagreed after any title change (from the script OR the page) —
  `src/fountain.ts`, `src/views/script-view.tsx`, `src/views/entity-view.tsx`
- [x] **Chapter page: scenes are draggable to reorder**, via `reorderScenesInSection` (new) — a
  single atomic rewrite of the whole section's scene order from the full post-drop array,
  rather than reasoning about one "insert before its new neighbor" move. That single-move
  approach (still used for the Scene page's cross-chapter move, where it fits) turned out
  fragile at distance: dragging the 14th of 14 scenes to the front once left only 7 visible.
  `reorderScenesInSection` captures every scene's block in the section up front, removes the
  whole contiguous range in one splice bounded to the section end (never the next chapter — a
  section's LAST scene has its raw `endLine` extended by the parser to whatever scene heading
  comes next in the WHOLE file, chapter boundary or not, so the removal is explicitly capped at
  the next top-level section's line), then reinserts every block in the requested order.
  Verified with a standalone Node harness (fountain.ts has no Obsidian dependency, so `node
  file.ts` runs it directly) against last→first / first→last / reversed / middle→front /
  multi-chapter cases — `src/fountain.ts`, `src/views/entity-view.tsx`
- [x] **Scene production numbers (`#N#`) auto-renumber on reorder** (`renumberScenes`) — a
  drag/move relocates a scene's whole block, number included, which would otherwise leave a
  stale number on the wrong scene; screenwriting convention normally LOCKS these (12A, 12B),
  but the app's own reorder actions keep an already-numbered script sequential instead. Scenes
  with no number are never given one. Folded into `editScriptAndSync` so it rides every
  structural edit automatically. Also: the number now renders as a plain number, not `#7#` —
  the hashes are Fountain source markup, not print convention — `src/fountain.ts`, `src/pdf.ts`,
  `src/views/script-view.tsx`
- [ ] Scene identity across edits: **a hidden `[[loom:<id>]]` Fountain note in the scene
  heading** (decided). Non-exporting by spec, survives any rewrite or reorder, and our editor
  hides it entirely; the accepted cost is that it shows as a small note if the file is opened
  in Better Fountain or a plain text editor. Chosen deliberately over heuristic re-matching:
  a scene renamed *and* moved in one edit would silently detach under heuristics, taking its
  relationships, notes and quest links with it, and a silent data loss is worse than a
  visible token.
  - **Strip the ids on export, never on "Open in external app".** Export produces a *copy*,
    so a clean `.fountain` (or PDF) is right. "Open in external app" hands over the *live*
    file, which the external editor writes back to in place — stripping there would destroy
    every id on the first external save.
  - That leaves exactly one lossy path: export stripped → edit externally → import back over
    the same project. **Heuristic matching (heading text + position + content hash) belongs
    there and only there** — as a recovery fallback for a round trip that already lost the
    ids, not as the primary identity mechanism.
  - A script imported with no ids at all (written elsewhere) simply gets fresh ones on parse,
    which is the same path as the backward-compatible import above — nothing to detach from.
- [x] **Pages are modular editing windows.** A Scene page edits its own stretch of the script
  (`replaceSceneBody` — the heading and its hidden id stay owned by the script, only the body
  is editable), re-assigning its chapter MOVES the block in the script
  (`moveSceneToSection`), and deleting the note removes the scene from the script
  (`removeScene`) — otherwise the next parse would just resurrect it.
- [x] **`editScriptAndSync`** (`src/views/script-view.tsx`, wraps `editScript` +
  `syncScenes`): a structural script edit made from the Scene/Chapter pages (move, reorder,
  reword the body, rewrite the heading) used to leave the note's own derived fields (chapter
  link, location, cast, script order) stale until the Script view was next opened and
  committed — which is what made "move to another chapter" look broken. Every scene-mutating
  call site in `entity-view.tsx` now goes through this instead of bare `editScript`, so the
  note agrees with the script immediately.
- [x] **Reordering scenes within a chapter moves them in the script** — see the Chapter-page
  bullet above (`reorderScenesInSection`).
- [x] **Modular chapter move + reorder, two-step — and drag ≠ commit.** The Scene page's chapter
  picker doesn't move on pick: step 1 picks the target chapter, step 2 shows that chapter's
  scene list with the current scene inserted as the only draggable row, defaulting to the TOP
  of the list (`movePlaceAt` state, seeded to 0 on every fresh pick). Dragging only updates that
  pending position — it does NOT fire the move (the first cut instantly moved the scene on
  drop, giving no chance to readjust); an explicit **"Move the scene"** button commits whatever
  position is currently shown, via `moveSceneBefore`/`moveSceneToSection`, which is also what
  reassigns its chapter (no separate field to keep in sync) — `src/views/entity-view.tsx`
- [x] **Scene page: modular, editable heading.** Four fields replace the old read-only heading
  text — an INT./EXT. autocomplete (type-ahead + arrow-key cycling, `SuggestInput` in
  `common.tsx` gained arrow-key highlight navigation for this), a Location field, an optional
  Sublocation field, and a free-text Time field — writing straight back into the script heading
  via `setSceneHeadingParts` (new in `fountain.ts`, rewrites just the editable parts, leaving
  the production number and hidden loom id exactly as they were). **Location/Sublocation ARE
  the linked entity's Name field**: editing text on an already-linked location/sublocation
  renames that entity everywhere (same as every other Name field in the app) rather than
  creating a duplicate; nothing linked yet falls back to matching-by-name-or-creating. Changing
  the main location while a sublocation stays linked **reparents that same sublocation** rather
  than spawning a second one. `splitLocationSub`/`joinLocationSub` (new in `fountain.ts`) split/
  compose the heading's location text into main + sublocation (first ` - `, mirroring the
  time-of-day split's LAST-`-` convention) — used both here and by `syncScenes`, which is now
  sublocation-aware itself (previously a compound heading location like `CAFE - COUNTER` never
  matched any location by its flat name, so `sceneLocation` silently stayed empty for any scene
  with a sublocation; `syncScenes` now auto-creates missing sublocations exactly like it already
  auto-created missing top-level locations) — `src/fountain.ts`, `src/views/script-view.tsx`,
  `src/views/entity-view.tsx`, `src/views/common.tsx`
- [x] **Location page shows its Scenes** — a location's own scenes (`sceneLocation` resolves
  here directly) plus a "Scenes in sublocations" group (same layout as "Items in sublocations"),
  read-only, sitting where Events would on a non-writer project's location page. Uses the SAME
  row layout as the Chapter page's scene list (see below) — `src/views/entity-view.tsx`
- [x] **Scene page script editor: a real, fixed height, not a resize handle.** It first looked
  capped at ~24em despite `height: 297mm` on `textarea.loom-scene-script`: an older,
  higher-specificity rule (`.loom-view .loom-scene-script`, two classes vs. one class + one
  element) still carried a stale `max-height: 24em` from when this box was a read-only
  `<pre>`-style excerpt, and CSS specificity doesn't care which rule is more specific to the
  CURRENT purpose — it always wins on selector weight. Removed from the older rule. Full A4
  (297mm) then turned out too tall in practice; rather than an arbitrary `* 0.7`, it's set to
  **210mm — A4's own WIDTH**, which lands at the same ~70% by definition (ISO 216's 1:√2 ratio
  means a sheet's width is already ~70.7% of its height) — a real measurement of the same paper
  rather than a made-up fraction.
- [x] **Chapter/Location page scene rows: fixed-width columns.** INT./EXT. now sits in its
  native reading position (before the title, not after — it had been tacked on after the link);
  the number and INT./EXT. columns are fixed-width (`loom-scene-row-num` 3ch right-aligned,
  `loom-scene-row-intext` 4.5em) instead of borrowing the Script outline's `.loom-script-scene-num`
  (which relies on an external grid-template it doesn't have in a plain flex row), so a
  double-digit scene number no longer shifts every title's start position — `styles.css`,
  `src/views/entity-view.tsx`
- [x] **Real character/dialogue/parenthetical indentation, finally.** The Pages preview was
  rendering everything flush left despite `.loom-sp-character`/`.loom-sp-dialogue`/
  `.loom-sp-parenthetical` all declaring their own `margin-left` — `.loom-screenplay p` used the
  `margin` SHORTHAND (`margin: 0 0 1em`), which sets all four sides at once, and its extra `p`
  type selector gave it higher specificity than the `.loom-sp-*` rules (2 classes each, no
  type) — so it silently won and reset every character/dialogue indent back to 0 regardless of
  what the more-specific-looking rule said. Fixed two ways: the general rule now only touches
  `margin-top`/`margin-bottom` (never left/right, so there's nothing left to fight over), and
  every `.loom-sp-*` selector gained a `p.` prefix so it ties the general rule on specificity —
  a tie resolves by source order, and these come later in the file, so they correctly win on
  `margin-bottom` too (the tight character→dialogue spacing) — `styles.css`.
- [x] **Backslash-escaped `\*`/`\_`/`\\` render as the literal character**, not with the
  backslash leaking into the output (`Colour\_DP-01` — a real screenwriter convention for "this
  underscore isn't an underline delimiter" — used to print verbatim, backslash included).
  `renderInline` (fountain.ts) and `plainText` (pdf.ts) both swap escaped sequences for a
  Private Use Area placeholder before the emphasis-stripping regexes run, then restore the
  literal character afterward — not plain digits (could collide with real numbers already in
  the text) or a literal control character (trips ESLint's `no-control-regex`).
- [x] **Fixed a real duplicate-entity bug found via a live script**: the Script view's one-time
  "assign ids + sync scenes" pass on load reads `plugin.indexer`'s CURRENT contents to decide
  "does a note for this id already exist?" — but if this view is restored as part of Obsidian's
  own workspace-layout restore, that can happen before the plugin's own startup index rebuild
  has populated anything, so every scene looks new and gets a full duplicate set of Scene/
  Character/Location notes (the managed file names dodge the collision with a " 2" suffix, but
  the loom ids are true duplicates). Now awaits `plugin.indexer.rebuildNow()` first — the same
  guard the startup migration already uses for the identical reason — `src/views/script-view.tsx`.
- [x] **Scene page: chapter section is two columns.** Chapter management (pick/move) stays on
  the left; a right column lists **Characters in the scene** (`loomSceneCast`, read-only —
  editing means writing the dialogue that names them, not this list) as chips. Same flex +
  vertical-separator shape as the quest page's grid (`loom-quest-grid`) — `styles.css`,
  `src/views/entity-view.tsx`.
- [x] **Scene page's own Script section gained the Script/Pages preview + search mechanism**
  from the main Script view, scoped to just that scene's excerpt — the same segmented pill,
  the same search-with-prev/next-and-count toolbar (selecting/scrolling the match in Script
  mode, highlighting via the shared `highlight()` — now exported from script-view.tsx — in
  Pages mode), and the same `.loom-sp-*`/`pdfPages` rendering, parsed from just the scene's own
  text rather than the whole document (so "page 1" here means the start of the excerpt, not
  the scene's real position in the full script) — `src/views/entity-view.tsx`.
- [x] **Scene/Chapter entity lists gained dedicated columns**: a counter as the first column for
  both, INT./EXT. right after it for scenes (always rendered, even blank, so a forced heading
  with no INT./EXT. doesn't shift every title's start position), and a **Characters** column
  (chips, click to open) after the title — a chapter's cast is the union of every scene under it
  (chapters carry no cast field of their own). Reuses `loom-scene-row-num`/`loom-scene-row-intext`
  from the Chapter/Location page's scene rows rather than inventing new column classes. The
  counter is each entity's position in canonical SCRIPT order (ascending, ignoring whatever
  sort/direction is currently on screen) — a fixed property of the entity, not "which row
  happens to be drawn first": the first cut recomputed 1..N from the top on every reorder, so
  reversing the sort direction relabeled every row instead of flipping which number landed on
  which row (the last scene read "1" while ascending) — `src/views/list-view.tsx`, `styles.css`.
- [x] **Scene page polish**: the chapter/characters two-column grid gained its own
  flex-column gap (they're plain divs, not `.loom-field`, so they weren't getting the
  breathing room every other field block gets for free) — `styles.css`. The Pages preview
  (both the main Script view and the scene's own) now explicitly sets `user-select: text` on
  the page — some ancestor Obsidian gives its own custom `ItemView` content a default of
  `user-select: none`, which the preview had been silently inheriting, blocking text
  selection. The scene's own Pages-preview search now actually scrolls to the match on
  Prev/Next (there's no offset-to-page mapping to compute here, since the excerpt isn't laid
  out against the whole document — instead it scrolls the Nth `<mark>` in the DOM into view,
  since marks render in the same reading order as the match list) — `src/views/entity-view.tsx`.
- [ ] **Chapters can't be created or reordered from the app** — only by writing a `#` section
  in the script. "Add a chapter" should insert a section (with a fresh `[[loom:…]]`), and
  reordering chapters should move their whole section blocks.
- [ ] **Deleting a scene from the file explorer** (rather than from its page) still leaves it
  in the script. The page's Delete handles both; a `vault.on('delete')` listener would need
  the record's `sceneId` cached before the record is dropped from the index.
- [ ] **A chapter deleted from its page doesn't remove its `#` section** (and would strand its
  scenes). Needs a decision first: delete the scenes with it, or move them out?
- [x] **Live-preview Fountain editor** (`src/views/fountain-field.tsx`, a new CM6 field replacing
  the plain textarea in Script mode): per-element-type line decorations computed by re-parsing
  the doc on every change (`parseFountain` — dependency-free, cheap enough to run per keystroke)
  and mapping each `FountainElement`'s line range to a `Decoration.line` class
  (`loom-fountain-scene-heading`/`-character`/`-dialogue`/`-parenthetical`/`-transition`/
  `-section`/`-synopsis`/`-centered`/`-lyrics`/`-page-break`). The hidden `[[loom:…]]` marker on
  scene headings and sections is hidden the same way `markdown-field.tsx` hides its own syntax
  (`Decoration.replace({})`), never touching the underlying text. Three `autocompletion`
  sources (`@codemirror/autocomplete`, `override` so nothing else competes): INT./EXT./EST.
  prefixes at the start of a blank line, character names (from `parsed.characters`) on a line
  preceded by a blank line, and location names (from `parsed.locations`) right after a typed
  scene-heading prefix. Imperative `selectRange`/`focus` (via `useImperativeHandle`) replace the
  old manual `textarea.setSelectionRange`/`scrollTop` math the search-jump and line-jump callers
  used. Character/location names stay **plain text in the file** — the plugin renders them
  specially, it never rewrites the script to add markup.
- [x] **Live-preview editor polish, from first-use feedback**: styling is `#fff`/`#000` fixed
  (not theme tokens) — same reasoning as the Pages preview's `.loom-screenplay-page`, this reads
  as a sheet of paper, not an ordinary editor pane. `.cm-content` is capped to `max-width: 6in`
  and centered — the PDF's own `TEXT_W` (`pdf.ts`), so character/dialogue/parenthetical indents
  are the real `LAYOUT` table's inch values applied directly (2.2in/1in/1.6in, with matching
  right padding so dialogue and parenthetical wrap at the real printed width), not an arbitrary
  em guess. Transitions gained `text-align: right` (a bare `>` forces one and had no visible
  effect before — it just looked bold). **Inline emphasis is now painted, deliberately WITHOUT
  hiding the delimiters** — `scanEmphasis` finds `**bold**`/`*italic*`/`***both***`/`_underline_`
  spans (escaped `\*`/`\_`/`\\` masked to same-length placeholders first, so a real backslash
  escape can't be mistaken for a delimiter, mirroring `renderInline`'s technique) and marks the
  WHOLE span — delimiters included — with the matching style class; this is the opposite choice
  from `markdown-field.tsx`'s "raw only at the cursor" model, made on purpose because seeing
  which literal characters are producing the formatting is the actual point of a screenwriting
  editor. **Chapters and scene locations are now clickable too**, alongside character cues:
  a scene heading resolves through the SCENE note's own `sceneLocation` field (sublocation-aware,
  matched by the heading's hidden `[[loom:…]]` id, never by heading text) rather than trying to
  parse the raw location text into an entity; a `#` chapter heading resolves by the section's own
  loom id against `EntityRecord.chapterId`. Both are new optional `onOpenLocation`/`onOpenChapter`
  props resolved in `script-view.tsx`, mirroring `onOpenCharacter`. **Script/Pages mode now keeps
  your place across the toggle** (`switchMode` in `script-view.tsx`): leaving Script reads
  `FountainField.getTopLine()` (via `EditorView.lineBlockAtHeight`) and maps it to a page through
  the existing `pageOfLine`; leaving Pages reads the scroll-tracked `currentPage` and maps it back
  to a line through the new inverse `lineOfPage`, stashed in a ref and applied by
  `FountainField.scrollToLine()` once the CM6 view remounts (it's torn down and rebuilt on every
  mode switch, so the scroll can't be applied inline the way the pages-preview scroll can be).
- [x] **Second round of live-preview feedback**: the mode-switch scroll above animated across the
  whole document every time — `.loom-screenplay`'s own `scroll-behavior: smooth` means
  `scrollIntoView({behavior: 'auto'})` still defers to that CSS and animates anyway, so the
  restore now passes `'instant'` specifically, leaving ordinary jump navigation (Prev/Next, the
  page field, search) smooth as before. **The Scene page's own Script section now uses
  `FountainField` too** (`src/views/entity-view.tsx`), replacing its separate plain textarea —
  the exact ask behind this was "can main script and scene script listen to the same formatting
  code," and the answer is the same component, fed the SAME project-wide
  `parsed.characters`/`parsed.locations` (parsed from the whole script, not just the scene's own
  slice, so the autocomplete offers every name in the project) and the same `onOpenCharacter`.
  Its Pages preview already shared `pdfPages`/`renderInline`/`highlight` with the main Script
  view; only the Script-mode editor itself hadn't been switched over yet. **Autocomplete now
  offers its full list the moment the cursor LANDS on a valid empty line** (an empty INT./EXT.
  or character-cue position, preceded by a blank line or the document's first line) rather than
  waiting for a first keystroke, matching Better Fountain — CM6 only auto-activates completion on
  typing, so an explicit `startCompletion` call was added to the update listener, gated on a new
  `emptyCueLine` check so it never fires while the user is mid-typing elsewhere. **Orphan/widow
  prevention** (`ORPHAN_WORDS`/`findOrphanPairs`/`preventOrphans`, fountain.ts): a short "glue"
  word (article, one-letter word, short preposition/conjunction) left alone at the end of a
  wrapped line — "...what does a" / "swear mean..." — is glued to the word after it instead.
  Pages preview (both the main Script view and the Scene page's) glues with a real non-breaking
  space via `preventOrphans` before `renderInline`, since it's throwaway generated HTML; the live
  editor can't safely alter the document text, so `findOrphanPairs` instead returns the pair's
  span for a `white-space: nowrap` mark decoration (`loom-fountain-nowrap`) — same word list,
  same matching, two different glue mechanisms for two different surfaces. **Not yet covering the
  actual exported PDF** — `pdf.ts` computes its own line wrapping from character-width math
  rather than letting a browser wrap HTML, so fixing orphans there means teaching that wrap loop
  the same rule directly, not reusing either glue mechanism; parked. Nav panel widened 17em →
  29em (~1.7×) and its scene rows gained a `button` type selector plus explicit
  `justify-content: flex-start`/`text-align: left` — the class-only selector was losing a
  specificity fight against Obsidian's own default button styling, the exact bug category this
  codebase already hit once with `.loom-sp-*` (see the CSS-specificity note in the file map).
- [x] **Third round of live-preview feedback**:
  - **Nav panel shows the FULL section tree**, not just chapter → flat scene list: a new
    `navTree` (script-view.tsx) walks `parsed.sections` + `parsed.scenes` merged and
    line-sorted with a stack of currently-open sections (mirroring the parser's own
    `sectionStack`), so a scene between two sibling `##` subsections stays under whichever
    actually precedes it and content keeps real reading order — a `NavItem` union
    (`{kind:'scene'}` / `{kind:'section', node}`) per node rather than separate
    scenes/children arrays, which would have rendered "every scene, then every child
    section" instead. Recursive `renderNavNode`; depth 2+ sections get a `.loom-script-nav-sub`
    modifier (lighter weight) and indent one step via `.loom-script-nav-children`.
  - **Scene page's Script/Pages toggle now scroll-syncs**, same as the main Script view:
    `scenePageOfLine`/`sceneLineOfPage` (entity-view.tsx) mirror `pageOfLine`/`lineOfPage` but
    against `sceneBodyPages` (`pdfPages` on just this scene's excerpt). The tricky part: the
    editor edits `sceneDraft` (body only, heading stripped by `sceneBodyOf`'s `.trim()`), while
    `sceneBodyPages` is paginated against the full `sceneExcerpt` (heading included, since
    that's what's actually rendered) — two different line-numbering origins. `sceneBodyLineOffset`
    is computed once (1 + however many leading blank lines `.trim()` ate) to translate between
    them, since that offset isn't a fixed constant. The scene preview has no page-number
    readout/state the way the main view does, so `currentScenePage()` reads the visible page
    straight from the DOM on demand (same top-third-of-viewport logic as the main view's scroll
    listener, just not kept as continuous state) rather than adding a whole tracking effect
    for a value only needed at the moment of switching.
  - **Fixed a real off-by-one**: `pageOfLine`'s exact-match loop checked `el.line === line`,
    which never matches a line landing mid-way through a merged multi-line `dialogue` element
    (the one element type that joins several source lines into one, `\n`-joined) — the cursor
    would fall through to the "first element after this line" fallback and could land a page
    later (or, combined with the scroll-sync work above, effectively a page off) than the one
    actually showing that line. Fixed by checking the element's whole span
    (`line >= el.line && line < el.line + elementSpan(el)`, matching the identical span check
    already in `fountain-field.tsx`'s decorations) instead of just its start line. Applied to
    both the main Script view and the new scene-page equivalent.
  - **Scene heading preview showed only Location - Sublocation - Time**, dropping the
    INT./EXT. prefix entirely — the `loom-field-hint` string just never included `sceneIntExt`.
  - **Clearing the Sublocation field now asks before deleting** ("Delete "\<name\>"
    sublocation?") instead of silently detaching it from the heading and leaving the note
    itself orphaned in the vault forever. Cancelling reverts the field immediately (set back to
    the old name before the modal even opens, so it never sits visually empty while the vault
    still points at the old note); confirming deletes the note via `purgeEntityReferences` +
    `trashFile`, the same pair every other delete-with-confirm flow in this codebase uses.
  - **Renaming an already-linked Location/Sublocation now confirms first too** — `resolveOrRename`
    (entity-view.tsx) gained a `confirmDialog` step ("Rename "X" to "Y"?") before calling
    `renameEntityRecord`, since that entity may be referenced by OTHER scenes and a heading edit
    silently renaming it everywhere was a trap. Returns `null` on cancel, which the caller
    (`commitSceneLocation`) treats as "abort the whole commit and revert whichever field(s) were
    mid-rename" rather than proceeding half-decided. `confirmDialog` itself is a small
    Promise-wrapping shim around `ConfirmModal` (which only takes a fire-and-forget onConfirm)
    for the handful of call sites that need to branch on the answer instead of just reacting to
    confirmation.
  - **Character list gained "Sort: appearance"** (list-view.tsx): a character's first CUE line
    in the project's script (`parseFountain(scriptText).elements`, first `character`-type
    element per name — already extension-stripped by the parser, so it matches `EntityRecord.name`
    directly). Only offered once a script actually exists (`useScriptText`, called
    unconditionally per the rules of hooks but only fed a real project when `type === 'character'`,
    so every other entity type does zero script-reading work). `compare()` took an optional
    `appearance` map parameter for this one mode; characters absent from the script (mentioned
    only in action text, or not written yet) sort after every one that appears, then fall back
    to name.
  - **Autocomplete's inserted text landed the cursor at the START of the insertion, not the
    end** — CM6's default behavior when a completion's `apply` doesn't specify an explicit
    `selection` is to map the OLD cursor (sitting exactly at the insertion point) through the
    change using its default assoc, which sticks it BEFORE new text rather than after; the
    INT./EXT. completion already set an explicit `selection` and worked correctly, but
    character and location completions didn't. Fixed by adding explicit `selection` to both:
    location lands right after the inserted name (ready to keep typing the rest of the heading);
    character lands at the **start of the next line** (inserting one if the cue was the
    document's last line), since a cue is immediately followed by its dialogue.
- [ ] Plain-writing mode: keep Fountain syntax and it formats; write plain prose and it stays
  prose (valid Fountain — it's all Action), just without the automatic scene counter.
- [x] **Narrative branching** — classic linear Fountain has no branch syntax, and the
  `.BRANCH …` forced-heading convention tried first gets misread by other Fountain tools as a
  new top-level scene rather than nesting under the real one. Landed on a **plugin-specific,
  structural-only convention**: sibling sections tagged `= branch: <group-id>` (Fountain's own
  non-exporting synopsis line) directly beneath a `##`/`###` heading, no new entity type —
  `ensureSceneIds` extended to id branch-tagged sections at any depth (not just level-1), and a
  Scene's own `loomSceneBranch` (a raw id, not a link — no Branch note to point at). Reads as a
  plain nested outline with an ordinary note in any compliant Fountain tool. The Script view's
  nav tree (`buildNavTree`) attaches a branch section under the nearest scene seen so far rather
  than the enclosing chapter, and a scene heading always closes any open branch frame (a branch
  holds prose, never a scene of its own) — the fix for branch sections rendering as flush
  top-level entries instead of nesting under their scene. `applyBranchLabels` prints each
  branch's own title as a centered-bold marker on export, mirroring `applyDisplayTitles` for
  chapters. **Not done**: Chapter page's scene-list grouping by branch (deliberately skipped —
  scenes structurally can't nest inside a branch under this convention, so it would rarely
  trigger, and the drag-reorder code it'd touch is deliberately fragile-adjacent/well-tested);
  a full choice-point UI (e.g. visually distinct branch node styling beyond the nav panel's tint)
  is still just the nav-panel treatment, nothing dedicated in the graph/timeline.
- [x] **Inline entity links** (`@[Name|Display]`) — a Character/Faction/Location/Item can be
  referenced from anywhere in the script text (not just a scene's heading or CHARACTER cues),
  bracket-delimited since a name can contain spaces/punctuation. Live editor shows raw-at-cursor
  (like a wikilink), `@Display` elsewhere; strips to plain text on every export/render path.
  Feeds `sceneFactions`/`sceneItems`/`sceneMentionedLocations` derivation and merges a mentioned
  character into `sceneCast`. Resolution is autocomplete-pick only, never auto-create.
- [x] **Writer-project Scene/Chapter page parity** — "Entities in the scene" (grouped
  Characters/Factions/Locations/Items, collapsing to one column when empty) replaces the old
  characters-only column; a Quest section (Active/Resolved-this-Scene-or-Chapter/Resolved
  previously) now also renders on Scene pages, with quests resolving against Scenes (script
  order) rather than Sessions/Chapters in a Writer project; the Chapter page gained its own
  Script/Pages-preview section; a Scene page's own mini nav panel shows its internal branching.
- [x] **List view Involved/Location filters fixed for Scenes, added for Chapters** — the filters
  silently no-op'd for Scenes (same role as Events, but no `sessionNotes` field to read) and
  never appeared for Chapters at all; now branch on `type`, read the script-derived scene
  fields, and aggregate across a Chapter's own scenes. Involved is now multi-select.
- [x] **Scene numbering (`#N#`) now cascades** — inserting a scene before an already-numbered
  one used to leave it unnumbered and everything after untouched (by design, matching real
  screenwriting's "production numbers are locked" convention) — now, once any scene in the
  script carries a number, every scene from the start of the document through the last
  currently-numbered one joins the sequence automatically, renumbered on every commit
  (including plain typing in the main Script view, not just structural drag/move actions).
- [x] **Home wheel hover / nav scroll-to-top** — wheel satellites shrink at rest and scale up
  (whole button, not just a background tint) on hover; nav-panel and search jumps in the script
  editor now scroll the target to the TOP of the viewport instead of CM6's default "nearest"
  strategy landing it at the bottom.
- [ ] **Pre-scene descriptions (e.g. "TEXT OVER BLACK")** — action text written before the
  first scene heading currently has nowhere to show outside the Script view itself. Parked
  deliberately for a dedicated design conversation — nothing implemented.
- [x] **Real PDF export** (`src/pdf.ts`) — a hand-rolled writer, no dependency, affordable
  because a screenplay is Courier-only (a PDF standard font: nothing to embed, monospaced so
  no metrics needed). Correct typeset geometry, widow control, title page, page numbers.
  `pdfPages` is the single pagination source, so the in-app preview and the exported file
  agree page for page. **Page-break (`===`) syntax actually forces a page break**: `layoutPages`
  used to flatten `paginate()`, which drops `page-break` elements entirely for the soft/estimate
  pagination — the real typeset layout now walks `parsed.elements` directly and starts a new
  page on one. **Production scene numbers (`#7#`) render at the right margin**, not inline after
  the heading text — `FountainElement` carries `sceneNumber` as its own field now rather than
  leaving it embedded in the heading's display text.
- [x] **Dialogue lines merge into one paragraph**, per the Fountain spec — the parser used to
  emit one `dialogue` element per physical line, which rendered every manually-wrapped line of
  the same speech with a full paragraph gap between them; consecutive non-parenthetical lines in
  a cue block now join into a single element (still split by any parenthetical in between).
- [x] **Export / import / open, in one `⋯` menu.** *Export as PDF…* and *Export as
  .fountain…* both go through a real OS save dialog (`showSaveFilePicker`, so an export can
  land outside the vault), falling back to a download then to writing beside the script.
  *Open in the default app* / *Show in system file manager* — **Electron exposes no
  cross-platform app-chooser dialog**, so those are the honest two, and both hand over the
  LIVE file so ids are never stripped there.
- [x] **Pages preview + search + script navigation.** A **Script / Pages preview** segmented
  pill (`.loom-seg`, the same style as the creation-modal tags) switches panes; the preview
  shows one page at a time, its page-number readout now **tracking manual scroll** too (not just
  the Prev/Next buttons — a scroll listener reads whichever page is topmost); a shared search
  works in both panes. The navigation panel is a **zero-height sticky wrapper** (`position:
  sticky` inside the scrolling shell body) so the toggle — and the open panel — stay reachable
  regardless of how far the title-page/toolbar above the editor has scrolled, instead of
  scrolling away with them. The Script-mode textarea's manually-resized height is **remembered
  per file** (`localStorage`, a UI preference — not vault data) instead of resetting on reload.
  The search box is a **fixed width**, not `flex:1` — Script and Pages preview carry different
  sibling controls in the toolbar, so a flexible box changed width switching modes, breaking
  the illusion that it's the same element. Fixed a nav-jump off-by-one (`pageOfLine`): its
  fallback — used whenever the target line has no rendered element of its own, e.g. a `#`
  chapter heading, which never reaches the page — picked the LAST page whose first element
  preceded the target line, which under-shoots by one page whenever what follows starts fresh
  on a NEW page; now finds the FIRST page containing anything strictly after the target line.
  A scene-heading's production number renders as a **plain number** at the right margin, not
  `#7#` — the hashes are Fountain source markup, never print convention. Search's "N of M" /
  "No matches" readout sits AFTER the Prev/Next-match buttons, not before, so those buttons
  don't shift position as the readout's text appears/changes length; the search box is 1.5×
  wider and a fixed width in both modes now (was `flex: 1`, changing size between Script and
  Pages preview since they carry different sibling controls). The page-number input is no
  longer bound straight to the live page (clearing it to type a new number used to immediately
  snap back to the old one, since a controlled input re-fills itself the instant it goes empty,
  before a new digit can land) — it now holds its own draft text and only jumps on Enter; an
  emptied-then-abandoned field (blur, or Enter with nothing typed) just reverts to showing the
  current page, no jump. The `⋯` script-actions button is a burger (`menu`) icon, not
  horizontal dots.
- [x] **Backslash-escaped `\*`/`\_`/`\\` render as the literal character**, not with the
  backslash leaking into the output (`Colour\_DP-01` — a real screenwriter convention for
  "this underscore isn't an underline delimiter" — used to print as `Colour\_DP-01` verbatim,
  backslash included). `renderInline` (fountain.ts, used by the Pages preview) and `plainText`
  (pdf.ts, the PDF/print path) both swap escaped sequences for a placeholder BEFORE the
  emphasis-stripping regexes run, then restore the literal character afterward — the
  placeholder is a Private Use Area code point (`\uE000`), not plain digits or a NUL byte:
  digits could collide with real numbers in the text, and a literal control character in a
  regex trips ESLint's `no-control-regex`.
- [x] **Deleting a Scene/Chapter note now removes its backing block from the script too** —
  previously only the Scene page's own delete button did this (and only for scenes); every
  delete entry point (entity page, both `list-view.tsx` delete paths) now goes through one
  shared `deleteScriptEntity` (script-view.tsx). Deleting a Chapter cascades: every Scene note
  that pointed at it (`sceneChapter`) is trashed too, since the chapter's script block held
  their headings — `src/fountain.ts` (`removeChapter`), `src/views/script-view.tsx`,
  `src/views/entity-view.tsx`, `src/views/list-view.tsx`
- [x] **Scene/Chapter creation unified onto one modal**: the entity list's "New scene"/"New
  chapter", the Script view's own toolbar buttons, and a session row's context-menu add all now
  open the same `CreateEntityModal` branch instead of the Script view separately prompting for
  a bare name — `appendScene`/`appendChapter` fire FIRST (so the script anchor exists before the
  note does) and the note is stamped directly, letting the modal open the real page immediately.
  Scene modal: a heading row (INT./EXT., Location, optional Sublocation, Time — search-existing-
  or-create-new for the two location fields) and a mandatory Chapter picker with a pinned
  "+ New chapter" entry that opens a NESTED chapter-creation modal and returns to the scene
  modal on completion, rather than navigating away mid-flow. Chapter modal: Title → Display
  title → position (toggle "Append to the end", off reveals a chapter list with the new one as
  the single draggable row, positioned via `reorderTopSections`) → Notes. The old
  Involved/Locations/Date fields (meaningless for a script-derived scene) are gone from the
  Scene modal — `src/project.ts` (`renderSceneModal`/`renderChapterModal`)
- [x] **Scene/Chapter pages: Description → Notes, Date dropped from Scene, Quests section
  hidden when empty**. The generic `loomDescription`-backed "Description" field is gone from
  both pages (redundant with the script itself) in favor of the freeform body-backed "Notes"
  section every other entity type already has (Chapter gained that section for the first time).
  A Scene's Date field (meant for Events, inherited via the shared `beat` role) is hidden — a
  script-order scene has no date of its own. The Quests section only renders when at least one
  quest actually resolves against the page (Session pages keep showing it empty) —
  `src/views/entity-view.tsx`

## Next session (committed)

- [x] **Custom views**: named saved graph views (`SavedGraphView` in settings.ts, persisted per project as `settings.graphViews`) — each captures the type filter, the focus-entity restriction (+ render mode), and the pinned node world positions. A "Saved views" popover in the graph header (bookmark icon) lists them: click a name to apply (restores filter/focus/pins in one shot), per-row update-to-current / rename / delete, and "Save current as view" — `src/settings.ts`, `src/views/graph-view.tsx`, `styles.css`
- [x] **Custom created / modified fields**: loom-managed `loomCreated` / `loomModified` frontmatter, written in Obsidian's **Date & time** property format (`YYYY-MM-DDTHH:mm:ss`, local) and registered as `datetime` in the vault type registry on load (`metadataTypeManager.setType`, guarded pre-1.13 API) so they render in the datetime picker. Authoritative over the filesystem ctime/mtime (which cloud-sync can overwrite with the sync time): stamped at creation (`buildEntityContent` / `createItemCopy`), seeded from ctime/mtime for existing notes in the startup migration (which also normalizes any older-format value), and `loomModified` re-stamped on every edit via the single `metadataCache.on('changed')` handler (`stampModified`, loop-guarded by a per-path `lastStamp` so the write's own echo and migration writes don't recurse). The record's `created`/`modified` prefer the frontmatter timestamps, falling back to the stats. Timestamps are loom-owned only (`legacyFmKeys` returns none for them, so a foreign bare `created`/`modified` is never adopted/deleted) — `src/types.ts` (`FM.created`/`FM.modified`, `parseTimestamp`, `formatTimestamp`), `src/indexer.ts`, `src/project.ts`, `src/main.ts`
- [x] **"Animate graph" — "Start time-lapse animation"** (for fun): a play/stop button in the graph header replays node-creation history — nodes **grow in** along a smooth ease-out curve (`animGrow`, no bounce) and **glide floatily** toward their target (`ANIM_FLOAT`, momentum-free exponential ease — no spring overshoot/oscillation) in `loomCreated` order while the force layout **re-runs on the growing revealed subset** (so connections form live and positions shift as pull forces change, rather than snapping to their final home), and the camera **re-frames every revealed node** ("fit all") each time more appear. **Duration scales with node count** (`clamp(total*ANIM_MS_PER_NODE, ANIM_MIN_MS 1.8s, ANIM_MAX_MS 15s)` — small graphs finish quickly, huge ones cap out) and the **reveal rate follows an ease-in-out curve** (`animEase`, slow→fast→slow, softened with a linear term so the ends don't drag). Reveals batch into ≤`ANIM_MAX_STEPS` layout recomputes; the final batch settles to the exact normal `layout` so there's no end jump (unconnected nodes return to their last/manual position). Mid-animation, **isolated nodes (no revealed neighbor) are bound near their nearest node** (`bindIsolated`) so they cluster with the visible graph instead of hovering alone at a far final home, then a **separation pass pushes those bound nodes out of overlap** with each other and the connected cluster (connected anchors stay fixed). Edges **draw in** once both endpoints have grown — the line grows from both ends toward the center and meets in the middle (`GraphEdge` `draw` prop via a centered `stroke-dasharray` over a `pathLength=100` path; arrows land at completion), and the run stays active until the last batch's edges finish drawing. Node interaction is suspended while it plays — `src/views/graph-view.tsx` (`startAnimation`/`animStep`/`finishAnimation`, `AnimState`, `animEase`, `bindIsolated`, `scale` prop on `GraphNode`)
- [x] Graph drop-to-connect fix: the drop hit-test used each candidate's layout home (`n.x`+disp) instead of its rendered position, so dropping onto a **pinned** node only registered near its off-screen home, not its visual center — now uses `pos(n)` (pin-aware) — `src/views/graph-view.tsx`

## Brainstorm / undecided (no committed design yet)

- [ ] **Node icons / shapes in the graph** — beyond plain circles: an icon or shape per node, e.g. a skull on a death event, distinct marks for "big" events. Not urgent; keep the idea on file. (Would extend the graph node render + a per-entity/per-event icon source.)
- [ ] **Date system rethink** — dates + custom calendars exist but were added before a clear use emerged (everything works off sessions' natural dates, so the custom calendar is unused so far). Needs a real application and possibly a bigger model: the timeline is **linear** today — what about **multiple / parallel timelines** (time-travel stories, parallel character arcs across different timelines that interconnect)? Complex; no clear vision yet — brainstorm before building.
- [ ] **Design polish pass** — some copy and visual details aren't dialed in yet (deferred deliberately while features had priority). Collect the rough spots and do a focused design/UX pass once the feature set settles.

## Regions (in progress)

A grouping layer above main locations — gather locations under a territory without making
them sublocations. `region` entity type. See CLAUDE.md "Regions" for the design.

- [x] `region` entity type + page (location-page shell, a **Locations** member section instead
  of Sublocations, events inherited from members via `placeInThisRegion`) — `types.ts`,
  `indexer.ts`, `project.ts`, `src/views/entity-view.tsx`
- [x] Locations get a **"Part of region"** field (all locations, after "Sublocation of";
  "Not specified" when empty; `FM.region`, typed `region` connection, `regionOrder`)
- [x] Region color auto = darker(location color) (`syncRegionColor`/`darkenHex`), no config;
  regions reuse `EntityChip`; in `GLOBAL_TYPES` (graph) but not map nodes
- [x] **Location list groups under Regions**: each main location nests under its Region (or a
  synthetic "Unspecified Region"), sublocations still nest under their parent; falls back to the
  flat list when no region is in use. Region rows get their own right-click commands (Add location
  / New location in region) — `src/views/list-view.tsx` (`UNSPEC_REGION`)
- [x] **Maps auto-wrap** (node view only): a region draws a padded **convex hull** around each
  cluster of its locations' nodes; members clustered by proximity (union-find, threshold = 2.5×
  the map's median nearest-neighbour spacing) so far-apart members wrap **separately** (one hull
  per cluster, labelled, double-click opens the region). Color = darker(location), fades in with
  the squish — `regionClusters`/`regionHull`/`convexHull`/`clusterPoints` in `src/views/map-view.tsx`
- [ ] Region "Locations" section drag-reorder (currently add/remove + `regionOrder` list, no
  drag UI yet — mirror the sublocation drag machinery)

## Guided tutorial / onboarding (planned)

An in-app guided tutorial that teaches the plugin's features, on by default for new users.

- [ ] **Guided overlay**: a transparent black scrim with a cut-out/highlight window over the
  UI area being taught, plus an explanation card (text + next/skip). Steps walk the user
  through the app and prompt them to *try* things (create a test character, link two entities,
  draw a zone, etc.).
- [ ] **Lessons**: grouped into separate lessons — one per entity type/page, plus Graph,
  Timeline, and Maps. Each lesson is independently completable/skippable.
- [ ] **Enabled by default**; a lesson that's **completed or skipped never auto-pops again**.
  Persist per-lesson status (`todo` / `completed` / `skipped`) in settings.
- [ ] **Progress window** openable via an Obsidian **command** — lists every lesson with its
  status and lets the user (re)start any of them.
- [ ] **Cleanup**: an option to **delete all tutorial-created pages** (tag/track the notes the
  tutorial makes) so the user can continue with a clean vault.
- [ ] Design notes: keep the overlay accessible (Esc to exit, focus trap), don't block real
  work, and make the highlight follow layout/scroll. Tutorial-made entities should be clearly
  marked (e.g. a `loomTutorial` frontmatter flag) so cleanup is exact.

## Code health

- [ ] **Dedicated code-efficiency audit** — because features were built in a fragmented, token-budgeted way (reading/writing code in slices, not the whole tree), duplicated/mergeable logic and dead code can accumulate unnoticed. Periodically spend a whole session scanning the full project for consolidation, dead code, and shared-helper opportunities. (`/simplify` covers changed-code cleanups; this is the broader whole-tree pass.)
