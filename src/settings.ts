import {
	App,
	ButtonComponent,
	Notice,
	PluginSettingTab,
	Setting,
	SettingDefinition,
	SettingDefinitionItem,
	TFile,
	setIcon,
} from 'obsidian';
import { ENTITY_TYPES, EntityType, GLOBAL_TYPES, GraphCamera, entityLabel, entityPlural } from './types';
import { DEFAULT_PROJECT_KIND, PROJECT_KIND_META, PROJECT_KINDS, projectKindLabel, typesFor } from './project-kind';
import { ConfirmModal } from './project';
import { TimelineSettingsEditor } from './timeline-settings';
import { POLAR_CHECKOUT_URL } from './license/polar-provider';
import { t, LocaleCode, SUPPORTED_LOCALES } from './i18n';
import type LoomLoomPlugin from './main';

export type LoomTextSize = 'compact' | 'normal' | 'large';

/** A darker shade of a hex color. */
export function darkenHex(hex: string, factor = 0.62): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const r = Math.round(((n >> 16) & 0xff) * factor);
	const g = Math.round(((n >> 8) & 0xff) * factor);
	const b = Math.round((n & 0xff) * factor);
	return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Region has no configurable color — it's always a darker shade of the location
 *  color. Call on load and after any location-color change. */
export function syncRegionColor(settings: LoomLoomSettings): void {
	settings.nodeColors.region = darkenHex(settings.nodeColors.location);
}

/** Graph node radius (px) slider bounds. */
export const NODE_SIZE_MIN = 8;
export const NODE_SIZE_MAX = 44;

/** A named saved graph view: a curated lens over the same graph, capturing the
 *  type filter, the focus-entity restriction, and the pinned nodes so the user
 *  can flip between them from the graph header. */
export interface SavedGraphView {
	id: string;
	name: string;
	/** Ticked entity types (the graph type filter). */
	filterTypes: EntityType[];
	/** Whether unticked types are dimmed or hidden. */
	filterMode: 'dim' | 'hide';
	/** Focus-entity note paths (empty = no focus restriction). */
	focus: string[];
	/** Focus render mode: true = separate subgraph, false = dim/hide in place. */
	focusSeparate: boolean;
	/** Pinned nodes' world positions, keyed by note path. */
	pins: Record<string, { x: number; y: number }>;
}

export interface LoomLoomSettings {
	/** Legacy single-project root (pre-.loom-files); migrated on load, kept for that migration only. */
	projectRoot: string;
	/** Base text size of all plugin views (applied as a body class). */
	textSize: LoomTextSize;
	/** Interface language. 'auto' resolves via `resolveActiveLocale` to
	 *  whichever language Obsidian itself is configured to display in, when
	 *  supported, else English. */
	locale: LocaleCode | 'auto';
	/** Whether bold/italic/underline text and structural headings in the
	 *  Script editor (and its Pages preview) pick up the active Obsidian
	 *  theme's accent color. Off by default — these are plugin-managed
	 *  decorative marks, not native Obsidian markdown, so they stay a plain
	 *  fixed color unless the user opts in to match their theme. */
	followThemeTextColoring: boolean;
	/** Background colors for the built-in quest tags (main / important / side). */
	questTagColors: { main: string; important: string; side: string };
	/** Session page — how many previously-resolved quests to list in the Quests
	 *  section's "Resolved previously" group (most recent by outcome date). 0 = all. */
	sessionResolvedQuests: number;
	/** When true, a sublocation chip shows its full ancestry ("Secret room,
	 *  Tavern, City"); when false, just the sublocation's own name. */
	subChipFullAncestry: boolean;
	/** Graph side panel: sections with more entries than this start collapsed. */
	graphCollapseThreshold: number;
	/** Zoom level a right-clicked node is focused at (both directions — can zoom in or out to reach it). */
	graphFocusZoom: number;
	/** Distance (px) between parallel horizontal connection lines in the graph — keeps them from overlapping. */
	graphLineGap: number;
	/** Distance (px) between parallel vertical connection lines in the graph. */
	graphTrunkGap: number;
	/** Size (px) of the relationship-direction arrowheads on graph edges. */
	graphArrowSize: number;
	/** Which note a generic node-on-node drop edits: the node dropped onto
	 *  ('target' — dropping A on B adds A into B) or the dragged one
	 *  ('dragged' — connecting A to B). Field fills always edit the owner. */
	graphDropEdits: 'target' | 'dragged';
	/** Ask before a timeline drag moves an event from one session to another. */
	confirmTimelineMove: boolean;
	/** Session-grouped lists (event/quest session notes, entity-page events) put
	 *  the newest session on top when true, oldest when false. */
	notesNewestFirst: boolean;
	/** Top-to-bottom row order of the global entity layers in the graph. */
	globalLayerOrder: EntityType[];
	/** Graph node fill color per entity type. */
	nodeColors: Record<EntityType, string>;
	/** Graph node radius (px) per entity type. */
	nodeSizes: Record<EntityType, number>;
	/** Color of the virtual Group — its chips, home-wheel button, page header.
	 *  Its own entity color, distinct from factions. */
	groupColor: string;
	/** Color of the Maps feature — its home-wheel button and default new-zone fill. */
	mapsColor: string;
	/** Home-wheel Loom button colors. 'original' follows the app theme (light
	 *  theme: plum bg / cream icon, dark theme: reversed — via body.theme-dark
	 *  CSS, so it flips live); 'custom' uses the pair below. */
	loomButtonStyle: 'original' | 'custom';
	/** Custom Loom button background (used when loomButtonStyle = 'custom'). */
	loomButtonBg: string;
	/** Custom Loom button icon/label color (when loomButtonStyle = 'custom'). */
	loomButtonIcon: string;
	/** Last camera per project root — not user-facing, remembered across sessions. */
	graphCameras: Record<string, GraphCamera>;
	/** Last map camera per project root — remembered across sessions. */
	mapCameras: Record<string, GraphCamera>;
	/** Drag-reordered x of unconnected global graph nodes, per project root then
	 *  note path — not user-facing. Connected nodes follow their forces instead. */
	graphManualX: Record<string, Record<string, number>>;
	/** Drag-dropped y of fully-unconnected graph nodes, per project root then note path. */
	graphManualY: Record<string, Record<string, number>>;
	/** Pinned graph nodes' world positions, per project root then note path —
	 *  remembered across restarts. */
	graphPins: Record<string, Record<string, { x: number; y: number }>>;
	/** Graph type-filter state per project root: the ticked entity types and the
	 *  dim/hide eye mode — remembered across restarts. */
	graphFilters: Record<string, { types: EntityType[]; mode: 'dim' | 'hide' }>;
	/** Named saved graph views per project root — curated filter/focus/pin
	 *  snapshots the user switches between from the graph header. */
	graphViews: Record<string, SavedGraphView[]>;
	/** Manual vertical order of timeline event bubbles, per project root then
	 *  note path (rank within its column/drawer) — not user-facing. */
	timelineManualOrder: Record<string, Record<string, number>>;
	/** Last timeline-drawer height (px) — remembered across sessions/restarts. */
	timelineDrawerHeight: number;
	/** The user's license key, if any. Deliberately vault-synced (unlike the
	 *  per-device activation state in `license/cache-store.ts`) so it shows up
	 *  pre-filled on every machine sharing the vault — but activating a device
	 *  is always an explicit button click, never automatic on sync, so opening
	 *  the vault on a new machine doesn't silently burn an activation slot. */
	licenseKey: string;
}

export const DEFAULT_SETTINGS: LoomLoomSettings = {
	projectRoot: '',
	textSize: 'normal',
	locale: 'auto',
	followThemeTextColoring: false,
	questTagColors: { main: '#b48b0e', important: '#c95f5f', side: '#58b478' },
	sessionResolvedQuests: 6,
	subChipFullAncestry: true,
	graphCollapseThreshold: 5,
	graphFocusZoom: 1,
	graphLineGap: 10,
	graphTrunkGap: 10,
	graphArrowSize: 8,
	graphDropEdits: 'target',
	confirmTimelineMove: true,
	notesNewestFirst: true,
	globalLayerOrder: ['quest', 'character', 'faction', 'item', 'location', 'region'],
	nodeColors: {
		session: '#7c5cff',
		event: '#e08e45',
		// Writer/Script projects hold Acts/Scenes, Writer/Prose holds just
		// Chapters, where player and GM ones hold Sessions/Events — same
		// anchor structural role, so they start from the same color and can
		// be tuned apart.
		act: '#7c5cff',
		scene: '#e08e45',
		chapter: '#7c5cff',
		character: '#58b478',
		location: '#4aa3d8',
		// Region is not user-configurable — always kept as a darker shade of the
		// location color (see `syncRegionColor`). This is just the initial value.
		region: '#2c6282',
		faction: '#d16d9e',
		item: '#d8b13c',
		quest: '#c95f5f',
	},
	nodeSizes: {
		session: 26,
		event: 20,
		act: 26,
		scene: 20,
		chapter: 26,
		character: 17,
		location: 17,
		region: 17,
		faction: 17,
		item: 17,
		quest: 17,
	},
	groupColor: '#46b5a5',
	mapsColor: '#c9a36b',
	loomButtonStyle: 'original',
	loomButtonBg: '#4c3d57',
	loomButtonIcon: '#fff8e6',
	graphCameras: {},
	mapCameras: {},
	graphManualX: {},
	graphManualY: {},
	graphPins: {},
	graphFilters: {},
	graphViews: {},
	timelineManualOrder: {},
	timelineDrawerHeight: 240,
	licenseKey: '',
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A stored color, kept only if it's a valid 6-digit hex string. */
function parseHexColor(value: unknown, fallback: string): string {
	return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value : fallback;
}

/** A stored `Record<string, GraphCamera>` (graph/map camera positions per project root). */
function parseCameraMap(value: unknown): Record<string, GraphCamera> {
	const out: Record<string, GraphCamera> = {};
	if (typeof value !== 'object' || value === null) return out;
	for (const [root, cam] of Object.entries(value as Record<string, Partial<GraphCamera> | undefined>)) {
		if (cam && typeof cam.tx === 'number' && typeof cam.ty === 'number' && typeof cam.k === 'number') {
			out[root] = { tx: cam.tx, ty: cam.ty, k: cam.k };
		}
	}
	return out;
}

/** A stored `Record<string, { x, y }>` — pinned/dropped node positions keyed by note path. */
function parsePinsMap(value: unknown): Record<string, { x: number; y: number }> {
	const out: Record<string, { x: number; y: number }> = {};
	if (typeof value !== 'object' || value === null) return out;
	for (const [path, p] of Object.entries(value as Record<string, unknown>)) {
		if (
			p &&
			typeof p === 'object' &&
			Number.isFinite((p as { x?: unknown }).x) &&
			Number.isFinite((p as { y?: unknown }).y)
		) {
			out[path] = { x: (p as { x: number }).x, y: (p as { y: number }).y };
		}
	}
	return out;
}

/** A stored `Record<string, Record<string, number>>` — per-project-root maps of
 *  note path -> a finite number (manual x/y, timeline rank, …); roots left with
 *  nothing valid are dropped. */
function parseNumberMapSetting(value: unknown): Record<string, Record<string, number>> {
	const out: Record<string, Record<string, number>> = {};
	if (typeof value !== 'object' || value === null) return out;
	for (const [root, entries] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entries !== 'object' || entries === null) continue;
		const nums: Record<string, number> = {};
		for (const [path, n] of Object.entries(entries as Record<string, unknown>)) {
			if (typeof n === 'number' && Number.isFinite(n)) nums[path] = n;
		}
		if (Object.keys(nums).length > 0) out[root] = nums;
	}
	return out;
}

export function mergeSettings(loaded: unknown): LoomLoomSettings {
	const base: LoomLoomSettings = {
		...DEFAULT_SETTINGS,
		questTagColors: { ...DEFAULT_SETTINGS.questTagColors },
		nodeColors: { ...DEFAULT_SETTINGS.nodeColors },
		nodeSizes: { ...DEFAULT_SETTINGS.nodeSizes },
		globalLayerOrder: [...DEFAULT_SETTINGS.globalLayerOrder],
		graphCameras: {},
		mapCameras: {},
		graphManualX: {},
		graphManualY: {},
		graphPins: {},
		graphFilters: {},
		graphViews: {},
		timelineManualOrder: {},
		timelineDrawerHeight: 240,
	};
	if (typeof loaded !== 'object' || loaded === null) return base;
	const data = loaded as Partial<LoomLoomSettings>;
	if (typeof data.projectRoot === 'string') base.projectRoot = data.projectRoot;
	if (data.textSize === 'compact' || data.textSize === 'normal' || data.textSize === 'large') {
		base.textSize = data.textSize;
	}
	if (data.locale === 'auto' || SUPPORTED_LOCALES.some((l) => l.code === data.locale)) {
		base.locale = data.locale as LocaleCode | 'auto';
	}
	if (typeof data.graphCollapseThreshold === 'number' && data.graphCollapseThreshold >= 1) {
		base.graphCollapseThreshold = Math.floor(data.graphCollapseThreshold);
	}
	if (typeof data.graphFocusZoom === 'number') {
		base.graphFocusZoom = Math.max(0.3, Math.min(3, data.graphFocusZoom));
	}
	if (typeof data.graphLineGap === 'number') {
		base.graphLineGap = Math.max(10, Math.min(40, data.graphLineGap));
	}
	if (typeof data.graphTrunkGap === 'number') {
		base.graphTrunkGap = Math.max(10, Math.min(40, data.graphTrunkGap));
	}
	if (typeof data.graphArrowSize === 'number') {
		base.graphArrowSize = Math.max(4, Math.min(20, data.graphArrowSize));
	}
	if (data.graphDropEdits === 'target' || data.graphDropEdits === 'dragged') {
		base.graphDropEdits = data.graphDropEdits;
	}
	if (typeof data.confirmTimelineMove === 'boolean') {
		base.confirmTimelineMove = data.confirmTimelineMove;
	}
	if (typeof data.notesNewestFirst === 'boolean') {
		base.notesNewestFirst = data.notesNewestFirst;
	}
	if (typeof data.licenseKey === 'string') {
		base.licenseKey = data.licenseKey;
	}
	if (typeof data.timelineDrawerHeight === 'number' && data.timelineDrawerHeight > 0) {
		base.timelineDrawerHeight = data.timelineDrawerHeight;
	}
	if (
		typeof data.sessionResolvedQuests === 'number' &&
		[0, 3, 6, 9, 12].includes(data.sessionResolvedQuests)
	) {
		base.sessionResolvedQuests = data.sessionResolvedQuests;
	}
	if (typeof data.subChipFullAncestry === 'boolean') {
		base.subChipFullAncestry = data.subChipFullAncestry;
	}
	if (typeof data.followThemeTextColoring === 'boolean') {
		base.followThemeTextColoring = data.followThemeTextColoring;
	}
	if (typeof data.questTagColors === 'object' && data.questTagColors !== null) {
		for (const k of ['main', 'important', 'side'] as const) {
			const color = (data.questTagColors as Record<string, unknown>)[k];
			base.questTagColors[k] = parseHexColor(color, base.questTagColors[k]);
		}
	}
	if (typeof data.nodeColors === 'object' && data.nodeColors !== null) {
		for (const type of ENTITY_TYPES) {
			const color = (data.nodeColors as Record<string, unknown>)[type];
			base.nodeColors[type] = parseHexColor(color, base.nodeColors[type]);
		}
	}
	if (typeof data.nodeSizes === 'object' && data.nodeSizes !== null) {
		for (const type of ENTITY_TYPES) {
			const size = (data.nodeSizes as Record<string, unknown>)[type];
			if (typeof size === 'number' && Number.isFinite(size)) {
				base.nodeSizes[type] = Math.max(NODE_SIZE_MIN, Math.min(NODE_SIZE_MAX, size));
			}
		}
	}
	base.groupColor = parseHexColor(data.groupColor, base.groupColor);
	base.mapsColor = parseHexColor(data.mapsColor, base.mapsColor);
	if (data.loomButtonStyle === 'original' || data.loomButtonStyle === 'custom') {
		base.loomButtonStyle = data.loomButtonStyle;
	} else if (
		(data.loomButtonStyle as unknown) === 'original-light' ||
		(data.loomButtonStyle as unknown) === 'original-dark'
	) {
		// Short-lived fixed presets, superseded by the theme-following original.
		base.loomButtonStyle = 'original';
	}
	base.loomButtonBg = parseHexColor(data.loomButtonBg, base.loomButtonBg);
	base.loomButtonIcon = parseHexColor(data.loomButtonIcon, base.loomButtonIcon);
	if (Array.isArray(data.globalLayerOrder)) {
		const order: EntityType[] = [];
		for (const t of data.globalLayerOrder) {
			if (typeof t === 'string' && (GLOBAL_TYPES as readonly string[]).includes(t) && !order.includes(t)) {
				order.push(t);
			}
		}
		// Types missing from the stored order (e.g. added in an update) append
		// in default order so every global type always has a layer.
		for (const t of DEFAULT_SETTINGS.globalLayerOrder) {
			if (!order.includes(t)) order.push(t);
		}
		base.globalLayerOrder = order;
	}
	base.graphCameras = parseCameraMap(data.graphCameras);
	base.mapCameras = parseCameraMap(data.mapCameras);
	base.graphManualX = parseNumberMapSetting(data.graphManualX);
	base.graphManualY = parseNumberMapSetting(data.graphManualY);
	if (typeof data.graphPins === 'object' && data.graphPins !== null) {
		for (const [root, entries] of Object.entries(data.graphPins)) {
			const pins = parsePinsMap(entries);
			if (Object.keys(pins).length > 0) base.graphPins[root] = pins;
		}
	}
	if (typeof data.graphFilters === 'object' && data.graphFilters !== null) {
		for (const [root, f] of Object.entries(data.graphFilters)) {
			if (typeof f !== 'object' || f === null) continue;
			const types = (f as { types?: unknown }).types;
			const mode = (f as { mode?: unknown }).mode;
			base.graphFilters[root] = {
				types: Array.isArray(types)
					? types.filter((t): t is EntityType => ENTITY_TYPES.includes(t as EntityType))
					: [...ENTITY_TYPES],
				mode: mode === 'hide' ? 'hide' : 'dim',
			};
		}
	}
	if (typeof data.graphViews === 'object' && data.graphViews !== null) {
		for (const [root, list] of Object.entries(data.graphViews)) {
			if (!Array.isArray(list)) continue;
			const views: SavedGraphView[] = [];
			for (const v of list) {
				if (typeof v !== 'object' || v === null) continue;
				const o = v as Partial<SavedGraphView>;
				if (typeof o.id !== 'string' || typeof o.name !== 'string') continue;
				const pins = parsePinsMap(o.pins);
				views.push({
					id: o.id,
					name: o.name,
					filterTypes: Array.isArray(o.filterTypes)
						? o.filterTypes.filter((t) => ENTITY_TYPES.includes(t))
						: [...ENTITY_TYPES],
					filterMode: o.filterMode === 'hide' ? 'hide' : 'dim',
					focus: Array.isArray(o.focus) ? o.focus.filter((p): p is string => typeof p === 'string') : [],
					focusSeparate: o.focusSeparate === true,
					pins,
				});
			}
			if (views.length > 0) base.graphViews[root] = views;
		}
	}
	base.timelineManualOrder = parseNumberMapSetting(data.timelineManualOrder);
	// Region color is derived, never stored independently.
	syncRegionColor(base);
	return base;
}

/**
 * Settings keys owned by each page. Its "Restore defaults" row resets exactly
 * these from DEFAULT_SETTINGS — when adding a new setting, add its key to its
 * page's list here and the row covers it automatically.
 */
const PAGE_SETTINGS_KEYS = {
	general: ['textSize', 'locale', 'followThemeTextColoring'] as (keyof LoomLoomSettings)[],
	entities: [
		'questTagColors',
		'sessionResolvedQuests',
		'subChipFullAncestry',
		'nodeColors',
		'nodeSizes',
		'groupColor',
		'mapsColor',
		'loomButtonStyle',
		'loomButtonBg',
		'loomButtonIcon',
	] as (keyof LoomLoomSettings)[],
	graph: [
		'graphCollapseThreshold',
		'graphFocusZoom',
		'graphLineGap',
		'graphTrunkGap',
		'graphArrowSize',
		'graphDropEdits',
		'globalLayerOrder',
	] as (keyof LoomLoomSettings)[],
};

/**
 * `setControlValue` writes through a dotted path (`'nodeColors.character'`) so
 * a single generic override can bind every top-level AND nested setting
 * (per-entity-type colors/sizes, quest tag colors) to a real `control`
 * definition instead of hand-rolled `onChange` plumbing. Keys in this set also
 * get `indexer.refreshViews()` after the write — mirroring EXACTLY which
 * settings triggered a live refresh in the pre-1.13 imperative code (most did;
 * a few — text size, every graph slider/dropdown, the license key — never
 * called it, since those views already read straight from `plugin.settings`
 * on their own next render). Preserved as-is rather than unified, since
 * widening it is a behavior change beyond "port to the declarative API."
 */
const REFRESH_VIEWS_PREFIXES = ['nodeColors.', 'nodeSizes.', 'questTagColors.'];
const REFRESH_VIEWS_KEYS = new Set<string>([
	'locale',
	'groupColor',
	'sessionResolvedQuests',
	'subChipFullAncestry',
	'mapsColor',
	'loomButtonStyle',
	'loomButtonBg',
	'loomButtonIcon',
]);

export class LoomLoomSettingTab extends PluginSettingTab {
	/** Project whose timeline settings the Graph page currently shows. */
	private timelineProjectRoot: string | null = null;
	/** Set right under "Deactivate this device" when the last attempt failed
	 *  specifically because the server couldn't be reached — a `render`
	 *  callback has nowhere else to keep UI-only state across the re-render
	 *  `this.update()` triggers (same reasoning as `timelineProjectRoot`
	 *  above). Cleared at the start of every new attempt. */
	private licenseDeactivateUnreachable = false;
	/** Set when the Language row's `render:` block runs, so both that row's
	 *  own dropdown AND the General page's "Restore defaults" button (a
	 *  separate row entirely) can reveal the same "Relaunch" button after
	 *  either changes `locale` — see that button's own creation site for why
	 *  a reload prompt exists here at all instead of a live re-render. */
	private languageRelaunchBtn?: ButtonComponent;

	constructor(app: App, private plugin: LoomLoomPlugin) {
		super(app, plugin);
		// A stable per-plugin scoping hook: `containerEl` is a single DOM node
		// reused across every open of this tab (the declarative renderer only
		// ever fills its contents, never replaces it), so a class added here
		// once safely scopes CSS to ONLY this plugin's own settings content —
		// needed because generic declarative-API classes like `.setting-item.
		// mod-navigable` (a page-link row, e.g. "Projects" in the top-level
		// page list) are shared by every plugin/core section using the same
		// framework, not unique to us.
		this.containerEl.addClass('loom-settings-root');
	}

	/** Reads through a dotted path (`'nodeColors.character'`) as well as a
	 *  plain top-level key — see `REFRESH_VIEWS_KEYS`'s doc comment for why
	 *  this exists instead of the base class's flat `this.plugin.settings[key]`.
	 *  `sessionResolvedQuests` is special-cased: every `control` value is a
	 *  `string`/`number`/`boolean` bound 1:1 to its stored type, but that
	 *  field is a `number` in storage rendered through a `dropdown` (whose
	 *  control type is always `string`) — coerced to a string here and back
	 *  to a number in `setControlValue`, the one field in this settings tab
	 *  where the control's value type and the storage type actually differ. */
	getControlValue(key: string): unknown {
		if (key === 'sessionResolvedQuests') return String(this.plugin.settings.sessionResolvedQuests);
		let v: unknown = this.plugin.settings;
		for (const part of key.split('.')) {
			if (v === null || typeof v !== 'object') return undefined;
			v = (v as Record<string, unknown>)[part];
		}
		return v;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === 'sessionResolvedQuests') {
			this.plugin.settings.sessionResolvedQuests = Number(value);
		} else {
			const parts = key.split('.');
			let obj: Record<string, unknown> = this.plugin.settings as unknown as Record<string, unknown>;
			for (let i = 0; i < parts.length - 1; i++) {
				obj = obj[parts[i]] as Record<string, unknown>;
			}
			obj[parts[parts.length - 1]] = value;
		}
		// Region tracks the location color — never stored independently.
		if (key === 'nodeColors.location') syncRegionColor(this.plugin.settings);
		await this.plugin.saveSettings();
		if (REFRESH_VIEWS_KEYS.has(key) || REFRESH_VIEWS_PREFIXES.some((p) => key.startsWith(p))) {
			this.plugin.indexer.refreshViews();
		}
	}

	/** Every dropdown in this codebase needs this: Obsidian's native `<select>`
	 *  resizes to match whichever option is CURRENTLY selected, and its open
	 *  option list matches that same width — so a short selection (e.g.
	 *  "English") leaves a longer one (e.g. "Auto (system language)") cramped
	 *  the next time the list opens. A CSS class loses this fight against
	 *  Obsidian's own `.dropdown` rule specificity, so the fix has to be an
	 *  INLINE style via `setCssProps` (never raw `.style.width =`, which
	 *  `eslint-plugin-obsidianmd`'s `no-static-styles-assignment` rule flags),
	 *  sized to the LONGEST option's own text plus a little breathing room for
	 *  the dropdown's arrow glyph — computed fresh from whatever options are
	 *  actually passed in, never a hardcoded guess, so it's automatically
	 *  right no matter how the option list changes later. This is the
	 *  `control: { type: 'dropdown', … }` shorthand's one real gap: it has no
	 *  hook onto the underlying `DropdownComponent`, so any dropdown that
	 *  needs this fix has to be a `render:` block calling this helper instead
	 *  — value read/write and the `REFRESH_VIEWS_KEYS` side effect still go
	 *  through the exact same `getControlValue`/`setControlValue` pair a
	 *  `control:` row would have used, so switching shapes changes nothing
	 *  about how the setting is stored or reacted to. **One real behavior
	 *  difference to compensate for**: a `control:` row's own change triggers
	 *  the framework's automatic `visible` predicate re-evaluation on every
	 *  OTHER row of the same page (documented above `loomButtonStyle`'s own
	 *  conditional bg/icon rows) — a `render:` block's `dd.onChange` bypasses
	 *  that entirely, since it never goes through the framework's own control
	 *  wiring. Calling `refreshDomState()` after the write reproduces the
	 *  same effect explicitly (its own doc comment: "re-evaluate every
	 *  `visible`/`disabled` predicate… cheap, no re-render" — exactly this
	 *  case), so a dropdown converted to this helper can't silently stop
	 *  driving a sibling row's `visible` predicate. **Not `update()`** — that
	 *  one WAS tried first here and caused a real bug: picking a new language
	 *  from the `locale` dropdown blanked the whole settings page until
	 *  reopened, because `update()` does a full structural re-render (it
	 *  re-runs `getSettingDefinitions()` and rebuilds the DOM from scratch),
	 *  and doing that while every `t()` string on the page is simultaneously
	 *  changing language raced badly; `refreshDomState()` only toggles
	 *  existing DOM in place and never rebuilds anything, so it's both the
	 *  correct tool for a `visible` predicate per Obsidian's own docs AND the
	 *  fix for that bug. The identical `longest + 6`ch formula is necessarily
	 *  duplicated (no shared component to hang it on) in `project.ts`'s Set-up-project kind
	 *  dropdown, `timeline-settings.ts`'s Date-format dropdown, and this
	 *  file's own Graph-tab "Project" dropdown (`renderTimeline`) — those
	 *  build a `Setting` by hand rather than through this declarative array,
	 *  so they apply the same two lines directly instead of calling this.
	 *  **`+6`, not `+3`**: an earlier pass here used `+3` and it clipped a
	 *  7-character label ("Compact") — `ch` approximates the WIDEST digit
	 *  glyph's width, not a typical letter's, so it underestimates a
	 *  proportional font more the SHORTER the label is (the arrow glyph's own
	 *  reserved width is a bigger fraction of a short label's total box); `+6`
	 *  matches the number `project.ts`'s kind dropdown already needed after
	 *  its own `+3`-equivalent (`14ch` for an 11-char longest label) also
	 *  clipped. */
	private renderFixedWidthDropdown(
		setting: Setting,
		key: string,
		options: [string, string][],
		onChanged?: () => void
	): void {
		setting.addDropdown((dd) => {
			for (const [value, label] of options) dd.addOption(value, label);
			const current = this.getControlValue(key);
			dd.setValue(typeof current === 'string' ? current : '').onChange(async (value) => {
				await this.setControlValue(key, value);
				this.refreshDomState();
				onChanged?.();
			});
			const longest = Math.max(...options.map(([, label]) => label.length));
			dd.selectEl.setCssProps({ width: `${longest + 6}ch` });
		});
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			// A plain heading above the General/Projects/Entities/Graph page
			// list — that list has no title of its own otherwise (the sidebar's
			// own "Loom Loom" nav entry is outside this tab's own content area).
			// A `type: 'group'` with a `heading` and NO items — not a bare
			// `render` item — specifically so it does NOT get pulled into the
			// SAME shared box as the page-list rows below it: a bare item at
			// this top level renders as just another row merged into that one
			// shared list container, whereas a group (even an empty one) is its
			// own construct, heading rendered outside/above whatever content it
			// holds, same as every group inside a page.
			{ type: 'group', heading: t('settings.root.title') },
			{
				type: 'page',
				name: t('settings.pages.general'),
				items: [
					{
						type: 'group',
						heading: t('settings.general.interfaceHeading'),
						items: [
							{
								name: t('settings.general.language.name'),
								desc: t('settings.general.language.desc'),
								// `t()` never live-retranslates already-rendered text (see
								// `renderFixedWidthDropdown`'s own doc comment: calling
								// `update()` to force that raced with the locale switch
								// itself and blanked the settings page), and a plugin's
								// ribbon/command text can't be retitled live at all through
								// the public API regardless — Obsidian's own core Language
								// setting has the identical limitation, so this mirrors its
								// UI exactly: a `mod-cta` "Relaunch" button beside the
								// dropdown (`addButton` before `addDropdown`, so it renders
								// on the LEFT), hidden until `locale` actually changes.
								// `languageRelaunchBtn` also lets the General page's
								// "Restore defaults" button (a separate row) reveal this
								// same button when IT resets `locale`.
								render: (setting) => {
									setting.addButton((btn) => {
										this.languageRelaunchBtn = btn;
										btn.setButtonText(t('settings.general.language.relaunch'));
										btn.setCta();
										btn.buttonEl.hide();
										btn.onClick(() => location.reload());
									});
									this.renderFixedWidthDropdown(
										setting,
										'locale',
										[
											['auto', t('settings.general.language.auto')],
											...SUPPORTED_LOCALES.map((l): [string, string] => [l.code, l.nativeName]),
										],
										() => this.languageRelaunchBtn?.buttonEl.show()
									);
								},
							},
							{
								name: t('settings.general.textSize.name'),
								desc: t('settings.general.textSize.desc'),
								render: (setting) => this.renderFixedWidthDropdown(setting, 'textSize', [
									['compact', t('settings.general.textSize.compact')],
									['normal', t('settings.general.textSize.normal')],
									['large', t('settings.general.textSize.large')],
								]),
							},
							{
								name: t('settings.general.followThemeTextColoring.name'),
								// The example row is real HTML gated by the SAME
								// `.loom-follow-theme-color` body class the actual
								// Script/Prose editors key off (styles.css, right after
								// `.loom-fountain-underline`) — a pure CSS switch, so it
								// re-colors live the instant the toggle below changes,
								// with no re-render needed.
								render: (setting) => {
									setting.setDesc(
										createFragment((frag) => {
											frag.appendText(t('settings.general.followThemeTextColoring.desc'));
											const example = frag.createDiv({ cls: 'loom-setting-color-preview' });
											example.createSpan({
												cls: 'loom-setting-color-preview-heading',
												text: '# ' + t('settings.general.followThemeTextColoring.exampleHeading'),
											});
											example.appendText(', ');
											example.createEl('strong', {
												text: t('settings.general.followThemeTextColoring.exampleBold'),
											});
											example.appendText(', ');
											example.createEl('em', {
												text: t('settings.general.followThemeTextColoring.exampleItalic'),
											});
											example.appendText(', ');
											example.createEl('u', {
												text: t('settings.general.followThemeTextColoring.exampleUnderline'),
											});
										})
									);
									setting.addToggle((toggle) =>
										toggle
											.setValue(this.plugin.settings.followThemeTextColoring)
											.onChange(async (value) => {
												this.plugin.settings.followThemeTextColoring = value;
												await this.plugin.saveSettings();
											})
									);
								},
							},
						],
					},
					{
						type: 'group',
						heading: t('settings.license.heading'),
						items: [
							{
								name: t('settings.license.heading'),
								aliases: [t('settings.license.aliasKey'), t('settings.license.aliasActivate')],
								render: (setting) => this.renderLicenseSection(setting),
							},
						],
					},
					this.restoreDefaultsRow(
						'general',
						t('settings.general.restore.name'),
						t('settings.general.restore.desc')
					),
				],
			},
			{
				type: 'page',
				name: t('settings.pages.projects'),
				items: [
					{
						type: 'group',
						items: [
							{ name: t('settings.projects.heading'), render: (setting) => this.renderProjectsTable(setting) },
						],
					},
				],
			},
			{
				type: 'page',
				name: t('settings.pages.entities'),
				items: this.entitiesItems(),
			},
			{
				type: 'page',
				name: t('settings.pages.graph'),
				items: this.graphItems(),
			},
		];
	}

	// --- License --------------------------------------------------------

	/** Talks only to `this.plugin.licenseManager` (see `src/license/manager.ts`)
	 *  — the network call itself, the per-device activation cache, and the
	 *  30-day offline grace period all live there, not here. Re-verification
	 *  is silent and automatic (the periodic tick in main.ts, plus a `window`
	 *  `'online'` listener there so reconnecting doesn't have to wait for the
	 *  next tick), so there is no manual "Re-check" button; "Re-activate"
	 *  still hits the network unconditionally (unlike `revalidateNow`, no
	 *  throttle) for anyone who wants to force a fresh check by hand. A
	 *  `render` block — one row within General's own declarative `items`,
	 *  under its own "License" heading — rather than declarative `control`
	 *  definitions: its content is heavily async/status-dependent (several
	 *  buttons whose text and presence depend on `manager.getStatus()`, each
	 *  needing the whole section re-rendered afterward via `this.update()`,
	 *  the outer tab's), which the declarative model isn't a good fit for. No
	 *  "Restore defaults" row for this section — "Deactivate this device" /
	 *  "Forget this device locally" already serve as its reset actions, and
	 *  folding `licenseKey` into General's own restore-defaults button would
	 *  be surprising (it wouldn't itself deactivate anything server-side), so
	 *  it stays out of `PAGE_SETTINGS_KEYS.general`. */
	private renderLicenseSection(setting: Setting): void {
		const containerEl = setting.settingEl;
		containerEl.empty();
		containerEl.addClass('loom-settings-block', 'loom-settings-block-zero-pad', 'loom-license-section');
		const manager = this.plugin.licenseManager;
		const status = manager.getStatus();

		// --- What's free / what a license unlocks ------------------------
		// `createDiv`, not `createEl('p', …)` — a `<p>` carries the browser's own
		// default top/bottom margin that `.setting-item-description` doesn't
		// reset, which was the real source of the excess space above this block
		// (not the group box's own padding, which already matches every other
		// settings section). `.loom-license-text`'s own `gap` replaces it with a
		// controlled, consistent amount instead.
		const textBlock = containerEl.createDiv({ cls: 'loom-license-text' });
		const freeP = textBlock.createDiv({ cls: 'setting-item-description' });
		freeP.createEl('strong', { text: t('settings.license.freeLabel') });
		freeP.appendText(' ' + t('settings.license.freeDesc'));
		textBlock.createDiv({
			cls: 'setting-item-description',
			text: t('settings.license.purchaseDesc'),
		});
		if (status.tier !== 'paid') {
			const buyP = textBlock.createDiv({ cls: 'setting-item-description' });
			buyP.createEl('a', { text: t('settings.license.getLicense'), href: POLAR_CHECKOUT_URL, cls: 'external-link' });
		}

		// --- License key + activate/deactivate ----------------------------
		// Hand-rolled divs/inputs/`ButtonComponent`s rather than a `Setting` —
		// `Setting`'s own `.setting-item`/`.setting-item-info`/`.setting-item-
		// control` DOM comes with box-model rules (padding, margin-inline-end
		// on the first child, flex alignment) that fought every attempt to
		// force it into a plain full-width stacked layout, including a real
		// left-edge misalignment against the plain description text above it
		// that even `!important` overrides on the obvious properties didn't
		// fully pin down. Plain elements guarantee the same left/right edges
		// as `textBlock`/`info` above and below, since they share the exact
		// same box-model as those (no Setting-specific CSS in the way).
		const keyBlock = containerEl.createDiv({ cls: 'loom-settings-divider loom-license-key-block' });
		const keyLabel = keyBlock.createDiv({ cls: 'setting-item-name' });
		keyLabel.createEl('strong', { text: t('settings.license.keyLabel') });
		const keyInput = keyBlock.createEl('input', {
			type: 'text',
			placeholder: t('settings.license.keyPlaceholder'),
			cls: 'loom-license-key-input',
		});
		keyInput.value = this.plugin.settings.licenseKey;
		keyInput.addEventListener('input', () => {
			void (async () => {
				this.plugin.settings.licenseKey = keyInput.value.trim();
				await this.plugin.saveSettings();
			})();
		});

		// Activate and Deactivate are mutually exclusive, never both shown —
		// there's nothing to "re-activate" once a device is already active
		// (background re-validation already keeps it verified silently), and
		// nothing to deactivate before it is.
		const keyActions = keyBlock.createDiv({ cls: 'loom-license-key-actions' });
		if (!status.activated) {
			const activateBtn = new ButtonComponent(keyActions)
				.setButtonText(t('settings.license.activate'))
				.setCta()
				.onClick(() =>
					void (async () => {
						const key = this.plugin.settings.licenseKey.trim();
						if (key === '') {
							new Notice(t('settings.license.enterKeyFirst'));
							return;
						}
						activateBtn.setDisabled(true).setButtonText(t('settings.license.activating'));
						const result = await manager.activate(key);
						new Notice(
							result.ok
								? t('settings.license.activated')
								: (result.reason ?? t('settings.license.activateFailed'))
						);
						this.update();
					})()
				);
		} else {
			const deactivateBtn = new ButtonComponent(keyActions)
				.setButtonText(t('settings.license.deactivate'))
				.onClick(() =>
					void (async () => {
						const key = this.plugin.settings.licenseKey.trim();
						this.licenseDeactivateUnreachable = false;
						deactivateBtn.setDisabled(true).setButtonText(t('settings.license.deactivating'));
						const result = await manager.deactivateThisDevice(key);
						if (result.ok) {
							new Notice(t('settings.license.deactivated'));
						} else if (result.unreachable) {
							this.licenseDeactivateUnreachable = true;
						} else {
							new Notice(result.reason ?? t('settings.license.deactivateFailed'));
						}
						this.update();
					})()
				);
			if (this.licenseDeactivateUnreachable) {
				keyBlock.createDiv({ cls: 'loom-license-warning', text: t('settings.license.unreachable') });
			}
		}

		// --- Status -------------------------------------------------------
		const info = containerEl.createDiv({ cls: 'loom-settings-divider loom-license-text' });
		const tierP = info.createDiv({ cls: 'setting-item-description' });
		tierP.createEl('strong', { text: t('settings.license.currentTier') });
		tierP.appendText(
			` ${status.tier === 'paid' ? t('settings.license.tierPaid') : t('settings.license.tierFree')}`
		);

		const projectsP = info.createDiv({ cls: 'setting-item-description' });
		projectsP.createEl('strong', { text: t('settings.license.projectsLabel') });
		const projects = this.plugin.indexer.getProjects();
		const cap = status.tier === 'paid' ? '∞' : '1';
		const counts = PROJECT_KINDS.map((kind) => {
			const n = projects.filter((p) => p.config.kind === kind).length;
			return `${n}/${cap} ${projectKindLabel(kind)}`;
		}).join(', ');
		projectsP.appendText(` ${counts}`);
	}

	// --- Projects -------------------------------------------------------

	/** Read-only Title | Type table — one row per project. Clicking a title
	 *  opens that project's `.loom` file (same as `main.ts`'s `openHome()`).
	 *  No control to change a project's kind here (or anywhere) any more —
	 *  switching after creation was a rarely-used escape hatch that mostly
	 *  existed because the dropdown was already there; dropped rather than
	 *  replaced. */
	private renderProjectsTable(setting: Setting): void {
		const containerEl = setting.settingEl;
		containerEl.empty();
		// Obsidian's own `.setting-item` styling on `settingEl` is a flex ROW
		// (name column + control column, meant for one setting) — without
		// overriding it to block layout, a `<table>` dropped straight in here
		// is squeezed into a single flex item, which visually corrupts row
		// height and can crush borders on a taller cell (see `renderTimeline`'s
		// own doc comment for the worse version of this same bug).
		containerEl.addClass('loom-settings-block', 'loom-settings-block-zero-pad');
		const projects = this.plugin.indexer.getProjects();
		if (projects.length === 0) {
			containerEl.createEl('p', {
				text: t('settings.common.noProjects'),
				cls: 'setting-item-description',
			});
			return;
		}
		const table = containerEl.createEl('table', { cls: 'loom-settings-table' });
		const headRow = table.createEl('thead').createEl('tr');
		headRow.createEl('th', { text: t('settings.projects.colTitle') });
		headRow.createEl('th', { text: t('settings.projects.colType') });
		const tbody = table.createEl('tbody');
		for (const project of projects) {
			const row = tbody.createEl('tr');
			const titleCell = row.createEl('td');
			// A plain clickable span, NOT a `<button>` — Obsidian's base button
			// chrome (background/border) out-specifies a single-class reset and
			// left a visible highlight block behind the text, which also masked
			// the row's own bottom border where it overlapped. `tabindex` +
			// `Enter`/`Space` keep it keyboard-operable without adopting native
			// button styling.
			const link = titleCell.createSpan({
				cls: 'loom-settings-project-link',
				text: project.name,
				attr: { tabindex: '0', role: 'button' },
			});
			const open = () => {
				const file = this.plugin.app.vault.getFileByPath(project.loomPath);
				if (file instanceof TFile) void this.plugin.app.workspace.getLeaf('tab').openFile(file);
			};
			link.addEventListener('click', open);
			link.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			});
			const typeCell = row.createEl('td', { cls: 'loom-settings-table-type' });
			setIcon(typeCell.createSpan(), PROJECT_KIND_META[project.config.kind].icon);
			typeCell.createSpan({ text: projectKindLabel(project.config.kind) });
		}
	}

	// --- Entities ---------------------------------------------------------

	private entitiesItems(): SettingDefinitionItem[] {
		// Only the types the vault's projects actually hold: a vault with no
		// writer project has no reason to show Act and Scene rows (and vice
		// versa). With no projects yet, fall back to the default kind's set.
		const inUse = new Set<EntityType>(
			this.plugin.indexer.getProjects().flatMap((p) => [...typesFor(p.config.kind, p.config.writerMode)])
		);
		const shown = inUse.size > 0 ? inUse : new Set<EntityType>(typesFor(DEFAULT_PROJECT_KIND));

		// Each entity type gets its OWN box (a heading-less `type: 'group'` —
		// Obsidian gives it the native boxed look for free, same trick
		// `restoreDefaultsRow` already uses) rather than one shared box for
		// every type: the declarative Settings API has no nested-group support
		// (`SettingDefinitionGroup` items can't themselves be groups), which is
		// what used to let a color+size PAIR nest visually under its own type
		// in the pre-1.13 imperative UI — this is the closest equivalent now
		// available. A row WITHIN one type's box still gets Obsidian's own
		// native per-row separator (color → size, or color → size → tag colors
		// for Quest); a type with only ONE row (Group) simply has nothing to
		// separate. Every row's own name is now "Color: {label}"/"Size:
		// {label}" rather than a bare type name, since a name-only row no
		// longer has a heading above it to say which SECTION it belongs to.
		const colorSizeBoxes: SettingDefinitionItem[] = [
			{ type: 'group', heading: t('settings.entities.colorsHeading') },
			{
				type: 'group',
				items: [
					{
						name: t('settings.entities.colorFor', { label: t('settings.entities.groupLabel') }),
						control: { type: 'color', key: 'groupColor', defaultValue: DEFAULT_SETTINGS.groupColor },
					},
				],
			},
		];
		for (const type of ENTITY_TYPES) {
			if (!shown.has(type)) continue;
			// Region has no color/size row — its color is auto-derived from the
			// location color (a darker shade), and it isn't a map node.
			if (type === 'region') continue;
			const items: SettingDefinition[] = [
				{
					name: t('settings.entities.colorFor', { label: entityLabel(type) }),
					control: { type: 'color', key: `nodeColors.${type}`, defaultValue: DEFAULT_SETTINGS.nodeColors[type] },
				},
				{
					name: t('settings.entities.sizeFor', { label: entityLabel(type) }),
					control: {
						type: 'slider',
						key: `nodeSizes.${type}`,
						min: NODE_SIZE_MIN,
						max: NODE_SIZE_MAX,
						step: 1,
						defaultValue: DEFAULT_SETTINGS.nodeSizes[type],
					},
				},
			];
			// Quest tag colors join the quest entity's own box (tags aren't
			// nodes, so no size slider on them).
			if (type === 'quest') {
				for (const k of ['main', 'important', 'side'] as const) {
					items.push({
						name: t('settings.entities.questTag', { name: t(`settings.entities.questTagNames.${k}`) }),
						control: {
							type: 'color',
							key: `questTagColors.${k}`,
							defaultValue: DEFAULT_SETTINGS.questTagColors[k],
						},
					});
				}
			}
			colorSizeBoxes.push({ type: 'group', items });
		}

		return [
			...colorSizeBoxes,
			{
				type: 'group',
				heading: t('settings.entities.otherColorsHeading'),
				items: [
					{
						name: t('settings.entities.maps.name'),
						desc: t('settings.entities.maps.desc'),
						control: { type: 'color', key: 'mapsColor', defaultValue: DEFAULT_SETTINGS.mapsColor },
					},
					{
						name: t('settings.entities.loomButton.name'),
						desc: t('settings.entities.loomButton.desc'),
						render: (setting) => this.renderFixedWidthDropdown(setting, 'loomButtonStyle', [
							['original', t('settings.entities.loomButton.optOriginal')],
							['custom', t('settings.entities.loomButton.optCustom')],
						]),
					},
					{
						name: t('settings.entities.customBg'),
						visible: () => this.plugin.settings.loomButtonStyle === 'custom',
						control: { type: 'color', key: 'loomButtonBg', defaultValue: DEFAULT_SETTINGS.loomButtonBg },
					},
					{
						name: t('settings.entities.customIcon'),
						visible: () => this.plugin.settings.loomButtonStyle === 'custom',
						control: { type: 'color', key: 'loomButtonIcon', defaultValue: DEFAULT_SETTINGS.loomButtonIcon },
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.entities.questsHeading'),
				items: [
					{
						name: t('settings.entities.resolvedQuests.name'),
						desc: t('settings.entities.resolvedQuests.desc'),
						// getControlValue/setControlValue coerce number <-> string for
						// this one field — see their own doc comments.
						render: (setting) => this.renderFixedWidthDropdown(setting, 'sessionResolvedQuests', [
							['3', '3'],
							['6', '6'],
							['9', '9'],
							['12', '12'],
							['0', t('settings.entities.resolvedQuests.optAll')],
						]),
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.entities.locationsHeading'),
				items: [
					{
						name: t('settings.entities.fullAncestry.name'),
						render: (setting) => {
							setting.setDesc(
								createFragment((frag) => {
									frag.appendText(t('settings.entities.fullAncestry.desc'));
									const chain = [
										t('settings.entities.fullAncestry.exampleRoom'),
										t('settings.entities.fullAncestry.exampleTavern'),
										t('settings.entities.fullAncestry.exampleCity'),
									];
									const ul = frag.createEl('ul', { cls: 'loom-setting-list' });
									const on = ul.createEl('li');
									on.appendText(t('settings.entities.fullAncestry.on'));
									on.createEl('code', { text: chain.join(', ') });
									const off = ul.createEl('li');
									off.appendText(t('settings.entities.fullAncestry.off'));
									off.createEl('code', { text: chain[0] });
								})
							);
							setting.addToggle((toggle) =>
								toggle.setValue(this.plugin.settings.subChipFullAncestry).onChange(async (value) => {
									this.plugin.settings.subChipFullAncestry = value;
									await this.plugin.saveSettings();
									this.plugin.indexer.refreshViews();
								})
							);
						},
					},
				],
			},
			this.restoreDefaultsRow(
				'entities',
				t('settings.entities.restore.name'),
				t('settings.entities.restore.desc')
			),
		];
	}

	// --- Graph --------------------------------------------------------------

	private graphItems(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: t('settings.graph.mainHeading'),
				items: [
					{
						name: t('settings.graph.focusZoom.name'),
						desc: t('settings.graph.focusZoom.desc'),
						control: {
							type: 'slider',
							key: 'graphFocusZoom',
							min: 0.3,
							max: 3,
							step: 0.1,
							defaultValue: DEFAULT_SETTINGS.graphFocusZoom,
						},
					},
					{
						name: t('settings.graph.dropEdits.name'),
						desc: createFragment((frag) => {
							frag.appendText(t('settings.graph.dropEdits.intro'));
							const ul = frag.createEl('ul', { cls: 'loom-setting-list' });
							const dragged = ul.createEl('li');
							dragged.appendText(t('settings.graph.dropEdits.draggedLabel'));
							dragged.createEl('code', { text: 'A' });
							const onto = ul.createEl('li');
							onto.appendText(t('settings.graph.dropEdits.ontoLabel'));
							onto.createEl('code', { text: 'B' });
							frag.appendText(t('settings.graph.dropEdits.fieldFillsPre'));
							frag.createEl('code').appendText(t('settings.graph.dropEdits.fieldFillsExample'));
							frag.appendText(t('settings.graph.dropEdits.fieldFillsPost'));
						}),
						render: (setting) => this.renderFixedWidthDropdown(setting, 'graphDropEdits', [
							['target', t('settings.graph.dropEdits.optTarget')],
							['dragged', t('settings.graph.dropEdits.optDragged')],
						]),
					},
					{
						name: t('settings.graph.arrowSize.name'),
						desc: t('settings.graph.arrowSize.desc'),
						control: {
							type: 'slider',
							key: 'graphArrowSize',
							min: 4,
							max: 20,
							step: 1,
							defaultValue: DEFAULT_SETTINGS.graphArrowSize,
						},
					},
					{
						name: t('settings.graph.lineGap.name'),
						desc: t('settings.graph.lineGap.desc'),
						control: {
							type: 'slider',
							key: 'graphLineGap',
							min: 10,
							max: 40,
							step: 2,
							defaultValue: DEFAULT_SETTINGS.graphLineGap,
						},
					},
				],
			},
			// "Global" is the layout's internal term — users just see entity rows.
			// A `list` (not a plain loop of rows) gives this native drag-to-reorder
			// for free via `onReorder`, replacing the old up/down arrow buttons.
			// "Reset order" lives as an `extraButtons` entry on the list's OWN
			// header — inside the same box the list itself renders in — rather
			// than a separate row/section underneath it.
			{
				type: 'list',
				heading: t('settings.graph.layersHeading'),
				items: this.plugin.settings.globalLayerOrder.map((type, i) => ({
					name: t('settings.graph.layerOrderRow', { n: i + 1, plural: entityPlural(type) }),
				})),
				onReorder: (oldIndex, newIndex) => {
					const order = this.plugin.settings.globalLayerOrder;
					const [moved] = order.splice(oldIndex, 1);
					order.splice(newIndex, 0, moved);
					void this.plugin.saveSettings();
					// Row labels carry their own position number, so a structural
					// rebuild (not just a visibility re-check) is needed to relabel them.
					this.update();
				},
				extraButtons: [
					(btn) =>
						btn
							.setIcon('rotate-ccw')
							.setTooltip(t('settings.graph.resetOrderTooltip'))
							.onClick(() =>
								void (async () => {
									this.plugin.settings.globalLayerOrder = [...DEFAULT_SETTINGS.globalLayerOrder];
									await this.plugin.saveSettings();
									this.update();
								})()
							),
				],
			},
			{
				type: 'group',
				heading: t('settings.graph.sidePanelHeading'),
				items: [
					{
						name: t('settings.graph.collapseThreshold.name'),
						desc: t('settings.graph.collapseThreshold.desc'),
						control: {
							type: 'slider',
							key: 'graphCollapseThreshold',
							min: 1,
							max: 25,
							step: 1,
							defaultValue: DEFAULT_SETTINGS.graphCollapseThreshold,
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.graph.timelineHeading'),
				items: [
					{ name: t('settings.graph.timelineHeading'), render: (setting) => this.renderTimeline(setting) },
				],
			},
			this.restoreDefaultsRow('graph', t('settings.graph.restore.name'), t('settings.graph.restore.desc')),
		];
	}

	/** Per-project timeline settings (date format, custom calendar), stored in the project's .loom file. */
	private renderTimeline(setting: Setting): void {
		const containerEl = setting.settingEl;
		containerEl.empty();
		// `settingEl` keeps Obsidian's own `.setting-item` flex-ROW layout (name
		// column + control column, meant for exactly one setting) even after
		// `.empty()` — without overriding it to block layout, everything built
		// here (heading, description paragraph, the Project picker, the date-
		// format row, the toggle) gets squeezed into flex ITEMS of that one row
		// instead of stacking normally: the description wraps one word per
		// line in a tiny column, and "Project"/"Date format" land side by side
		// instead of as their own stacked rows.
		containerEl.addClass('loom-settings-block');
		// A plain string `desc`/`text` can't carry a real line break — a raw
		// `\n` collapses under `.setting-item-description`'s ordinary
		// `white-space: normal` (confirmed against the real Obsidian CSS, not
		// assumed), so the break point has to be an actual `<br>` element,
		// which means building the paragraph in two translated halves around
		// it rather than one interpolated string — same "Pre/Post" split this
		// codebase already uses wherever translated text wraps a non-text
		// element (e.g. `noBranchStructurePre`/`Post` around a `<code>` tag).
		const timelineDescEl = containerEl.createEl('p', { cls: 'setting-item-description' });
		timelineDescEl.appendText(t('settings.graph.timelineDescPre'));
		timelineDescEl.createEl('br');
		timelineDescEl.appendText(t('settings.graph.timelineDescPost'));

		const projects = this.plugin.indexer.getProjects();
		if (projects.length === 0) {
			containerEl.createEl('p', {
				text: t('settings.common.noProjects'),
				cls: 'setting-item-description',
			});
			return;
		}

		const project = projects.find((p) => p.root === this.timelineProjectRoot) ?? projects[0];
		if (projects.length > 1) {
			new Setting(containerEl).setName(t('settings.graph.timelineProjectLabel')).addDropdown((dd) => {
				for (const p of projects) dd.addOption(p.root, p.name);
				dd.setValue(project.root).onChange((root) => {
					this.timelineProjectRoot = root;
					const next = projects.find((p) => p.root === root);
					if (next) new TimelineSettingsEditor(this.plugin, next, editorEl).render();
				});
				// A fixed width covering the longest project name (unlike the kind
				// dropdown's three fixed labels, project names are open-ended, so
				// this is computed here rather than a constant in CSS) — same
				// "resizes per selection, open list ends up cramped" issue as the
				// Set-up-project kind dropdown, and the same fix: an INLINE style,
				// since a class-based `width` was still losing to Obsidian's own
				// `.dropdown` rule. `ch` approximates one character's width — not
				// exact for a proportional font, but comfortably wide either way.
				const longest = Math.max(...projects.map((p) => p.name.length));
				dd.selectEl.setCssProps({ width: `${longest + 3}ch` });
			});
		}
		const editorEl = containerEl.createDiv();
		new TimelineSettingsEditor(this.plugin, project, editorEl).render();
	}

	// --- Shared ---------------------------------------------------------

	private resetKey<K extends keyof LoomLoomSettings>(key: K): void {
		this.plugin.settings[key] = structuredClone(DEFAULT_SETTINGS[key]);
	}

	/** The "Restore defaults" row every page ends on — a `type: 'group'` with
	 *  NO `heading` set (Obsidian still gives a group its own boxed look with
	 *  no heading text at all — that box is Obsidian's own native group
	 *  styling, not anything drawn by this file's CSS, and every OTHER group
	 *  here gets the exact same box; there is nothing "extra" or `cls`-driven
	 *  about it any more) holding just the one `name`/`desc` + button row —
	 *  omitting `heading` is what avoids a redundant "Restore defaults" title
	 *  floating above a row whose own name already says e.g. "Restore general
	 *  defaults". `loom-restore-group` (styles.css) adds the plain horizontal
	 *  divider ahead of the box, set apart from whatever the page's last
	 *  content section was. */
	private restoreDefaultsRow(
		page: keyof typeof PAGE_SETTINGS_KEYS,
		name: string,
		desc: string
	): SettingDefinitionItem {
		return {
			type: 'group',
			cls: 'loom-restore-group',
			items: [
				{
					name,
					desc,
					render: (setting) => {
						setting.addButton((btn) => {
							btn.setButtonText(t('settings.common.restoreButton'));
							btn.buttonEl.addClass('loom-danger-btn');
							btn.onClick(() =>
								new ConfirmModal(
									this.app,
									t('settings.common.confirmRestoreTitle', { name }),
									t('settings.common.confirmRestoreBody', { desc: desc.replace(/\.$/, '') }),
									async () => {
										for (const key of PAGE_SETTINGS_KEYS[page]) this.resetKey(key);
										await this.plugin.saveSettings();
										this.plugin.indexer.refreshViews();
										// `update()` (full structural re-render) is unsafe the
										// moment it coincides with a locale change — see
										// `renderFixedWidthDropdown`'s own doc comment for the
										// confirmed blank-page bug. Only the General page's
										// restore touches `locale` (`PAGE_SETTINGS_KEYS.general`);
										// every other page's restore never resets it, so `update()`
										// stays safe there.
										if (PAGE_SETTINGS_KEYS[page].includes('locale')) {
											this.refreshDomState();
											this.languageRelaunchBtn?.buttonEl.show();
										} else {
											this.update();
										}
									},
									t('settings.common.restoreButton')
								).open()
							);
						});
					},
				},
			],
		};
	}
}
