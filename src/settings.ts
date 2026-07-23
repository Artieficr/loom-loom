import { App, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { ENTITY_META, ENTITY_TYPES, EntityType, GLOBAL_TYPES, GraphCamera } from './types';
import { ConfirmModal } from './project';
import { TimelineSettingsEditor } from './timeline-settings';
import type LoomLoomPlugin from './main';

export type LoomTextSize = 'compact' | 'normal' | 'large';

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
	/** Resized textarea heights (px) per entity file path, keyed by field name
	 *  (e.g. "description", "notes") — not user-facing, remembered across sessions. */
	entityBoxSizes: Record<string, Record<string, number>>;
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
	globalLayerOrder: ['quest', 'character', 'faction', 'item', 'location'],
	nodeColors: {
		session: '#7c5cff',
		event: '#e08e45',
		character: '#58b478',
		location: '#4aa3d8',
		faction: '#d16d9e',
		item: '#d8b13c',
		quest: '#c95f5f',
	},
	nodeSizes: {
		session: 26,
		event: 20,
		character: 17,
		location: 17,
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
	entityBoxSizes: {},
	graphManualX: {},
	graphManualY: {},
	graphPins: {},
	graphFilters: {},
	graphViews: {},
	timelineManualOrder: {},
	timelineDrawerHeight: 240,
};

export function mergeSettings(loaded: unknown): LoomLoomSettings {
	const base: LoomLoomSettings = {
		...DEFAULT_SETTINGS,
		questTagColors: { ...DEFAULT_SETTINGS.questTagColors },
		nodeColors: { ...DEFAULT_SETTINGS.nodeColors },
		nodeSizes: { ...DEFAULT_SETTINGS.nodeSizes },
		globalLayerOrder: [...DEFAULT_SETTINGS.globalLayerOrder],
		graphCameras: {},
		entityBoxSizes: {},
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
			if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
				base.questTagColors[k] = color;
			}
		}
	}
	if (typeof data.nodeColors === 'object' && data.nodeColors !== null) {
		for (const type of ENTITY_TYPES) {
			const color = (data.nodeColors as Record<string, unknown>)[type];
			if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
				base.nodeColors[type] = color;
			}
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
	if (typeof data.groupColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.groupColor)) {
		base.groupColor = data.groupColor;
	}
	if (typeof data.mapsColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.mapsColor)) {
		base.mapsColor = data.mapsColor;
	}
	if (data.loomButtonStyle === 'original' || data.loomButtonStyle === 'custom') {
		base.loomButtonStyle = data.loomButtonStyle;
	} else if (
		(data.loomButtonStyle as unknown) === 'original-light' ||
		(data.loomButtonStyle as unknown) === 'original-dark'
	) {
		// Short-lived fixed presets, superseded by the theme-following original.
		base.loomButtonStyle = 'original';
	}
	if (typeof data.loomButtonBg === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.loomButtonBg)) {
		base.loomButtonBg = data.loomButtonBg;
	}
	if (typeof data.loomButtonIcon === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.loomButtonIcon)) {
		base.loomButtonIcon = data.loomButtonIcon;
	}
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
	if (typeof data.graphCameras === 'object' && data.graphCameras !== null) {
		for (const [root, cam] of Object.entries(data.graphCameras)) {
			if (cam && typeof cam.tx === 'number' && typeof cam.ty === 'number' && typeof cam.k === 'number') {
				base.graphCameras[root] = { tx: cam.tx, ty: cam.ty, k: cam.k };
			}
		}
	}
	if (typeof data.entityBoxSizes === 'object' && data.entityBoxSizes !== null) {
		for (const [path, fields] of Object.entries(data.entityBoxSizes)) {
			if (typeof fields !== 'object' || fields === null) continue;
			const sizes: Record<string, number> = {};
			for (const [key, height] of Object.entries(fields)) {
				if (typeof height === 'number' && height > 0) sizes[key] = height;
			}
			if (Object.keys(sizes).length > 0) base.entityBoxSizes[path] = sizes;
		}
	}
	if (typeof data.graphManualX === 'object' && data.graphManualX !== null) {
		for (const [root, entries] of Object.entries(data.graphManualX)) {
			if (typeof entries !== 'object' || entries === null) continue;
			const xs: Record<string, number> = {};
			for (const [path, x] of Object.entries(entries)) {
				if (typeof x === 'number' && Number.isFinite(x)) xs[path] = x;
			}
			if (Object.keys(xs).length > 0) base.graphManualX[root] = xs;
		}
	}
	if (typeof data.graphManualY === 'object' && data.graphManualY !== null) {
		for (const [root, entries] of Object.entries(data.graphManualY)) {
			if (typeof entries !== 'object' || entries === null) continue;
			const ys: Record<string, number> = {};
			for (const [path, y] of Object.entries(entries)) {
				if (typeof y === 'number' && Number.isFinite(y)) ys[path] = y;
			}
			if (Object.keys(ys).length > 0) base.graphManualY[root] = ys;
		}
	}
	if (typeof data.graphPins === 'object' && data.graphPins !== null) {
		for (const [root, entries] of Object.entries(data.graphPins)) {
			if (typeof entries !== 'object' || entries === null) continue;
			const pins: Record<string, { x: number; y: number }> = {};
			for (const [path, p] of Object.entries(entries)) {
				if (
					typeof p === 'object' &&
					p !== null &&
					Number.isFinite((p as { x?: unknown }).x) &&
					Number.isFinite((p as { y?: unknown }).y)
				) {
					pins[path] = { x: (p as { x: number }).x, y: (p as { y: number }).y };
				}
			}
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
				const pins: Record<string, { x: number; y: number }> = {};
				if (o.pins && typeof o.pins === 'object') {
					for (const [path, p] of Object.entries(o.pins)) {
						if (
							p &&
							typeof p === 'object' &&
							Number.isFinite((p as { x?: unknown }).x) &&
							Number.isFinite((p as { y?: unknown }).y)
						) {
							pins[path] = { x: (p as { x: number }).x, y: (p as { y: number }).y };
						}
					}
				}
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
	if (typeof data.timelineManualOrder === 'object' && data.timelineManualOrder !== null) {
		for (const [root, entries] of Object.entries(data.timelineManualOrder)) {
			if (typeof entries !== 'object' || entries === null) continue;
			const ranks: Record<string, number> = {};
			for (const [path, rank] of Object.entries(entries)) {
				if (typeof rank === 'number' && Number.isFinite(rank)) ranks[path] = rank;
			}
			if (Object.keys(ranks).length > 0) base.timelineManualOrder[root] = ranks;
		}
	}
	return base;
}

type SettingsTabId = 'general' | 'entities' | 'graph';

const SETTINGS_TABS: [SettingsTabId, string][] = [
	['general', 'General'],
	['entities', 'Entities'],
	['graph', 'Graph'],
];

/**
 * Settings keys owned by each tab. The tab's bottom "Restore defaults" button
 * resets exactly these from DEFAULT_SETTINGS — when adding a new setting, add
 * its key to its tab's list here and the button covers it automatically.
 */
const TAB_SETTINGS_KEYS: Record<SettingsTabId, (keyof LoomLoomSettings)[]> = {
	general: ['textSize'],
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
	],
	graph: [
		'graphCollapseThreshold',
		'graphFocusZoom',
		'graphLineGap',
		'graphTrunkGap',
		'graphArrowSize',
		'graphDropEdits',
		'globalLayerOrder',
	],
};

export class LoomLoomSettingTab extends PluginSettingTab {
	private activeTab: SettingsTabId = 'general';
	/** Project whose timeline settings the Graph tab currently shows. */
	private timelineProjectRoot: string | null = null;

	constructor(app: App, private plugin: LoomLoomPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const tabBar = containerEl.createDiv({ cls: 'loom-tab-bar' });
		const body = containerEl.createDiv();
		for (const [id, label] of SETTINGS_TABS) {
			const btn = tabBar.createEl('button', {
				cls: 'loom-tab' + (id === this.activeTab ? ' loom-tab-active' : ''),
				text: label,
			});
			btn.addEventListener('click', () => {
				this.activeTab = id;
				this.display();
			});
		}

		if (this.activeTab === 'general') this.renderGeneral(body);
		else if (this.activeTab === 'entities') this.renderEntities(body);
		else this.renderGraph(body);
	}

	private renderGeneral(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName('Text size')
			.setDesc('Base text size of all plugin views.')
			.addDropdown((dd) => {
				for (const [value, label] of TEXT_SIZES) dd.addOption(value, label);
				dd.setValue(this.plugin.settings.textSize).onChange(async (value) => {
					this.plugin.settings.textSize = value as LoomTextSize;
					await this.plugin.saveSettings();
				});
			});
		this.addReset(setting, () => {
			this.plugin.settings.textSize = DEFAULT_SETTINGS.textSize;
		});

		this.addRestoreDefaults(
			containerEl,
			'general',
			'Restore general defaults',
			'Reset all general settings on this tab to their defaults.'
		);
	}

	/** Adds the circled-arrow restore-default button on a setting's right side. */
	private addReset(setting: Setting, onReset: () => void): void {
		const btn = setting.controlEl.createEl('button', {
			cls: 'loom-reset-btn',
			title: 'Reset to default',
		});
		setIcon(btn, 'rotate-ccw');
		btn.addEventListener('click', () =>
			void (async () => {
				onReset();
				await this.plugin.saveSettings();
				this.plugin.indexer.refreshViews();
				this.redisplay();
			})()
		);
	}

	/** Re-renders the tab without losing the scroll position. */
	private redisplay(): void {
		const scroller = this.containerEl.closest<HTMLElement>('.vertical-tab-content');
		const scrollTop = scroller?.scrollTop ?? 0;
		this.display();
		window.requestAnimationFrame(() => {
			if (scroller) scroller.scrollTop = scrollTop;
		});
	}

	private renderEntities(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Entities colors and node sizes').setHeading();
		// The virtual Group leads — its own entity color-wise (chips, home
		// wheel, its page) even though it never appears in the graph (so no size).
		const groupSetting = new Setting(containerEl).setName('Group').addColorPicker((picker) =>
			picker.setValue(this.plugin.settings.groupColor).onChange(async (value) => {
				this.plugin.settings.groupColor = value;
				await this.plugin.saveSettings();
				this.plugin.indexer.refreshViews();
			})
		);
		this.addReset(groupSetting, () => {
			this.plugin.settings.groupColor = DEFAULT_SETTINGS.groupColor;
		});
		for (const type of ENTITY_TYPES) {
			const setting = new Setting(containerEl)
				.setName(ENTITY_META[type].label)
				.addColorPicker((picker) =>
					picker.setValue(this.plugin.settings.nodeColors[type]).onChange(async (value) => {
						this.plugin.settings.nodeColors[type] = value;
						await this.plugin.saveSettings();
						this.plugin.indexer.refreshViews();
					})
				)
				.addSlider((slider) =>
					slider
						.setLimits(NODE_SIZE_MIN, NODE_SIZE_MAX, 1)
						.setValue(this.plugin.settings.nodeSizes[type])
						// Deprecated in the 1.13 typings (value shown inline there), but
						// 1.13 is Catalyst-only, so on public Obsidian we still need it.
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.nodeSizes[type] = value;
							await this.plugin.saveSettings();
							this.plugin.indexer.refreshViews();
						})
				);
			this.addReset(setting, () => {
				this.plugin.settings.nodeColors[type] = DEFAULT_SETTINGS.nodeColors[type];
				this.plugin.settings.nodeSizes[type] = DEFAULT_SETTINGS.nodeSizes[type];
			});
			// Quest tag colors nest right under the quest entity (tags aren't nodes,
			// so no size slider on them).
			if (type === 'quest') {
				for (const k of ['main', 'important', 'side'] as const) {
					const tagSetting = new Setting(containerEl)
						.setName(`Quest tag — ${k[0].toUpperCase() + k.slice(1)}`)
						.setClass('loom-setting-nested')
						.addColorPicker((picker) =>
							picker.setValue(this.plugin.settings.questTagColors[k]).onChange(async (value) => {
								this.plugin.settings.questTagColors[k] = value;
								await this.plugin.saveSettings();
								this.plugin.indexer.refreshViews();
							})
						);
					this.addReset(tagSetting, () => {
						this.plugin.settings.questTagColors[k] = DEFAULT_SETTINGS.questTagColors[k];
					});
				}
			}
		}

		this.renderLoomButton(containerEl);

		new Setting(containerEl).setName('Quests').setHeading();
		const resolvedSetting = new Setting(containerEl)
			.setName('Resolved quests shown on a session')
			.setDesc(
				'How many previously-resolved quests a session page shows in its resolved-previously group (the most recent by outcome date).'
			)
			.addDropdown((dd) => {
				for (const [value, label] of [
					['3', '3'],
					['6', '6'],
					['9', '9'],
					['12', '12'],
					['0', 'All'],
				] as [string, string][]) {
					dd.addOption(value, label);
				}
				dd.setValue(String(this.plugin.settings.sessionResolvedQuests)).onChange(async (value) => {
					this.plugin.settings.sessionResolvedQuests = Number(value);
					await this.plugin.saveSettings();
					this.plugin.indexer.refreshViews();
				});
			});
		this.addReset(resolvedSetting, () => {
			this.plugin.settings.sessionResolvedQuests = DEFAULT_SETTINGS.sessionResolvedQuests;
		});

		new Setting(containerEl).setName('Locations').setHeading();
		const ancestrySetting = new Setting(containerEl)
			.setName('Full ancestry on sublocation chips')
			.setDesc(
				createFragment((frag) => {
					frag.appendText('Sublocation chips list every parent up the chain.');
					// Built from parts so the example proper-nouns aren't scanned as UI copy.
					const chain = ['Secret room', 'Tavern', 'City'];
					const ul = frag.createEl('ul', { cls: 'loom-setting-list' });
					const on = ul.createEl('li');
					on.appendText('On — ');
					on.createEl('code', { text: chain.join(', ') });
					const off = ul.createEl('li');
					off.appendText('Off — ');
					off.createEl('code', { text: chain[0] });
				})
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.subChipFullAncestry).onChange(async (value) => {
					this.plugin.settings.subChipFullAncestry = value;
					await this.plugin.saveSettings();
					this.plugin.indexer.refreshViews();
				})
			);
		this.addReset(ancestrySetting, () => {
			this.plugin.settings.subChipFullAncestry = DEFAULT_SETTINGS.subChipFullAncestry;
		});
	}

	/** Other colors (Maps, the home-wheel Loom button) — rendered right under the
	 *  entity colors so all color settings sit together. */
	private renderLoomButton(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Other colors').setHeading();

		const mapsSetting = new Setting(containerEl)
			.setName('Maps')
			.setDesc('Maps home-wheel button and the default new-zone fill color.')
			.addColorPicker((picker) =>
				picker.setValue(this.plugin.settings.mapsColor).onChange(async (value) => {
					this.plugin.settings.mapsColor = value;
					await this.plugin.saveSettings();
					this.plugin.indexer.refreshViews();
				})
			);
		this.addReset(mapsSetting, () => {
			this.plugin.settings.mapsColor = DEFAULT_SETTINGS.mapsColor;
		});

		const styleSetting = new Setting(containerEl)
			.setName('Loom button')
			.setDesc('Background and icon colors of the home wheel’s central Loom button.')
			.addDropdown((dd) =>
				dd
					.addOption('original', 'Loom original')
					.addOption('custom', 'Custom')
					.setValue(this.plugin.settings.loomButtonStyle)
					.onChange(async (value) => {
						if (value === 'original' || value === 'custom') {
							this.plugin.settings.loomButtonStyle = value;
						}
						await this.plugin.saveSettings();
						this.plugin.indexer.refreshViews();
						this.redisplay();
					})
			);
		this.addReset(styleSetting, () => {
			this.plugin.settings.loomButtonStyle = DEFAULT_SETTINGS.loomButtonStyle;
		});
		if (this.plugin.settings.loomButtonStyle === 'custom') {
			const bgSetting = new Setting(containerEl)
				.setName('Custom background')
				.setClass('loom-setting-nested')
				.addColorPicker((picker) =>
					picker.setValue(this.plugin.settings.loomButtonBg).onChange(async (value) => {
						this.plugin.settings.loomButtonBg = value;
						await this.plugin.saveSettings();
						this.plugin.indexer.refreshViews();
					})
				);
			this.addReset(bgSetting, () => {
				this.plugin.settings.loomButtonBg = DEFAULT_SETTINGS.loomButtonBg;
			});
			const iconSetting = new Setting(containerEl)
				.setName('Custom icon')
				.setClass('loom-setting-nested')
				.addColorPicker((picker) =>
					picker.setValue(this.plugin.settings.loomButtonIcon).onChange(async (value) => {
						this.plugin.settings.loomButtonIcon = value;
						await this.plugin.saveSettings();
						this.plugin.indexer.refreshViews();
					})
				);
			this.addReset(iconSetting, () => {
				this.plugin.settings.loomButtonIcon = DEFAULT_SETTINGS.loomButtonIcon;
			});
		}
	}

	private renderGraph(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Main graph').setHeading();

		this.slider(
			containerEl,
			'Focus zoom',
			'Zoom level when right-clicking a node to center on it — zooms in or out to reach it.',
			{ min: 0.3, max: 3, step: 0.1 },
			DEFAULT_SETTINGS.graphFocusZoom,
			() => this.plugin.settings.graphFocusZoom,
			(v) => (this.plugin.settings.graphFocusZoom = v)
		);

		const dropSetting = new Setting(containerEl)
			.setName('Drop-to-connect edits')
			.setDesc(
				createFragment((frag) => {
					frag.appendText(
						'Which note a node-on-node drop writes the relationship. When node A is dragged and dropped on B:'
					);
					const ul = frag.createEl('ul', { cls: 'loom-setting-list' });
					// The A/B node labels sit in code spans so the sentence-case lint
					// rule doesn't read a lone capital letter as mis-cased UI copy.
					const dragged = ul.createEl('li');
					dragged.appendText('Dragged node \u2014 ');
					dragged.createEl('code', { text: 'A' });
					const onto = ul.createEl('li');
					onto.appendText('Node dropped onto \u2014 ');
					onto.createEl('code', { text: 'B' });
					frag.appendText('Field fills like ');
					frag.createEl('code').appendText('quest giver');
					frag.appendText(' always edit the field\u2019s owner.');
				})
			)
			.addDropdown((dd) => {
				dd.addOption('target', 'Node dropped onto');
				dd.addOption('dragged', 'Dragged node');
				dd.setValue(this.plugin.settings.graphDropEdits).onChange(async (value) => {
					this.plugin.settings.graphDropEdits = value as 'target' | 'dragged';
					await this.plugin.saveSettings();
				});
			});
		this.addReset(dropSetting, () => {
			this.plugin.settings.graphDropEdits = DEFAULT_SETTINGS.graphDropEdits;
		});

		this.slider(
			containerEl,
			'Relationship arrow size',
			'Size of the arrowheads showing which note declares a relationship.',
			{ min: 4, max: 20, step: 1 },
			DEFAULT_SETTINGS.graphArrowSize,
			() => this.plugin.settings.graphArrowSize,
			(v) => (this.plugin.settings.graphArrowSize = v)
		);

		this.slider(
			containerEl,
			'Connection line spacing',
			'Distance between parallel horizontal connection lines to avoid overlapping.',
			{ min: 10, max: 40, step: 2 },
			DEFAULT_SETTINGS.graphLineGap,
			() => this.plugin.settings.graphLineGap,
			(v) => (this.plugin.settings.graphLineGap = v)
		);

		// "Global" is the layout's internal term — users just see entity rows.
		new Setting(containerEl).setName('Entity layers').setHeading();
		containerEl.createEl('p', {
			text: 'Top-to-bottom row order of the entity layers in the graph.',
			cls: 'setting-item-description',
		});
		const order = this.plugin.settings.globalLayerOrder;
		const move = async (from: number, to: number) => {
			[order[from], order[to]] = [order[to], order[from]];
			await this.plugin.saveSettings();
			this.redisplay();
		};
		order.forEach((type, i) => {
			const setting = new Setting(containerEl).setName(`${i + 1}. ${ENTITY_META[type].plural}`);
			setting.addExtraButton((btn) =>
				btn
					.setIcon('arrow-up')
					.setTooltip('Move up')
					.setDisabled(i === 0)
					.onClick(() => void move(i, i - 1))
			);
			setting.addExtraButton((btn) =>
				btn
					.setIcon('arrow-down')
					.setTooltip('Move down')
					.setDisabled(i === order.length - 1)
					.onClick(() => void move(i, i + 1))
			);
		});
		// A labeled button under the rows instead of the usual per-setting reset
		// icon — a lone ↺ beside the heading read as noise. Plain (not inside a
		// Setting row) so it doesn't get the row frame.
		const resetRow = containerEl.createDiv({ cls: 'loom-layer-reset' });
		const resetBtn = resetRow.createEl('button', { text: 'Reset order' });
		resetBtn.addEventListener('click', () =>
			void (async () => {
				this.plugin.settings.globalLayerOrder = [...DEFAULT_SETTINGS.globalLayerOrder];
				await this.plugin.saveSettings();
				this.redisplay();
			})()
		);

		new Setting(containerEl).setName('Right side panel').setHeading();
		this.slider(
			containerEl,
			'Panel collapse threshold',
			'Connection sections in the graph side panel start collapsed when they have more entries than this.',
			{ min: 1, max: 25, step: 1 },
			DEFAULT_SETTINGS.graphCollapseThreshold,
			() => this.plugin.settings.graphCollapseThreshold,
			(v) => (this.plugin.settings.graphCollapseThreshold = v)
		);

		this.renderTimeline(containerEl);

		this.addRestoreDefaults(
			containerEl,
			'graph',
			'Restore defaults',
			'Reset all settings on this tab to their defaults. Timeline settings belong to their project and are not affected.'
		);
	}

	/** Per-project timeline settings (date format, in-game calendar), stored in the project's .loom file. */
	private renderTimeline(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Timeline').setHeading();
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
			});
		}
		const editorEl = containerEl.createDiv();
		new TimelineSettingsEditor(this.plugin, project, editorEl).render();
	}

	private addRestoreDefaults(
		containerEl: HTMLElement,
		tab: SettingsTabId,
		name: string,
		desc: string
	): void {
		containerEl.createDiv({ cls: 'loom-restore-sep' });
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addButton((btn) => {
				btn.setButtonText('Restore defaults');
				btn.buttonEl.addClass('loom-danger-btn');
				btn.onClick(() =>
					new ConfirmModal(
						this.app,
						`${name}?`,
						`${desc.replace(/\.$/, '')}. This cannot be undone.`,
						async () => {
							for (const key of TAB_SETTINGS_KEYS[tab]) this.resetKey(key);
							await this.plugin.saveSettings();
							this.display();
						},
						'Restore defaults'
					).open()
				);
			});
	}

	private resetKey<K extends keyof LoomLoomSettings>(key: K): void {
		this.plugin.settings[key] = structuredClone(DEFAULT_SETTINGS[key]);
	}

	private slider(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		limits: { min: number; max: number; step: number },
		defaultValue: number,
		get: () => number,
		set: (value: number) => void
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		setting.addSlider((slider) =>
			slider
				.setLimits(limits.min, limits.max, limits.step)
				.setValue(get())
				// Deprecated in the 1.13 typings (value shown inline there), but
				// 1.13 is Catalyst-only — on public Obsidian this tooltip is the
				// only real-time value display while dragging.
				.setDynamicTooltip()
				.onChange(async (value) => {
					set(value);
					await this.plugin.saveSettings();
				})
		);
		this.addReset(setting, () => set(defaultValue));
	}
}
