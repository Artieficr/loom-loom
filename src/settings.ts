import { App, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { ENTITY_META, ENTITY_TYPES, EntityType, GraphCamera } from './types';
import { ConfirmModal } from './project';
import { TimelineSettingsEditor } from './timeline-settings';
import type LoomLoomPlugin from './main';

export type LoomTextSize = 'compact' | 'normal' | 'large';

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
	/** Plugin-specific tag vocabulary per entity type (distinct from Obsidian #tags). */
	tagVocabulary: Record<EntityType, string[]>;
	/** Graph side panel: sections with more entries than this start collapsed. */
	graphCollapseThreshold: number;
	/** Sideways bow (px, control-point offset) of edges that pass through other nodes. */
	graphEdgeCurve: number;
	/** Zoom level a right-clicked node is focused at. */
	graphFocusZoom: number;
	/** Graph node fill color per entity type. */
	nodeColors: Record<EntityType, string>;
	/** Last camera per project root — not user-facing, remembered across sessions. */
	graphCameras: Record<string, GraphCamera>;
}

export const DEFAULT_SETTINGS: LoomLoomSettings = {
	projectRoot: '',
	textSize: 'normal',
	tagVocabulary: {
		character: ['PC', 'NPC', 'Cast'],
		location: [],
		faction: [],
		item: [],
		event: [],
		session: [],
	},
	graphCollapseThreshold: 5,
	graphEdgeCurve: 70,
	graphFocusZoom: 1.5,
	nodeColors: {
		session: '#7c5cff',
		event: '#e08e45',
		character: '#58b478',
		location: '#4aa3d8',
		faction: '#d16d9e',
		item: '#d8b13c',
	},
	graphCameras: {},
};

export function mergeSettings(loaded: unknown): LoomLoomSettings {
	const base: LoomLoomSettings = {
		...DEFAULT_SETTINGS,
		tagVocabulary: { ...DEFAULT_SETTINGS.tagVocabulary },
		nodeColors: { ...DEFAULT_SETTINGS.nodeColors },
		graphCameras: {},
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
	if (typeof data.graphEdgeCurve === 'number') {
		base.graphEdgeCurve = Math.max(20, Math.min(140, Math.floor(data.graphEdgeCurve)));
	}
	if (typeof data.graphFocusZoom === 'number') {
		base.graphFocusZoom = Math.max(1, Math.min(3, data.graphFocusZoom));
	}
	if (typeof data.tagVocabulary === 'object' && data.tagVocabulary !== null) {
		for (const type of ENTITY_TYPES) {
			const tags = (data.tagVocabulary as Record<string, unknown>)[type];
			if (Array.isArray(tags)) {
				base.tagVocabulary[type] = tags.filter((t): t is string => typeof t === 'string');
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
	if (typeof data.graphCameras === 'object' && data.graphCameras !== null) {
		for (const [root, cam] of Object.entries(data.graphCameras)) {
			if (cam && typeof cam.tx === 'number' && typeof cam.ty === 'number' && typeof cam.k === 'number') {
				base.graphCameras[root] = { tx: cam.tx, ty: cam.ty, k: cam.k };
			}
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
	entities: ['tagVocabulary'],
	graph: ['graphCollapseThreshold', 'graphEdgeCurve', 'graphFocusZoom', 'nodeColors'],
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
			'Reset all general settings on this page to their defaults.'
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
				// Re-render without losing the scroll position.
				const scroller = this.containerEl.closest<HTMLElement>('.vertical-tab-content');
				const scrollTop = scroller?.scrollTop ?? 0;
				this.display();
				window.requestAnimationFrame(() => {
					if (scroller) scroller.scrollTop = scrollTop;
				});
			})()
		);
	}

	private renderEntities(containerEl: HTMLElement): void {
		containerEl.createEl('p', {
			text: 'Comma-separated tags offered for each entity type. These live in their own frontmatter field and are independent from Obsidian tags.',
			cls: 'setting-item-description',
		});

		for (const type of ENTITY_TYPES) {
			new Setting(containerEl).setName(`${ENTITY_META[type].label} tags`).addText((text) =>
				text
					.setPlaceholder('Tags, separated by commas')
					.setValue(this.plugin.settings.tagVocabulary[type].join(', '))
					.onChange(async (value) => {
						this.plugin.settings.tagVocabulary[type] = value
							.split(',')
							.map((t) => t.trim())
							.filter((t) => t.length > 0);
						await this.plugin.saveSettings();
					})
			);
		}
	}

	private renderGraph(containerEl: HTMLElement): void {
		this.slider(
			containerEl,
			'Panel collapse threshold',
			'Connection sections in the graph side panel start collapsed when they have more entries than this.',
			{ min: 1, max: 25, step: 1 },
			DEFAULT_SETTINGS.graphCollapseThreshold,
			() => this.plugin.settings.graphCollapseThreshold,
			(v) => (this.plugin.settings.graphCollapseThreshold = v)
		);

		this.slider(
			containerEl,
			'Edge curve',
			'How far edges bend sideways to avoid nodes sitting on their path.',
			{ min: 20, max: 140, step: 5 },
			DEFAULT_SETTINGS.graphEdgeCurve,
			() => this.plugin.settings.graphEdgeCurve,
			(v) => (this.plugin.settings.graphEdgeCurve = v)
		);

		this.slider(
			containerEl,
			'Focus zoom',
			'Zoom level when right-clicking a node to center on it.',
			{ min: 1, max: 3, step: 0.1 },
			DEFAULT_SETTINGS.graphFocusZoom,
			() => this.plugin.settings.graphFocusZoom,
			(v) => (this.plugin.settings.graphFocusZoom = v)
		);

		new Setting(containerEl).setName('Node colors').setHeading();
		for (const type of ENTITY_TYPES) {
			const setting = new Setting(containerEl).setName(`${ENTITY_META[type].label} nodes`).addColorPicker((picker) =>
				picker.setValue(this.plugin.settings.nodeColors[type]).onChange(async (value) => {
					this.plugin.settings.nodeColors[type] = value;
					await this.plugin.saveSettings();
				})
			);
			this.addReset(setting, () => {
				this.plugin.settings.nodeColors[type] = DEFAULT_SETTINGS.nodeColors[type];
			});
		}

		this.renderTimeline(containerEl);

		this.addRestoreDefaults(
			containerEl,
			'graph',
			'Restore graph defaults',
			'Reset all graph settings on this page to their defaults. Timeline settings belong to their project and are not affected.'
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
