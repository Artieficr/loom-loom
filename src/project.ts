import {
	AbstractInputSuggest,
	App,
	FuzzySuggestModal,
	Menu,
	Modal,
	Notice,
	Setting,
	TextComponent,
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
	FM,
	LOOM_EXTENSION,
	TIMELINES_FOLDER,
	VIEW_LIST,
} from './types';
import { defaultProjectConfig, formatLoomDate, serializeProjectConfig, todayRaw } from './calendar';
import { managedEntityFileName, managedSessionFileName, sanitizeFileName } from './naming';
import { ProjectDef, linkTargetOf } from './indexer';
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
				`${FM.name}: Main timeline`,
				`${FM.timelineTypes}: [session, event]`,
				`${FM.tags}: []`,
				'---',
				'',
				`Timeline definition. \`${FM.timelineTypes}\` lists which entity types populate it`,
				`(session, event); \`${FM.tags}\` optionally filters to entities carrying one`,
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

export { sanitizeFileName } from './naming';

function yamlQuote(value: string): string {
	return JSON.stringify(value);
}

export interface NewEntityFields {
	name: string;
	tag: string;
	date: string;
	description?: string;
	/** When set, the new note declares this relationship in its frontmatter. */
	relationship?: { type: string; target: string };
	/** Location only: parent location name — the new location is its sublocation. */
	parentLocation?: string;
	/** Event only: entity names involved — written into the starting session
	 *  note's `involved` list (session-less for lore events). */
	involved?: string[];
	/** Session name to prefill a session note for (events created from a session page). */
	noteSession?: string;
	/** Quest only (all optional): note names, not links. New quests are always
	 *  born active — outcome fields are written empty. */
	questGivers?: string[];
	questReceived?: string;
	reward?: string;
}

export function buildEntityContent(type: EntityType, fields: NewEntityFields): string {
	const rels = fields.relationship ? [fields.relationship] : [];
	const lines = [
		'---',
		`${FM.type}: ${type}`,
		// Sessions have no user-entered name — their display is the date and
		// their file name is managed from it. Everyone else stores the entered
		// name (`loomName`, the display source of truth) plus a native alias so
		// Obsidian's own [[link]] autocomplete finds the note by that name.
		...(type !== 'session'
			? [`${FM.name}: ${yamlQuote(fields.name)}`, `aliases: [${yamlQuote(fields.name)}]`]
			: []),
		`${FM.tags}: [${fields.tag === '' ? '' : yamlQuote(fields.tag)}]`,
		`${FM.description}: ${yamlQuote(fields.description ?? '')}`,
		...(rels.length > 0
			? [
					`${FM.relationships}:`,
					...rels.flatMap((r) => [
						`  - type: ${yamlQuote(r.type)}`,
						`    target: ${yamlQuote(`[[${r.target}]]`)}`,
					]),
				]
			: [`${FM.relationships}: []`]),
	];
	// A starting session note carries the birth session and/or the involved
	// entities. Involvement without a session (a lore event) writes a
	// session-less note — involved links still connect (relType `involved`).
	const involved = fields.involved ?? [];
	if ((fields.noteSession && fields.noteSession !== '') || involved.length > 0) {
		lines.push(
			`${FM.sessionNotes}:`,
			`  - session: ${
				fields.noteSession && fields.noteSession !== '' ? yamlQuote(`[[${fields.noteSession}]]`) : '""'
			}`,
			'    text: ""',
			`    seq: ${Date.now()}`
		);
		if (involved.length > 0) {
			lines.push('    involved:');
			for (const n of involved) lines.push(`      - ${yamlQuote(`[[${n}]]`)}`);
		}
	}
	if (type === 'location' && fields.parentLocation && fields.parentLocation !== '') {
		lines.push(`${FM.parentLocation}: ${yamlQuote(`[[${fields.parentLocation}]]`)}`);
	}
	if (type === 'character') lines.push(`${FM.alive}: true`);
	if (type === 'event' || type === 'session') lines.push(`${FM.date}: ${yamlQuote(fields.date)}`);
	if (type === 'session') lines.push(`${FM.attendance}: []`);
	if (type === 'quest') {
		const link = (name?: string) => (name && name !== '' ? yamlQuote(`[[${name}]]`) : '""');
		const givers = (fields.questGivers ?? []).filter((n) => n !== '');
		lines.push(
			givers.length > 0
				? `${FM.questGiver}: [${givers.map((n) => yamlQuote(`[[${n}]]`)).join(', ')}]`
				: `${FM.questGiver}: []`,
			`${FM.questReceived}: ${link(fields.questReceived)}`,
			`${FM.questOutcome}: ""`,
			`${FM.questOutcomeSession}: ""`,
			`${FM.reward}: ${yamlQuote(fields.reward ?? '')}`
		);
	}
	lines.push('---', '', '');
	return lines.join('\n');
}

/**
 * Fuzzy-searchable picker over entity records — for choices that can grow
 * huge with a project (e.g. "Turn to a sublocation" over every location).
 */
export class RecordSuggestModal extends FuzzySuggestModal<EntityRecord> {
	constructor(
		app: App,
		private records: EntityRecord[],
		private onPick: (record: EntityRecord) => void,
		placeholder?: string
	) {
		super(app);
		if (placeholder) this.setPlaceholder(placeholder);
	}

	getItems(): EntityRecord[] {
		return this.records;
	}

	getItemText(record: EntityRecord): string {
		return record.name;
	}

	onChooseItem(record: EntityRecord): void {
		this.onPick(record);
	}
}

/**
 * Inline record search attached to a plain text input (modal counterpart of
 * the views' SearchableSelect): typing filters, picking hands the record over
 * and clears the input for the next pick.
 */
class RecordInputSuggest extends AbstractInputSuggest<EntityRecord> {
	constructor(
		app: App,
		private input: HTMLInputElement,
		private records: () => EntityRecord[],
		private pick: (r: EntityRecord) => void,
		private label: (r: EntityRecord) => string = (r) => r.name
	) {
		super(app, input);
	}

	getSuggestions(query: string): EntityRecord[] {
		const q = query.toLowerCase();
		return this.records().filter(
			(r) => r.name.toLowerCase().includes(q) || this.label(r).toLowerCase().includes(q)
		);
	}

	renderSuggestion(r: EntityRecord, el: HTMLElement): void {
		el.setText(this.label(r));
	}

	selectSuggestion(r: EntityRecord): void {
		this.pick(r);
		this.input.value = '';
		this.close();
	}
}

/** Session file names are managed, never user-facing inside the plugin. */
export function sessionFileName(project: ProjectDef, dateRaw: string): string {
	return managedSessionFileName(project.name, dateRaw);
}

/**
 * Managed entity file name: `<Project> <Type label> <name>` (sessions use
 * `sessionFileName` with their date instead). The user-entered name lives in
 * `loomName` frontmatter and is what every plugin surface displays and
 * searches; the file name exists for the file explorer and link targets.
 */
export function entityFileName(project: ProjectDef, type: EntityType, name: string): string {
	return managedEntityFileName(project.name, type, name);
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
		type === 'session' ? sessionFileName(project, fields.date) : entityFileName(project, type, fields.name);
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
	/** Locations only: the new location is created as this one's sublocation
	 *  (writes `parentLocation`, not a relationship). */
	parentLocation?: EntityRecord;
	/** The new entity starts with a session note pinned to this session. */
	noteSession?: EntityRecord;
	/** Events only: offer a session search in the modal (optional pick — a
	 *  lore event stays session-less). Ignored when `noteSession` is set. */
	sessionPicker?: boolean;
	/** Events only: names pre-added to the involved list (still removable) —
	 *  e.g. the character whose page spawned the event. */
	defaultInvolved?: string[];
	/** Prefills the Name field (e.g. "+ Create …" from a [[link completion). */
	initialName?: string;
}

export class CreateEntityModal extends Modal {
	private fields: NewEntityFields = { name: '', tag: '', date: '' };
	private relComment = '';
	/** Event only: session picked via the modal's session search. */
	private pickedSession: EntityRecord | null = null;
	/** Quest only: session the quest was received in. */
	private receivedSession: EntityRecord | null = null;

	constructor(
		private plugin: LoomLoomPlugin,
		private type: EntityType,
		private project: ProjectDef,
		private options: CreateEntityOptions = {}
	) {
		super(plugin.app);
		// Sessions are always dated (they represent actual play happening
		// today); events often aren't (e.g. a recurring holiday with no
		// specific occurrence), so only sessions get a default.
		if (type === 'session') this.fields.date = todayRaw();
		if (options.defaultInvolved && options.defaultInvolved.length > 0) {
			this.fields.involved = [...options.defaultInvolved];
		}
		if (options.initialName) this.fields.name = options.initialName.trim();
	}

	/** Standard entity tag (see EntityChip in views/common.tsx) for modal chip rows. */
	private renderChip(
		container: HTMLElement,
		record: EntityRecord | null,
		label: string,
		onRemove: () => void
	): void {
		const chip = container.createSpan({ cls: 'loom-chip loom-session-chip loom-entity-chip' });
		if (record) {
			const color = this.plugin.settings.nodeColors[record.type];
			chip.style.background = color + '40';
			chip.style.borderColor = color;
		}
		chip.createSpan({ text: label });
		const x = chip.createEl('button', { text: '✕', cls: 'loom-chip-remove' });
		x.addEventListener('click', (e) => {
			e.preventDefault();
			onRemove();
		});
	}

	/** Resolves a picked name back to its record (for chip colors). */
	private resolveName(name: string): EntityRecord | null {
		return this.plugin.indexer.resolve(name, this.project.loomPath);
	}

	onOpen(): void {
		const meta = ENTITY_META[this.type];
		this.setTitle(this.options.parentLocation ? 'New sublocation' : `New ${meta.label.toLowerCase()}`);

		if (this.type !== 'session') {
			new Setting(this.contentEl).setName('Name').addText((text) => {
				text
					.setPlaceholder(meta.label + ' name')
					.setValue(this.fields.name)
					.onChange((v) => (this.fields.name = v.trim()));
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') void this.submit();
				});
				window.setTimeout(() => text.inputEl.focus());
			});
		}

	const vocab = ENTITY_TAGS[this.type];
		if (vocab.length > 0) {
			// Segmented pills: outer corners rounded, shared borders between.
			const setting = new Setting(this.contentEl).setName('Tag');
			const seg = setting.controlEl.createDiv({ cls: 'loom-seg' });
			const buttons: HTMLButtonElement[] = [];
			const refresh = () => {
				for (const b of buttons) b.classList.toggle('loom-seg-on', this.fields.tag === b.dataset.tag);
			};
			for (const opt of [{ v: '', label: '—' }, ...vocab.map((t) => ({ v: t, label: t }))]) {
				const b = seg.createEl('button', { text: opt.label, cls: 'loom-seg-btn' });
				b.dataset.tag = opt.v;
				b.addEventListener('click', (e) => {
					e.preventDefault();
					this.fields.tag = opt.v;
					refresh();
				});
				buttons.push(b);
			}
			refresh();
		}

		if (this.type === 'quest') {
			// New quests are always active — no outcome fields here; they live
			// on the quest page once the quest actually ends.
			const sessionLabel = (s: EntityRecord) =>
				s.date ? formatLoomDate(s.date, this.project.config) : s.name;
			const sessions = this.plugin.indexer
				.getAll('session', this.project.root)
				.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0));
			const characters = this.plugin.indexer
				.getAll('character', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));

			// Quest givers: search + entity tags with ✕, like the quest page.
			this.fields.questGivers = [];
			new Setting(this.contentEl).setName('Quest giver').addText((text) => {
				text.setPlaceholder('Add a quest giver…');
				new RecordInputSuggest(
					this.app,
					text.inputEl,
					() => characters.filter((c) => !(this.fields.questGivers ?? []).includes(linkTargetOf(c))),
					(r) => {
						(this.fields.questGivers ??= []).push(linkTargetOf(r));
						refreshGivers();
					}
				);
			});
			const giverChips = this.contentEl.createDiv({ cls: 'loom-modal-chips' });
			const refreshGivers = () => {
				giverChips.empty();
				for (const target of this.fields.questGivers ?? []) {
					const rec = this.resolveName(target);
					this.renderChip(giverChips, rec, rec?.name ?? target, () => {
						this.fields.questGivers = (this.fields.questGivers ?? []).filter((n) => n !== target);
						refreshGivers();
					});
				}
			};

			// Received session: search like the quest page; the pick becomes a
			// session tag with ✕. Quests born from a session page default there.
			this.receivedSession = this.options.noteSession ?? null;
			const receivedSetting = new Setting(this.contentEl).setName('Received in session');
			const receivedEl = receivedSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
			const refreshReceived = () => {
				receivedEl.empty();
				if (this.receivedSession) {
					this.renderChip(receivedEl, this.receivedSession, sessionLabel(this.receivedSession), () => {
						this.receivedSession = null;
						refreshReceived();
					});
				} else {
					const input = receivedEl.createEl('input', {
						type: 'text',
						attr: { placeholder: 'Pick the session…' },
					});
					new RecordInputSuggest(
						this.app,
						input,
						() => sessions,
						(r) => {
							this.receivedSession = r;
							refreshReceived();
						},
						sessionLabel
					);
				}
			};
			refreshReceived();

			new Setting(this.contentEl)
				.setName('Reward')
				.addText((text) =>
					text.setPlaceholder('Not specified').onChange((v) => (this.fields.reward = v.trim()))
				);
			// Full-width row: label above, the text box using the whole window width.
			const desc = new Setting(this.contentEl)
				.setName('Description')
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			desc.setClass('loom-modal-wide');
		}

		if (this.type === 'session') {
			// Sessions are always Gregorian, so a native date input's calendar
			// picker applies cleanly — no free-text/custom-calendar ambiguity
			// like events have, and it already lands on today by default.
			new Setting(this.contentEl).setName('Date').addText((text) => {
				text.inputEl.type = 'date';
				text.setValue(this.fields.date).onChange((v) => (this.fields.date = v));
			});
		}

	if (this.type === 'event') {
			// Optional birth session (skipped when the session page already
			// provides it): search over sessions, the pick becomes a session tag
			// with ✕. Left unspecified = a lore event with no session.
			if (this.options.sessionPicker && !this.options.noteSession) {
				const sessionLabel = (s: EntityRecord) =>
					s.date ? formatLoomDate(s.date, this.project.config) : s.name;
				const sessions = this.plugin.indexer
					.getAll('session', this.project.root)
					.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0));
				const sessionSetting = new Setting(this.contentEl)
					.setName('Session')
					.setDesc('When it happened; leave unspecified for lore events.');
				const sessionEl = sessionSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
				const refreshSession = () => {
					sessionEl.empty();
					if (this.pickedSession) {
						this.renderChip(sessionEl, this.pickedSession, sessionLabel(this.pickedSession), () => {
							this.pickedSession = null;
							refreshSession();
						});
					} else {
						const input = sessionEl.createEl('input', {
							type: 'text',
							attr: { placeholder: 'Not specified' },
						});
						new RecordInputSuggest(
							this.app,
							input,
							() => sessions,
							(r) => {
								this.pickedSession = r;
								refreshSession();
							},
							sessionLabel
						);
					}
				};
				refreshSession();
			}

			// Involved entities: search with a type filter; picks collect as
			// entity tags with ✕ (mirrors the pages' Involve… control).
			let involveFilter: EntityType | null = null;
			const candidates = () =>
				this.plugin.indexer
					.getAll(undefined, this.project.root)
					.filter((r) => r.type !== 'session' && r.type !== 'event')
					.filter((r) => involveFilter === null || r.type === involveFilter)
					.filter((r) => !(this.fields.involved ?? []).includes(linkTargetOf(r)))
					.sort((a, b) => a.name.localeCompare(b.name));
			new Setting(this.contentEl)
				.setName('Involved entities')
				.addText((text) => {
					text.setPlaceholder('Involve…');
					new RecordInputSuggest(this.app, text.inputEl, candidates, (r) => {
						(this.fields.involved ??= []).push(linkTargetOf(r));
						refreshInvolved();
					});
				})
				.addExtraButton((btn) => {
					btn.setIcon('filter').setTooltip('Filter suggestions by entity type');
					btn.extraSettingsEl.addEventListener('click', (e) => {
						const menu = new Menu();
						menu.addItem((item) =>
							item
								.setTitle('All entities')
								.setIcon('filter')
								.setChecked(involveFilter === null)
								.onClick(() => {
									involveFilter = null;
									btn.setIcon('filter');
								})
						);
						for (const t of ENTITY_TYPES.filter((t) => t !== 'session' && t !== 'event')) {
							menu.addItem((item) =>
								item
									.setTitle(ENTITY_META[t].plural)
									.setIcon(ENTITY_META[t].icon)
									.setChecked(involveFilter === t)
									.onClick(() => {
										involveFilter = t;
										btn.setIcon(ENTITY_META[t].icon);
									})
							);
						}
						menu.showAtMouseEvent(e);
					});
				});
			const involvedChips = this.contentEl.createDiv({ cls: 'loom-modal-chips' });
			const refreshInvolved = () => {
				involvedChips.empty();
				for (const target of this.fields.involved ?? []) {
					const rec = this.resolveName(target);
					this.renderChip(involvedChips, rec, rec?.name ?? target, () => {
						this.fields.involved = (this.fields.involved ?? []).filter((n) => n !== target);
						refreshInvolved();
					});
				}
			};
			refreshInvolved();
		}

		// Events born from a session page need no date — the session carries it.
		// (The Involved picker below writes into that session note, so it only
		// appears for session-born events.)
		if (this.type === 'event' && !this.options.noteSession) {
			let dateText: TextComponent;
			new Setting(this.contentEl)
				.setName('Date')
				.setDesc('Year-month-day format.')
				.addText((text) => {
					dateText = text;
					text
						.setPlaceholder('Year-month-day')
						.setValue(this.fields.date)
						.onChange((v) => (this.fields.date = v.trim()));
				})
				.addExtraButton((btn) =>
					btn
						.setIcon('calendar')
						.setTooltip('Set to today')
						.onClick(() => {
							this.fields.date = todayRaw();
							dateText.setValue(this.fields.date);
						})
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
				target: linkTargetOf(connectTo.record),
			};
		}
	if (this.options.parentLocation) this.fields.parentLocation = linkTargetOf(this.options.parentLocation);
		if (this.options.noteSession) this.fields.noteSession = linkTargetOf(this.options.noteSession);
		else if (this.pickedSession) this.fields.noteSession = linkTargetOf(this.pickedSession);
		if (this.type === 'quest')
			this.fields.questReceived = this.receivedSession ? linkTargetOf(this.receivedSession) : '';
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

/**
 * Prompts for a relationship identifier when connecting two existing entities
 * (graph node-on-node drop). Empty input falls back to 'related', matching
 * the entity page's relationships editor.
 */
export class RelationshipPromptModal extends Modal {
	private value = '';

	constructor(
		app: App,
		private fromLabel: string,
		private toLabel: string,
		private onSubmit: (relType: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Connect entities');
		new Setting(this.contentEl)
			.setName('Relationship')
			.setDesc(`How ${this.fromLabel} relates to ${this.toLabel}.`)
			.addText((text) => {
				text.setPlaceholder('Identifier').onChange((v) => (this.value = v.trim()));
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') this.submit();
				});
				window.setTimeout(() => text.inputEl.focus());
			});
		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText('Connect')
				.setCta()
				.onClick(() => this.submit())
		);
	}

	private submit(): void {
		this.close();
		this.onSubmit(this.value === '' ? 'related' : this.value);
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
