import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	SettingDefinition,
	SettingDefinitionItem,
	TFile,
	setIcon,
} from 'obsidian';
import { ENTITY_META, ENTITY_TYPES, EntityType, GLOBAL_TYPES, GraphCamera } from './types';
import { DEFAULT_PROJECT_KIND, PROJECT_KIND_META, typesFor } from './project-kind';
import { ConfirmModal } from './project';
import { TimelineSettingsEditor } from './timeline-settings';
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

export const TEXT_SIZES: [LoomTextSize, string][] = [
	['compact', 'Compact'],
	['normal', 'Normal'],
	['large', 'Large'],
];

export interface LoomLoomSettings {
	/** Legacy single-project root (pre-.loom-files); migrated on load, kept for that migration only. */
	projectRoot: string;
	/** Base text size of all plugin views (applied as a body class). */
	textSize: LoomTextSize;
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
		// Writer projects hold Chapters/Scenes where player and GM ones hold
		// Sessions/Events — same structural role, so they start from the same
		// colors and can be tuned apart.
		chapter: '#7c5cff',
		scene: '#e08e45',
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
		chapter: 26,
		scene: 20,
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
	general: ['textSize'] as (keyof LoomLoomSettings)[],
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

	constructor(app: App, private plugin: LoomLoomPlugin) {
		super(app, plugin);
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
			{ type: 'group', heading: 'Loom Loom! settings' },
			{
				type: 'page',
				name: 'General',
				items: [
					{
						type: 'group',
						heading: 'License',
						items: [
							{
								name: 'License',
								aliases: ['license key', 'activate'],
								render: (setting) => this.renderLicenseSection(setting),
							},
						],
					},
					{
						type: 'group',
						heading: 'Interface',
						items: [
							{
								name: 'Text size',
								desc: 'Base text size of all plugin views.',
								control: {
									type: 'dropdown',
									key: 'textSize',
									options: Object.fromEntries(TEXT_SIZES),
									defaultValue: DEFAULT_SETTINGS.textSize,
								},
							},
						],
					},
					this.restoreDefaultsRow(
						'general',
						'Restore general defaults',
						'Reset all general settings on this tab to their defaults.'
					),
				],
			},
			{
				type: 'page',
				name: 'Projects',
				items: [
					{
						type: 'group',
						heading: 'Projects',
						items: [{ name: 'Projects', render: (setting) => this.renderProjectsTable(setting) }],
					},
				],
			},
			{
				type: 'page',
				name: 'Entities',
				items: this.entitiesItems(),
			},
			{
				type: 'page',
				name: 'Graph',
				items: this.graphItems(),
			},
		];
	}

	// --- License --------------------------------------------------------

	/** Talks only to `this.plugin.licenseManager` (see `src/license/manager.ts`)
	 *  — the network call itself, the per-device activation cache, and the
	 *  30-day offline grace period all live there, not here. A `render` block
	 *  on the General page, under its own "License" heading (moved off its
	 *  own tab so it's one less place to look), rather than a declarative
	 *  `items` sub-array — its content is heavily async/status-dependent
	 *  (several buttons whose text and presence depend on `manager.getStatus()`,
	 *  each needing the whole section re-rendered afterward — `this.update()`,
	 *  the outer tab's, since this section is just one row within General's
	 *  own declarative items now, not a standalone page with its own
	 *  `display()`), which the declarative model isn't a good fit for. No
	 *  "Restore defaults" row for this section — "Deactivate this device" /
	 *  "Forget this device locally" already serve as its reset actions, and
	 *  folding `licenseKey` into General's own restore-defaults button would
	 *  be surprising (it wouldn't itself deactivate anything server-side), so
	 *  it stays out of `PAGE_SETTINGS_KEYS.general`. */
	private renderLicenseSection(setting: Setting): void {
		const containerEl = setting.settingEl;
		containerEl.empty();
		containerEl.addClass('loom-settings-block');
		const manager = this.plugin.licenseManager;
		const status = manager.getStatus();

		new Setting(containerEl)
			.setName('License key')
			.setDesc(
				'Free: one project of each type per vault, with every feature available. ' +
					'A license key unlocks unlimited projects and can be activated on up to 3 devices.'
			)
			.addText((text) =>
				text
					.setPlaceholder('Paste your license key')
					.setValue(this.plugin.settings.licenseKey)
					.onChange(async (value) => {
						this.plugin.settings.licenseKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		const actions = new Setting(containerEl).setName('This device');
		actions.addButton((btn) =>
			btn
				.setButtonText(status.activated ? 'Re-activate' : 'Activate this device')
				.setCta()
				.onClick(() =>
					void (async () => {
						const key = this.plugin.settings.licenseKey.trim();
						if (key === '') {
							new Notice('Enter a license key first.');
							return;
						}
						btn.setDisabled(true).setButtonText('Activating…');
						const result = await manager.activate(key);
						new Notice(
							result.ok
								? 'License activated on this device.'
								: (result.reason ?? 'Could not activate this license key.')
						);
						this.update();
					})()
				)
		);
		if (status.activated) {
			actions.addButton((btn) =>
				btn.setButtonText('Deactivate this device').onClick(() =>
					void (async () => {
						const key = this.plugin.settings.licenseKey.trim();
						btn.setDisabled(true).setButtonText('Deactivating…');
						const result = await manager.deactivateThisDevice(key);
						new Notice(
							result.ok
								? 'Device deactivated.'
								: (result.reason ?? 'Could not deactivate — try "Forget this device locally" below.')
						);
						this.update();
					})()
				)
			);
		}
		actions.addButton((btn) =>
			btn.setButtonText('Re-check now').onClick(() =>
				void (async () => {
					const key = this.plugin.settings.licenseKey.trim();
					if (key === '') {
						new Notice('Enter a license key first.');
						return;
					}
					btn.setDisabled(true).setButtonText('Checking…');
					await manager.revalidateNow(key, true);
					this.update();
				})()
			)
		);

		const info = containerEl.createDiv({ cls: 'setting-item-description' });
		info.createEl('p', {
			text: `Tier: ${status.tier === 'paid' ? 'Paid — unlimited projects.' : 'Free — one project of each type.'}`,
		});
		info.createEl('p', { text: `Device id: ${status.deviceId}` });
		if (status.activated && status.graceExpiresAt !== null) {
			info.createEl('p', {
				text:
					`Verified until ${new Date(status.graceExpiresAt).toLocaleDateString()} without needing to ` +
					'reconnect (checked periodically in the background, and on demand via "Re-check now").',
			});
		}
		if (status.lastCheckAt !== null) {
			const outcome =
				status.lastCheckOk === true ? 'ok' : status.lastCheckOk === false ? 'rejected' : 'could not reach the server';
			info.createEl('p', { text: `Last check: ${new Date(status.lastCheckAt).toLocaleString()} — ${outcome}.` });
		}
		if (status.lastError) info.createEl('p', { text: status.lastError });

		if (status.activated) {
			new Setting(containerEl)
				.setName('Forget this device locally')
				.setDesc(
					'If "Deactivate this device" can\'t reach the server (offline), this clears the activation on ' +
						"THIS device only — it does not free the slot on the license server's side."
				)
				.addButton((btn) =>
					btn.setButtonText('Forget locally').onClick(() => {
						manager.forgetDeviceLocally();
						new Notice('Forgotten on this device.');
						this.update();
					})
				);
		}
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
		containerEl.addClass('loom-settings-block');
		const projects = this.plugin.indexer.getProjects();
		if (projects.length === 0) {
			containerEl.createEl('p', {
				text: 'No Loom projects in this vault yet.',
				cls: 'setting-item-description',
			});
			return;
		}
		const table = containerEl.createEl('table', { cls: 'loom-settings-table' });
		const headRow = table.createEl('thead').createEl('tr');
		headRow.createEl('th', { text: 'Title' });
		headRow.createEl('th', { text: 'Type' });
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
			typeCell.createSpan({ text: PROJECT_KIND_META[project.config.kind].label });
		}
	}

	// --- Entities ---------------------------------------------------------

	private entitiesItems(): SettingDefinitionItem[] {
		// Only the types the vault's projects actually hold: a vault with no
		// writer project has no reason to show Chapter and Scene rows (and vice
		// versa). With no projects yet, fall back to the default kind's set.
		const inUse = new Set<EntityType>(
			this.plugin.indexer.getProjects().flatMap((p) => [...typesFor(p.config.kind)])
		);
		const shown = inUse.size > 0 ? inUse : new Set<EntityType>(typesFor(DEFAULT_PROJECT_KIND));

		const colorSizeItems: SettingDefinition[] = [
			{
				name: 'Group',
				control: { type: 'color', key: 'groupColor', defaultValue: DEFAULT_SETTINGS.groupColor },
			},
		];
		for (const type of ENTITY_TYPES) {
			if (!shown.has(type)) continue;
			// Region has no color/size row — its color is auto-derived from the
			// location color (a darker shade), and it isn't a map node.
			if (type === 'region') continue;
			colorSizeItems.push({
				name: ENTITY_META[type].label,
				control: { type: 'color', key: `nodeColors.${type}`, defaultValue: DEFAULT_SETTINGS.nodeColors[type] },
			});
			colorSizeItems.push({
				name: `${ENTITY_META[type].label} size`,
				control: {
					type: 'slider',
					key: `nodeSizes.${type}`,
					min: NODE_SIZE_MIN,
					max: NODE_SIZE_MAX,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.nodeSizes[type],
				},
			});
			// Quest tag colors nest right under the quest entity (tags aren't
			// nodes, so no size slider on them).
			if (type === 'quest') {
				for (const k of ['main', 'important', 'side'] as const) {
					colorSizeItems.push({
						name: `Quest tag — ${k[0].toUpperCase() + k.slice(1)}`,
						control: {
							type: 'color',
							key: `questTagColors.${k}`,
							defaultValue: DEFAULT_SETTINGS.questTagColors[k],
						},
					});
				}
			}
		}

		return [
			{ type: 'group', heading: 'Entities colors and node sizes', items: colorSizeItems },
			{
				type: 'group',
				heading: 'Other colors',
				items: [
					{
						name: 'Maps',
						desc: 'Maps home-wheel button and the default new-zone fill color.',
						control: { type: 'color', key: 'mapsColor', defaultValue: DEFAULT_SETTINGS.mapsColor },
					},
					{
						name: 'Loom button',
						desc: 'Background and icon colors of the home wheel’s central Loom button.',
						control: {
							type: 'dropdown',
							key: 'loomButtonStyle',
							options: { original: 'Loom original', custom: 'Custom' },
							defaultValue: DEFAULT_SETTINGS.loomButtonStyle,
						},
					},
					{
						name: 'Custom background',
						visible: () => this.plugin.settings.loomButtonStyle === 'custom',
						control: { type: 'color', key: 'loomButtonBg', defaultValue: DEFAULT_SETTINGS.loomButtonBg },
					},
					{
						name: 'Custom icon',
						visible: () => this.plugin.settings.loomButtonStyle === 'custom',
						control: { type: 'color', key: 'loomButtonIcon', defaultValue: DEFAULT_SETTINGS.loomButtonIcon },
					},
				],
			},
			{
				type: 'group',
				heading: 'Quests',
				items: [
					{
						name: 'Resolved quests shown on a session',
						desc: 'How many previously-resolved quests a session page shows in its resolved-previously group (the most recent by outcome date).',
						control: {
							type: 'dropdown',
							key: 'sessionResolvedQuests',
							// Control values are strings; getControlValue/setControlValue
							// coerce number <-> string for this one field below.
							options: { '3': '3', '6': '6', '9': '9', '12': '12', '0': 'All' },
							defaultValue: String(DEFAULT_SETTINGS.sessionResolvedQuests),
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Locations',
				items: [
					{
						name: 'Full ancestry on sublocation chips',
						render: (setting) => {
							setting.setDesc(
								createFragment((frag) => {
									frag.appendText('Sublocation chips list every parent up the chain.');
									const chain = ['Secret room', 'Tavern', 'City'];
									const ul = frag.createEl('ul', { cls: 'loom-setting-list' });
									const on = ul.createEl('li');
									on.appendText('On — ');
									on.createEl('code', { text: chain.join(', ') });
									const off = ul.createEl('li');
									off.appendText('Off — ');
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
				'Restore entities defaults',
				'Reset all settings on this tab to their defaults.'
			),
		];
	}

	// --- Graph --------------------------------------------------------------

	private graphItems(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Main graph',
				items: [
					{
						name: 'Focus zoom',
						desc: 'Zoom level when right-clicking a node to center on it — zooms in or out to reach it.',
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
						name: 'Drop-to-connect edits',
						desc: createFragment((frag) => {
							frag.appendText(
								'Which note a node-on-node drop writes the relationship. When node A is dragged and dropped on B:'
							);
							const ul = frag.createEl('ul', { cls: 'loom-setting-list' });
							const dragged = ul.createEl('li');
							dragged.appendText('Dragged node — ');
							dragged.createEl('code', { text: 'A' });
							const onto = ul.createEl('li');
							onto.appendText('Node dropped onto — ');
							onto.createEl('code', { text: 'B' });
							frag.appendText('Field fills like ');
							frag.createEl('code').appendText('quest giver');
							frag.appendText(' always edit the field’s owner.');
						}),
						control: {
							type: 'dropdown',
							key: 'graphDropEdits',
							options: { target: 'Node dropped onto', dragged: 'Dragged node' },
							defaultValue: DEFAULT_SETTINGS.graphDropEdits,
						},
					},
					{
						name: 'Relationship arrow size',
						desc: 'Size of the arrowheads showing which note declares a relationship.',
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
						name: 'Connection line spacing',
						desc: 'Distance between parallel horizontal connection lines to avoid overlapping.',
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
				heading: 'Entity layers',
				items: this.plugin.settings.globalLayerOrder.map((type, i) => ({
					name: `${i + 1}. ${ENTITY_META[type].plural}`,
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
							.setTooltip('Reset order')
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
				heading: 'Right side panel',
				items: [
					{
						name: 'Panel collapse threshold',
						desc: 'Connection sections in the graph side panel start collapsed when they have more entries than this.',
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
				heading: 'Timeline',
				items: [{ name: 'Timeline', render: (setting) => this.renderTimeline(setting) }],
			},
			this.restoreDefaultsRow(
				'graph',
				'Restore defaults',
				'Reset all settings on this tab to their defaults. Timeline settings belong to their project and are not affected.'
			),
		];
	}

	/** Per-project timeline settings (date format, in-game calendar), stored in the project's .loom file. */
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
		containerEl.createEl('p', {
			text: 'Date display and in-game calendar for the timeline. These are per project and saved in its .loom file.',
			cls: 'setting-item-description',
		});

		const projects = this.plugin.indexer.getProjects();
		if (projects.length === 0) {
			containerEl.createEl('p', {
				text: 'No Loom projects in this vault yet.',
				cls: 'setting-item-description',
			});
			return;
		}

		const project = projects.find((p) => p.root === this.timelineProjectRoot) ?? projects[0];
		if (projects.length > 1) {
			new Setting(containerEl).setName('Project').addDropdown((dd) => {
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
							btn.setButtonText('Restore defaults');
							btn.buttonEl.addClass('loom-danger-btn');
							btn.onClick(() =>
								new ConfirmModal(
									this.app,
									`${name}?`,
									`${desc.replace(/\.$/, '')}. This cannot be undone.`,
									async () => {
										for (const key of PAGE_SETTINGS_KEYS[page]) this.resetKey(key);
										await this.plugin.saveSettings();
										this.plugin.indexer.refreshViews();
										this.update();
									},
									'Restore defaults'
								).open()
							);
						});
					},
				},
			],
		};
	}
}
