import { Notice, Setting, debounce } from 'obsidian';
import {
	DateFormat,
	ProjectConfig,
	availableDateFormats,
	formatLoomDate,
	serializeProjectConfig,
} from './calendar';
import { LoomDate } from './types';
import { ProjectDef } from './indexer';
import type LoomLoomPlugin from './main';

/** A fixed sample date rendered next to each format option. */
function sampleDate(config: ProjectConfig): LoomDate {
	const custom = config.customCalendar.enabled;
	return {
		raw: '2003-03-04',
		sortKey: 0,
		year: custom ? 763 : 2003,
		month: custom ? Math.min(3, config.customCalendar.monthCount) : 3,
		day: custom ? 3 : 4,
		calendar: custom ? 'custom' : 'gregorian',
	};
}

/**
 * Per-project timeline settings, stored in the project's .loom file: date
 * display format and the optional custom in-game calendar. Sessions always
 * keep real-world dates; the calendar applies to events. Rendered inside the
 * plugin settings tab (Graph tab).
 */
export class TimelineSettingsEditor {
	private config: ProjectConfig;

	constructor(
		private plugin: LoomLoomPlugin,
		private project: ProjectDef,
		private containerEl: HTMLElement
	) {
		// Deep copy so edits don't mutate the indexer's copy before saving.
		this.config = JSON.parse(JSON.stringify(project.config)) as ProjectConfig;
	}

	private saveLater = debounce(() => void this.save(), 400, true);

	private async save(): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(this.project.loomPath);
		if (!file) {
			new Notice('Project file not found.');
			return;
		}
		try {
			await this.plugin.app.vault.process(file, () => serializeProjectConfig(this.config));
		} catch (e) {
			console.error('Loom Loom: failed to save project config', e);
			new Notice('Could not save timeline settings.');
		}
	}

	private changed(rerender = false): void {
		this.saveLater();
		if (rerender) this.render();
	}

	render(): void {
		const { containerEl } = this;
		containerEl.empty();
		const cal = this.config.customCalendar;

		// Keep the chosen format valid for the current calendar setup.
		const formats = availableDateFormats(this.config);
		if (!formats.includes(this.config.dateFormat)) {
			this.config.dateFormat = formats[0];
		}

		new Setting(containerEl)
			.setName('Date format')
			.setDesc('How dates are displayed in the timeline and graph.')
			.addDropdown((dd) => {
				const sample = sampleDate(this.config);
				const labels = formats.map((format) => formatLoomDate(sample, { ...this.config, dateFormat: format }));
				for (let i = 0; i < formats.length; i++) dd.addOption(formats[i], labels[i]);
				dd.setValue(this.config.dateFormat).onChange((v) => {
					this.config.dateFormat = v as DateFormat;
					this.changed();
				});
				// Same fixed-width fix as the Timeline section's own "Project"
				// dropdown (settings.ts) and Set-up-project's kind dropdown —
				// sample-formatted dates vary a lot in length ("Mar 4th, 2003" vs.
				// "2003-03-04"), so without this the control (and the cramped
				// open option list matching its width) resized per selection.
				dd.selectEl.setCssProps({ width: `${Math.max(...labels.map((l) => l.length)) + 3}ch` });
			});

		new Setting(containerEl)
			.setName('Use in-game calendar')
			.setDesc('Events use a custom fictional calendar. Sessions always track real-world dates.')
			.addToggle((toggle) =>
				toggle.setValue(cal.enabled).onChange((v) => {
					cal.enabled = v;
					this.changed(true);
				})
			);

		if (!cal.enabled) return;

		new Setting(containerEl).setName('Months in a year').addText((text) => {
			text.inputEl.type = 'number';
			text.setValue(String(cal.monthCount)).onChange((v) => {
				const n = Math.floor(Number(v));
				if (!Number.isFinite(n) || n < 1 || n > 100) return;
				cal.monthCount = n;
				this.changed(true);
			});
		});

		new Setting(containerEl)
			.setName('Short names')
			.setDesc('Define abbreviated month names to unlock the short date formats.')
			.addToggle((toggle) =>
				toggle.setValue(cal.useShortNames).onChange((v) => {
					cal.useShortNames = v;
					this.changed(true);
				})
			);

		while (cal.months.length < cal.monthCount) cal.months.push({ name: '', short: '' });

		for (let i = 0; i < cal.monthCount; i++) {
			const month = cal.months[i];
			const setting = new Setting(containerEl).setName(`Month ${i + 1}`).addText((text) =>
				text
					.setPlaceholder(`Month ${i + 1}`)
					.setValue(month.name)
					.onChange((v) => {
						month.name = v.trim();
						this.changed();
					})
			);
			if (cal.useShortNames) {
				setting.addText((text) =>
					text
						.setPlaceholder('Short')
						.setValue(month.short)
						.onChange((v) => {
							month.short = v.trim();
							this.changed();
						})
				);
			}
		}
	}
}
