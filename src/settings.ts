import { App, PluginSettingTab, Setting } from 'obsidian';
import { ENTITY_META, ENTITY_TYPES, EntityType } from './types';
import type LoomLoomPlugin from './main';

export interface LoomLoomSettings {
	/** Legacy single-project root (pre-.loom-files); migrated on load, kept for that migration only. */
	projectRoot: string;
	/** Plugin-specific tag vocabulary per entity type (distinct from Obsidian #tags). */
	tagVocabulary: Record<EntityType, string[]>;
	/** Graph side panel: sections with more entries than this start collapsed. */
	graphCollapseThreshold: number;
	/** Sideways bow (px, control-point offset) of edges that pass through other nodes. */
	graphEdgeCurve: number;
	/** Graph node fill color per entity type. */
	nodeColors: Record<EntityType, string>;
}

export const DEFAULT_SETTINGS: LoomLoomSettings = {
	projectRoot: '',
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
	nodeColors: {
		session: '#7c5cff',
		event: '#e08e45',
		character: '#58b478',
		location: '#4aa3d8',
		faction: '#d16d9e',
		item: '#d8b13c',
	},
};

export function mergeSettings(loaded: unknown): LoomLoomSettings {
	const base: LoomLoomSettings = {
		...DEFAULT_SETTINGS,
		tagVocabulary: { ...DEFAULT_SETTINGS.tagVocabulary },
		nodeColors: { ...DEFAULT_SETTINGS.nodeColors },
	};
	if (typeof loaded !== 'object' || loaded === null) return base;
	const data = loaded as Partial<LoomLoomSettings>;
	if (typeof data.projectRoot === 'string') base.projectRoot = data.projectRoot;
	if (typeof data.graphCollapseThreshold === 'number' && data.graphCollapseThreshold >= 1) {
		base.graphCollapseThreshold = Math.floor(data.graphCollapseThreshold);
	}
	if (typeof data.graphEdgeCurve === 'number') {
		base.graphEdgeCurve = Math.max(20, Math.min(140, Math.floor(data.graphEdgeCurve)));
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
	return base;
}

export class LoomLoomSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LoomLoomPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const thresholdSetting = new Setting(containerEl)
			.setName('Graph panel collapse threshold')
			.setDesc('Connection sections in the graph side panel start collapsed when they have more entries than this.');
		const thresholdValueEl = thresholdSetting.controlEl.createSpan({
			text: String(this.plugin.settings.graphCollapseThreshold),
			cls: 'loom-slider-value',
		});
		thresholdSetting.addSlider((slider) =>
			slider
				.setLimits(1, 25, 1)
				.setValue(this.plugin.settings.graphCollapseThreshold)
				.onChange(async (value) => {
					thresholdValueEl.setText(String(value));
					this.plugin.settings.graphCollapseThreshold = value;
					await this.plugin.saveSettings();
				})
		);

		const curveSetting = new Setting(containerEl)
			.setName('Graph edge curve')
			.setDesc('How far edges bend sideways to avoid nodes sitting on their path.');
		const curveValueEl = curveSetting.controlEl.createSpan({
			text: String(this.plugin.settings.graphEdgeCurve),
			cls: 'loom-slider-value',
		});
		curveSetting.addSlider((slider) =>
			slider
				.setLimits(20, 140, 5)
				.setValue(this.plugin.settings.graphEdgeCurve)
				.onChange(async (value) => {
					curveValueEl.setText(String(value));
					this.plugin.settings.graphEdgeCurve = value;
					await this.plugin.saveSettings();
				})
		);

		new Setting(containerEl).setName('Graph node colors').setHeading();
		for (const type of ENTITY_TYPES) {
			new Setting(containerEl).setName(`${ENTITY_META[type].label} nodes`).addColorPicker((picker) =>
				picker.setValue(this.plugin.settings.nodeColors[type]).onChange(async (value) => {
					this.plugin.settings.nodeColors[type] = value;
					await this.plugin.saveSettings();
				})
			);
		}

		new Setting(containerEl).setName('Tag vocabulary').setHeading();
		containerEl.createEl('p', {
			text: 'Comma-separated tags offered for each entity type. These live in their own frontmatter field and are independent from Obsidian tags.',
			cls: 'setting-item-description',
		});

		for (const type of ENTITY_TYPES) {
			new Setting(containerEl)
				.setName(`${ENTITY_META[type].label} tags`)
				.addText((text) =>
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
}
