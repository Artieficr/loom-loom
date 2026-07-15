import {
	AbstractInputSuggest,
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Setting,
	TFile,
	TFolder,
	normalizePath,
} from 'obsidian';
import {
	ENTITY_META,
	ENTITY_TAGS,
	ENTITY_TYPES,
	EntityOrigin,
	EntityRecord,
	EntityType,
	LOOM_EXTENSION,
	TIMELINES_FOLDER,
	VIEW_LIST,
} from './types';
import { defaultProjectConfig, serializeProjectConfig, todayRaw } from './calendar';
import { ProjectDef } from './indexer';
import type LoomLoomPlugin from './main';

const PROJECT_SUBFOLDERS = [
	'Entities',
	...ENTITY_TYPES.map((t) => ENTITY_META[t].folder),
	TIMELINES_FOLDER,
];

async function ensureFolder(app: App, path: string): Promise<void> {
	let current = '';
	for (const segment of path.split('/')) {
		current = current === '' ? segment : current + '/' + segment;
		if (!app.vault.getFolderByPath(current)) {
			try {
				await app.vault.createFolder(current);
			} catch {
				// Already exists (race with another create) — fine.
			}
		}
	}
}

function projectPath(project: ProjectDef, sub: string): string {
	return normalizePath(project.root === '' ? sub : project.root + '/' + sub);
}

/**
 * Creates the project structure inside `rootPath` and its .loom home file
 * (named after the folder). Returns the .loom file.
 */
export async function scaffoldProject(app: App, rootPath: string): Promise<TFile> {
	const root = normalizePath(rootPath);
	await ensureFolder(app, root);
	for (const sub of PROJECT_SUBFOLDERS) {
		await ensureFolder(app, root + '/' + sub);
	}
	const timelinePath = root + '/' + TIMELINES_FOLDER + '/Main timeline.md';
	if (!app.vault.getFileByPath(timelinePath)) {
		await app.vault.create(
			timelinePath,
			[
				'---',
				'name: Main timeline',
				'types: [session, event]',
				'tags: []',
				'---',
				'',
				'Timeline definition. `types` lists which entity types populate it',
				'(session, event); `tags` optionally filters to entities carrying one',
				'of those plugin tags.',
				'',
			].join('\n')
		);
	}
	const baseName = root.split('/').pop() ?? 'Project';
	const loomPath = normalizePath(`${root}/${baseName}.${LOOM_EXTENSION}`);
	const existing = app.vault.getFileByPath(loomPath);
	if (existing) return existing;
	return app.vault.create(loomPath, serializeProjectConfig(defaultProjectConfig()));
}

export function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

function yamlQuote(value: string): string {
	return JSON.stringify(value);
}

export interface NewEntityFields {
	name: string;
	tag: string;
	date: string;
	/** When set, the new note declares this relationship in its frontmatter. */
	relationship?: { type: string; target: string };
}

export function buildEntityContent(type: EntityType, fields: NewEntityFields): string {
	const rel = fields.relationship;
	const lines = [
		'---',
		`type: ${type}`,
		`loomTags: [${fields.tag === '' ? '' : yamlQuote(fields.tag)}]`,
		'description: ""',
		...(rel
			? [
					'relationships:',
					`  - type: ${yamlQuote(rel.type)}`,
					`    target: ${yamlQuote(`[[${rel.target}]]`)}`,
				]
			: ['relationships: []']),
	];
	if (type === 'character') lines.push('role: ""', 'alive: true');
	if (type === 'event' || type === 'session') lines.push(`date: ${yamlQuote(fields.date)}`);
	if (type === 'event') lines.push('linkedSession: []');
	if (type === 'session') lines.push('attendance: []');
	lines.push('---', '', '');
	return lines.join('\n');
}

/** Session file names are managed, never user-facing inside the plugin. */
export function sessionFileName(project: ProjectDef, dateRaw: string): string {
	return sanitizeFileName(`${project.name} Session ${dateRaw}`.trim()) || `Session ${dateRaw}`;
}

export async function createEntity(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	type: EntityType,
	fields: NewEntityFields
): Promise<TFile> {
	const folder = projectPath(project, ENTITY_META[type].folder);
	await ensureFolder(plugin.app, folder);
	const base =
		type === 'session'
			? sessionFileName(project, fields.date)
			: sanitizeFileName(fields.name) || `New ${ENTITY_META[type].label.toLowerCase()}`;
	let path = normalizePath(`${folder}/${base}.md`);
	for (let i = 2; plugin.app.vault.getAbstractFileByPath(path) !== null; i++) {
		path = normalizePath(`${folder}/${base} ${i}.md`);
	}
	return plugin.app.vault.create(path, buildEntityContent(type, fields));
}

export interface CreateEntityOptions {
	/** When set, called with the new file instead of opening its entity page. */
	onCreated?: (file: TFile) => void;
	/**
	 * When set, the modal also prompts for a relationship comment and the new
	 * entity is created already connected to this record (the new note declares
	 * the relationship). The entity page is not opened afterwards — the caller's
	 * view (e.g. the graph) shows the new connection in place.
	 */
	connectTo?: { record: EntityRecord; label: string };
}

export class CreateEntityModal extends Modal {
	private fields: NewEntityFields = { name: '', tag: '', date: '' };
	private relComment = '';

	constructor(
		private plugin: LoomLoomPlugin,
		private type: EntityType,
		private project: ProjectDef,
		private options: CreateEntityOptions = {}
	) {
		super(plugin.app);
		if (type === 'session' || type === 'event') this.fields.date = todayRaw();
	}

	onOpen(): void {
		const meta = ENTITY_META[this.type];
		this.setTitle(`New ${meta.label.toLowerCase()}`);

		if (this.type !== 'session') {
			new Setting(this.contentEl).setName('Name').addText((text) => {
				text.setPlaceholder(meta.label + ' name').onChange((v) => (this.fields.name = v.trim()));
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') void this.submit();
				});
				window.setTimeout(() => text.inputEl.focus());
			});
		}

		const vocab = ENTITY_TAGS[this.type];
		if (vocab.length > 0) {
			new Setting(this.contentEl).setName('Tag').addDropdown((dd) => {
				dd.addOption('', '—');
				for (const tag of vocab) dd.addOption(tag, tag);
				dd.onChange((v) => (this.fields.tag = v));
			});
		}

		if (this.type === 'event' || this.type === 'session') {
			new Setting(this.contentEl)
				.setName('Date')
				.setDesc('Year-month-day format.')
				.addText((text) =>
					text.setValue(this.fields.date).onChange((v) => (this.fields.date = v.trim()))
				);
		}

		const connectTo = this.options.connectTo;
		if (connectTo) {
			new Setting(this.contentEl)
				.setName('Relationship')
				.setDesc(`How the new ${meta.label.toLowerCase()} relates to ${connectTo.label}.`)
				.addText((text) =>
					text.setPlaceholder('Identifier').onChange((v) => (this.relComment = v.trim()))
				);
		}

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText('Create')
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		if (this.type !== 'session' && this.fields.name === '') {
			new Notice('Name is required.');
			return;
		}
		if (this.type === 'session' && this.fields.date === '') {
			new Notice('Date is required.');
			return;
		}
		const connectTo = this.options.connectTo;
		if (connectTo) {
			this.fields.relationship = {
				type: this.relComment === '' ? 'related' : this.relComment,
				target: connectTo.record.name,
			};
		}
		try {
			const file = await createEntity(this.plugin, this.project, this.type, this.fields);
			this.close();
			if (this.options.onCreated) this.options.onCreated(file);
			else if (!connectTo) {
				// The new page's Back goes to the type's list — the closest
				// thing to an origin a modal-created entity has.
				const origin: EntityOrigin = {
					type: VIEW_LIST,
					state: { project: this.project.root, entityType: this.type },
				};
				this.plugin.openEntityFile(file.path, origin);
			}
		} catch (e) {
			console.error('Loom Loom: failed to create entity', e);
			new Notice('Could not create the note. See console for details.');
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Folder suggestions attached to a plain text input: typing searches existing
 * vault folders, but any path (including one that doesn't exist yet) stays
 * typeable — unlike a pick-only fuzzy modal.
 */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	/** Whether the popup is showing — lets the host input tell "Enter picks a
	 *  suggestion" apart from "Enter means submit". */
	suggestionsShown = false;

	constructor(app: App, private input: HTMLInputElement) {
		super(app, input);
	}

	open(): void {
		super.open();
		this.suggestionsShown = true;
	}

	close(): void {
		super.close();
		this.suggestionsShown = false;
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllFolders()
			.filter((f) => f.path.toLowerCase().includes(q))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		// Fire the input event so the wrapping TextComponent's onChange sees it.
		this.input.trigger('input');
		this.close();
	}
}

export class SetupProjectModal extends Modal {
	/** 'create' scaffolds a new folder named after the project inside `dir`;
	 *  'use' turns `dir` itself into the project folder. */
	private mode: 'create' | 'use' = 'create';
	private dir = '';
	private name = '';

	constructor(private plugin: LoomLoomPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle('Set up project');
		this.render();
	}

	private render(): void {
		this.contentEl.empty();

		const pills = this.contentEl.createDiv({ cls: 'loom-tab-bar' });
		const pill = (mode: 'create' | 'use', label: string) => {
			const btn = pills.createEl('button', {
				cls: 'loom-tab' + (this.mode === mode ? ' loom-tab-active' : ''),
				text: label,
			});
			btn.addEventListener('click', () => {
				this.mode = mode;
				this.render();
			});
		};
		pill('create', 'Create a project folder');
		pill('use', 'Use existing folder');

		if (this.mode === 'create') {
			new Setting(this.contentEl)
				.setName('Project name')
				.setDesc('A folder with this name is created in the chosen location.')
				.addText((text) => {
					text.setPlaceholder('My Loom project')
						.setValue(this.name)
						.onChange((v) => (this.name = v.trim()));
					text.inputEl.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') void this.submit();
					});
					window.setTimeout(() => text.inputEl.focus());
				});
		}

		new Setting(this.contentEl)
			.setName(this.mode === 'create' ? 'Location' : 'Project folder')
			.setDesc(
				this.mode === 'create'
					? 'Where the project folder is created. Leave empty for the vault root.'
					: 'This folder becomes the project folder; entity subfolders and the home file are scaffolded inside it.'
			)
			.addText((text) => {
				text.setPlaceholder('Pick a folder')
					.setValue(this.dir)
					.onChange((v) => (this.dir = v.trim()));
				const suggest = new FolderSuggest(this.app, text.inputEl);
				text.inputEl.addEventListener('keydown', (e) => {
					// With the popup open, Enter picks the highlighted folder
					// (handled by the suggest's scope); only a second Enter submits.
					if (e.key === 'Enter' && !suggest.suggestionsShown) void this.submit();
				});
			});

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText('Create project')
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		let root: string;
		if (this.mode === 'create') {
			const name = sanitizeFileName(this.name);
			if (name === '') {
				new Notice('Project name is required.');
				return;
			}
			root = this.dir === '' ? name : `${this.dir}/${name}`;
		} else {
			if (this.dir === '') {
				new Notice('Folder path is required.');
				return;
			}
			root = this.dir;
		}
		try {
			const loomFile = await scaffoldProject(this.app, root);
			this.plugin.indexer.rebuild();
			this.close();
			new Notice('Project ready.');
			await this.app.workspace.getLeaf('tab').openFile(loomFile);
		} catch (e) {
			console.error('Loom Loom: failed to scaffold project', e);
			new Notice('Could not set up the project. See console for details.');
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private detail: string,
		private onConfirm: () => void | Promise<void>,
		private confirmText = 'Continue'
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.contentEl.createEl('p', { text: this.detail });
		new Setting(this.contentEl)
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((btn) => {
				// mod-warning by class: setWarning() is deprecated and its
				// replacement (setDestructive) is 1.13/Catalyst-only.
				btn.setButtonText(this.confirmText).onClick(() => {
					this.close();
					void this.onConfirm();
				});
				btn.buttonEl.addClass('mod-warning');
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class EntityTypeSuggestModal extends FuzzySuggestModal<EntityType> {
	constructor(plugin: LoomLoomPlugin, private onPick: (type: EntityType) => void) {
		super(plugin.app);
		this.setPlaceholder('Pick the entity type');
	}

	getItems(): EntityType[] {
		return [...ENTITY_TYPES];
	}

	getItemText(type: EntityType): string {
		return ENTITY_META[type].label;
	}

	onChooseItem(type: EntityType): void {
		this.onPick(type);
	}
}

export class ProjectSuggestModal extends FuzzySuggestModal<ProjectDef> {
	constructor(private plugin: LoomLoomPlugin, private onPick: (project: ProjectDef) => void) {
		super(plugin.app);
		this.setPlaceholder('Pick a project');
	}

	getItems(): ProjectDef[] {
		return this.plugin.indexer.getProjects();
	}

	getItemText(project: ProjectDef): string {
		return project.name;
	}

	onChooseItem(project: ProjectDef): void {
		this.onPick(project);
	}
}
