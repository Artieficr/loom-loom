import {
	AbstractInputSuggest,
	App,
	ButtonComponent,
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
	DEFAULT_MEMBER_ROLE,
	ENTITY_META,
	ENTITY_TAGS,
	ENTITY_TYPES,
	EntityOrigin,
	EntityRecord,
	EntityType,
	FM,
	LOOM_EXTENSION,
	PC_GROUP_VALUE,
	TIMELINES_FOLDER,
	VIEW_LIST,
	pcGroupStub,
} from './types';
import { defaultProjectConfig, formatLoomDate, groupNameOf, serializeProjectConfig, todayRaw } from './calendar';
import { managedEntityFileName, managedSessionFileName, sanitizeFileName } from './naming';
import { ProjectDef, linkTargetOf } from './indexer';
import { fmLoomValue, setLoomKey } from './fm';
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
	/** Event only: virtual-Group snapshot (current party's names) — written into
	 *  the starting note's `group` list, rendered as one "Group" chip. */
	group?: string[];
	/** Event only: location names for the starting note's `places` (events
	 *  created from a location page). */
	places?: string[];
	/** Session name to prefill a session note for (events created from a session page). */
	noteSession?: string;
	/** Quest only (all optional): note names, not links. New quests are always
	 *  born active — outcome fields are written empty. */
	questGivers?: string[];
	questReceived?: string;
	reward?: string;
	/** Character only: faction memberships to add after creation (written into
	 *  each faction's `members`, not the character's own file). Names, not links. */
	factions?: { faction: string; role: string; location: string }[];
	/** Faction only: member characters written into this faction's own `members`. */
	members?: { character: string; role: string; location: string }[];
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
	const group = fields.group ?? [];
	const places = fields.places ?? [];
	if (
		(fields.noteSession && fields.noteSession !== '') ||
		involved.length > 0 ||
		group.length > 0 ||
		places.length > 0
	) {
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
		if (group.length > 0) {
			lines.push('    group:');
			for (const n of group) lines.push(`      - ${yamlQuote(`[[${n}]]`)}`);
		}
		if (places.length > 0) {
			lines.push('    places:');
			for (const p of places) lines.push(`      - ${yamlQuote(`[[${p}]]`)}`);
		}
	}
	if (type === 'location' && fields.parentLocation && fields.parentLocation !== '') {
		lines.push(`${FM.parentLocation}: ${yamlQuote(`[[${fields.parentLocation}]]`)}`);
	}
	if (type === 'faction') {
		const members = (fields.members ?? []).filter((m) => m.character !== '');
		if (members.length > 0) {
			lines.push(`${FM.members}:`);
			for (const m of members) {
				const roleIsDefault = m.role === '' || m.role.toLowerCase() === DEFAULT_MEMBER_ROLE.toLowerCase();
				if (roleIsDefault && m.location === '') {
					lines.push(`  - ${yamlQuote(`[[${m.character}]]`)}`);
				} else {
					lines.push(`  - character: ${yamlQuote(`[[${m.character}]]`)}`);
					if (!roleIsDefault) lines.push(`    role: ${yamlQuote(m.role)}`);
					if (m.location !== '') lines.push(`    location: ${yamlQuote(`[[${m.location}]]`)}`);
				}
			}
		} else {
			lines.push(`${FM.members}: []`);
		}
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

/** One-line text prompt (rename, alias, date…). Enter or the CTA submits. */
export class TextInputModal extends Modal {
	constructor(
		app: App,
		private opts: {
			title: string;
			initial?: string;
			placeholder?: string;
			cta?: string;
			onSubmit: (value: string) => void;
		}
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		const input = this.contentEl.createEl('input', { type: 'text', cls: 'loom-modal-input' });
		input.value = this.opts.initial ?? '';
		if (this.opts.placeholder) input.placeholder = this.opts.placeholder;
		const submit = () => {
			const value = input.value.trim();
			if (value === '') return;
			this.close();
			this.opts.onSubmit(value);
		};
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') submit();
		});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText(this.opts.cta ?? 'Save')
				.setCta()
				.onClick(submit)
		);
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Search/display label of a record in pickers: session dates, sublocations
 *  as "Tavern, City A", everything else its name. */
export function recordPickLabel(plugin: LoomLoomPlugin, project: ProjectDef, r: EntityRecord): string {
	if (r.type === 'session' && r.date) return formatLoomDate(r.date, project.config);
	if (r.type === 'location' && r.parentLocation !== null) {
		const parent = plugin.indexer.resolve(r.parentLocation, r.path);
		if (parent?.type === 'location') return `${r.name}, ${parent.name}`;
	}
	return r.name;
}

/**
 * Renames an entity from outside its page: `loomName` + display alias +
 * managed file name (sessions are date-named — not renameable here).
 */
export async function renameEntityRecord(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	record: EntityRecord,
	rawName: string
): Promise<void> {
	const entered = rawName.trim();
	if (entered === '' || entered === record.name || record.type === 'session') return;
	const file = plugin.app.vault.getFileByPath(record.path);
	if (!file) return;
	const parentName =
		record.type === 'location' && record.parentLocation !== null
			? plugin.indexer.resolve(record.parentLocation, record.path)?.name
			: undefined;
	const base = managedEntityFileName(project.name, record.type, entered, parentName);
	const parent = file.parent?.path ?? '';
	const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
	if (newPath !== file.path && plugin.app.vault.getAbstractFileByPath(newPath)) {
		new Notice('A note with that name already exists.');
		return;
	}
	await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		setLoomKey(fm, FM.name, entered);
		const aliases: unknown[] = Array.isArray(fm.aliases)
			? (fm.aliases as unknown[]).filter((a) => a !== record.name && a !== entered)
			: [];
		fm.aliases = [entered, ...aliases];
	});
	if (newPath !== file.path) await plugin.app.fileManager.renameFile(file, newPath);
}

/**
 * Duplicates an entity as "<name> 1" (2, 3, … — first free number). Sessions
 * have no name: their copy keeps the date under a numbered file. Returns the
 * new file, or null when the source is missing.
 */
export async function copyEntityRecord(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	record: EntityRecord
): Promise<TFile | null> {
	const file = plugin.app.vault.getFileByPath(record.path);
	if (!file) return null;
	const content = await plugin.app.vault.read(file);
	const folder = file.parent?.path ?? '';
	const pathFor = (base: string, i: number) =>
		normalizePath(`${folder === '' ? '' : folder + '/'}${base}${i > 1 ? ` ${i}` : ''}.md`);
	if (record.type === 'session') {
		const base = sessionFileName(project, record.date?.raw ?? '');
		let i = 2; // "… 2" — the original occupies the plain name.
		while (plugin.app.vault.getAbstractFileByPath(pathFor(base, i)) !== null) i++;
		return plugin.app.vault.create(pathFor(base, i), content);
	}
	const names = new Set(plugin.indexer.getAll(undefined, project.root).map((r) => r.name));
	let n = 1;
	while (names.has(`${record.name} ${n}`)) n++;
	const newName = `${record.name} ${n}`;
	const parentName =
		record.type === 'location' && record.parentLocation !== null
			? plugin.indexer.resolve(record.parentLocation, record.path)?.name
			: undefined;
	const base = managedEntityFileName(project.name, record.type, newName, parentName);
	let i = 1;
	while (plugin.app.vault.getAbstractFileByPath(pathFor(base, i)) !== null) i++;
	const created = await plugin.app.vault.create(pathFor(base, i), content);
	await plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
		setLoomKey(fm, FM.name, newName);
		fm.aliases = [newName];
	});
	return created;
}

/** Two-field prompt (identifier + target search) appending one relationship
 *  to the record's own frontmatter — the list rows' "Add relationship". */
export class AddRelationshipModal extends Modal {
	private relType = '';
	private target: EntityRecord | null = null;

	constructor(
		private plugin: LoomLoomPlugin,
		private project: ProjectDef,
		private record: EntityRecord
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.setText('Add relationship');
		new Setting(this.contentEl).setName('Identifier').addText((t) => {
			t.setPlaceholder('Related');
			t.onChange((v) => (this.relType = v));
		});
		new Setting(this.contentEl).setName('Target').addText((t) => {
			t.setPlaceholder('Target note');
			new RecordInputSuggest(
				this.app,
				t.inputEl,
				() =>
					this.plugin.indexer
						.getAll(undefined, this.project.root)
						.filter((r) => r.path !== this.record.path)
						.sort((a, b) => a.name.localeCompare(b.name)),
				(r) => {
					this.target = r;
					t.setValue(recordPickLabel(this.plugin, this.project, r));
				},
				(r) => recordPickLabel(this.plugin, this.project, r),
				false
			);
		});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText('Add')
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		if (!this.target) {
			new Notice('Pick a target note.');
			return;
		}
		const file = this.plugin.app.vault.getFileByPath(this.record.path);
		if (!file) return;
		const link = `[[${linkTargetOf(this.target)}]]`;
		const relType = this.relType.trim() === '' ? 'related' : this.relType.trim();
		await this.plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const cur = fmLoomValue(fm, FM.relationships);
			const list = Array.isArray(cur) ? [...(cur as unknown[])] : [];
			list.push({ type: relType, target: link });
			setLoomKey(fm, FM.relationships, list);
		});
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Multi-pick search adding an item to several characters/locations at once —
 *  each pick collects as a chip, Add writes the item into every holder's
 *  `loomItems`. */
export class AddToHoldersModal extends Modal {
	private picked: EntityRecord[] = [];

	constructor(
		private plugin: LoomLoomPlugin,
		private project: ProjectDef,
		private item: EntityRecord,
		private holderType: 'character' | 'location'
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.setText(`Add "${this.item.name}" to ${ENTITY_META[this.holderType].plural.toLowerCase()}`);
		let chips: HTMLElement;
		const alreadyHolds = (r: EntityRecord) =>
			r.items.some((lp) => this.plugin.indexer.resolve(lp, r.path)?.path === this.item.path);
		new Setting(this.contentEl).setName(ENTITY_META[this.holderType].plural).addText((t) => {
			t.setPlaceholder('Search…');
			new RecordInputSuggest(
				this.app,
				t.inputEl,
				() =>
					this.plugin.indexer
						.getAll(this.holderType, this.project.root)
						.filter((r) => !this.picked.some((p) => p.path === r.path) && !alreadyHolds(r))
						.sort((a, b) => a.name.localeCompare(b.name)),
				(r) => {
					this.picked.push(r);
					refresh();
				},
				(r) => recordPickLabel(this.plugin, this.project, r)
			);
		});
		chips = this.contentEl.createDiv({ cls: 'loom-modal-chips' });
		const refresh = () => {
			chips.empty();
			for (const r of this.picked) {
				renderChipEl(this.plugin, chips, r, recordPickLabel(this.plugin, this.project, r), () => {
					this.picked = this.picked.filter((p) => p.path !== r.path);
					refresh();
				});
			}
		};
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText('Add')
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		if (this.picked.length === 0) {
			new Notice(`Pick at least one ${ENTITY_META[this.holderType].label.toLowerCase()}.`);
			return;
		}
		const link = `[[${linkTargetOf(this.item)}]]`;
		for (const holder of this.picked) {
			const file = this.plugin.app.vault.getFileByPath(holder.path);
			if (!file) continue;
			await this.plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				const cur = fmLoomValue(fm, FM.items);
				const list = Array.isArray(cur) ? [...(cur as unknown[])] : [];
				list.push(link);
				setLoomKey(fm, FM.items, list);
			});
		}
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Standard entity chip markup for non-React surfaces (see EntityChip in
 *  views/common.tsx — replicate, never hand-roll). */
export function renderChipEl(
	plugin: LoomLoomPlugin,
	container: HTMLElement,
	record: EntityRecord | null,
	label: string,
	onRemove?: () => void
): void {
	const chip = container.createSpan({ cls: 'loom-chip loom-session-chip loom-entity-chip' });
	if (record) {
		const color =
			record.path === PC_GROUP_VALUE ? plugin.settings.groupColor : plugin.settings.nodeColors[record.type];
		chip.style.background = color + '40';
		chip.style.borderColor = color;
	}
	chip.createSpan({ text: label });
	if (onRemove) {
		const x = chip.createEl('button', { text: '✕', cls: 'loom-chip-remove' });
		x.addEventListener('click', (e) => {
			e.preventDefault();
			onRemove();
		});
	}
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
		placeholder?: string,
		/** Display/search text; defaults to the record name (sessions have no
		 *  name, so pass recordLabel to search them by date). */
		private label: (record: EntityRecord) => string = (r) => r.name
	) {
		super(app);
		if (placeholder) this.setPlaceholder(placeholder);
	}

	getItems(): EntityRecord[] {
		return this.records;
	}

	getItemText(record: EntityRecord): string {
		return this.label(record);
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
		private label: (r: EntityRecord) => string = (r) => r.name,
		/** Multi-pick inputs (involved, givers) clear after each pick; a single-
		 *  value field (the searchable Name) keeps the pick's text instead. */
		private clearOnPick = true
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
		if (this.clearOnPick) this.input.value = '';
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
export function entityFileName(
	project: ProjectDef,
	type: EntityType,
	name: string,
	parentName?: string
): string {
	return managedEntityFileName(project.name, type, name, parentName);
}

export async function createEntity(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	type: EntityType,
	fields: NewEntityFields
): Promise<TFile> {
	const folder = projectPath(project, ENTITY_META[type].folder);
	await ensureFolder(plugin.app, folder);
	// A new sublocation embeds its parent's name in the file name.
	const parentName =
		type === 'location' && fields.parentLocation && fields.parentLocation !== ''
			? plugin.indexer.resolve(fields.parentLocation, '')?.name
			: undefined;
	const base =
		type === 'session'
			? sessionFileName(project, fields.date)
			: entityFileName(project, type, fields.name, parentName);
	let path = normalizePath(`${folder}/${base}.md`);
	for (let i = 2; plugin.app.vault.getAbstractFileByPath(path) !== null; i++) {
		path = normalizePath(`${folder}/${base} ${i}.md`);
	}
	return plugin.app.vault.create(path, buildEntityContent(type, fields));
}

/**
 * Creates a character-specific copy of `original`: a new item note named
 * `<Project> Item <original> — <character>`, its `loomName`/aliases carrying the
 * "<original> [<character>]" label, and `loomItemOrigin`/`loomItemOwner` links
 * back to both. Its own description starts empty (the copy falls back to the
 * original's until an alternative is written). Returns the new file.
 */
export async function createItemCopy(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	original: EntityRecord,
	character: EntityRecord
): Promise<TFile> {
	const folder = projectPath(project, ENTITY_META.item.folder);
	await ensureFolder(plugin.app, folder);
	const base = managedEntityFileName(project.name, 'item', original.name, undefined, character.name);
	let path = normalizePath(`${folder}/${base}.md`);
	for (let i = 2; plugin.app.vault.getAbstractFileByPath(path) !== null; i++) {
		path = normalizePath(`${folder}/${base} ${i}.md`);
	}
	const label = `${original.name} [${character.name}]`;
	// Every alias of the original gains the "[character]" suffix so native
	// [[…]] search offers "Excalibur [Arthur]" for each of the original's names.
	const origFile = plugin.app.vault.getFileByPath(original.path);
	const origAliases = origFile
		? ((plugin.app.metadataCache.getFileCache(origFile)?.frontmatter?.aliases as unknown) ?? [])
		: [];
	const aliasLabels = [
		label,
		...(Array.isArray(origAliases) ? origAliases : [])
			.filter((a): a is string => typeof a === 'string' && a.trim() !== '' && a !== original.name)
			.map((a) => `${a} [${character.name}]`),
	];
	// processFrontMatter writes block style (`- Excalibur [Arthur]`), which stays
	// valid YAML when Obsidian rewrites the file on later renames — a raw flow
	// list (`["…"]`) gets its quotes stripped and breaks the alias mechanic.
	const file = await plugin.app.vault.create(path, '');
	await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		setLoomKey(fm, FM.type, 'item');
		setLoomKey(fm, FM.name, label);
		setLoomKey(fm, FM.itemOrigin, `[[${linkTargetOf(original)}]]`);
		setLoomKey(fm, FM.itemOwner, `[[${linkTargetOf(character)}]]`);
		setLoomKey(fm, FM.description, '');
		fm.aliases = aliasLabels;
	});
	return file;
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
	/** Events only: names pre-added to the involved list (still removable) —
	 *  e.g. the character whose page spawned the event. */
	defaultInvolved?: string[];
	/** Events only: location name pre-added to the starting note's places —
	 *  e.g. the location whose page spawned the event. */
	defaultPlace?: string;
	/** Events only: names pre-added as the starting note's virtual-Group
	 *  snapshot — the Group page's "+ Create new event". */
	defaultGroup?: string[];
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
	/** Event/quest from a session page: an existing entity chosen in the Name
	 *  search — submit pins it to the session instead of creating a duplicate. */
	private pickedExisting: EntityRecord | null = null;
	/** The primary button; its label flips to "Add" once an existing
	 *  event/quest is picked (it will be pinned, not created). */
	private submitBtn: ButtonComponent | null = null;

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
		if (options.defaultPlace) this.fields.places = [options.defaultPlace];
		if (options.defaultGroup && options.defaultGroup.length > 0) {
			this.fields.group = [...options.defaultGroup];
		}
		if (options.initialName) this.fields.name = options.initialName.trim();
	}

	/** Segmented tag pills (— + the type's vocab), like the character-page tags. */
	private renderTagPills(): void {
		const vocab = ENTITY_TAGS[this.type];
		if (vocab.length === 0) return;
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

	/** Standard entity tag (see EntityChip in views/common.tsx) for modal chip rows. */
	private renderChip(
		container: HTMLElement,
		record: EntityRecord | null,
		label: string,
		onRemove: () => void
	): void {
		renderChipEl(this.plugin, container, record, label, onRemove);
	}

	/** Resolves a picked name back to its record (for chip colors). */
	private resolveName(name: string): EntityRecord | null {
		return this.plugin.indexer.resolve(name, this.project.loomPath);
	}

	/** "Tavern, City A" for a sublocation, else the plain name. */
	private locLabel(r: EntityRecord): string {
		if (r.type === 'location' && r.parentLocation !== null) {
			const parent = this.plugin.indexer.resolve(r.parentLocation, r.path);
			if (parent?.type === 'location') return `${r.name}, ${parent.name}`;
		}
		return r.name;
	}

	onOpen(): void {
		const meta = ENTITY_META[this.type];
		this.setTitle(this.options.parentLocation ? 'New sublocation' : `New ${meta.label.toLowerCase()}`);

		if (this.type !== 'session') {
			// From a session page (noteSession set), the event/quest Name is a
			// search over existing ones: picking a match pins it to the session on
			// submit; typing a new name just creates it.
			const searchable =
				(this.type === 'event' || this.type === 'quest') && this.options.noteSession !== undefined;
			const noun = meta.label.toLowerCase();
			const article = /^[aeiou]/.test(noun) ? 'an' : 'a';
			new Setting(this.contentEl).setName('Name').addText((text) => {
				text
					.setPlaceholder(searchable ? `Search or name ${article} ${noun}` : meta.label + ' name')
					.setValue(this.fields.name)
					.onChange((v) => {
						this.fields.name = v.trim();
						// Typing after a pick means "make a new one with this name".
						this.pickedExisting = null;
						this.refreshSubmitLabel();
					});
				if (searchable) {
					new RecordInputSuggest(
						this.app,
						text.inputEl,
						() => this.plugin.indexer.getAll(this.type, this.project.root),
						(r) => {
							this.pickedExisting = r;
							this.fields.name = r.name;
							text.inputEl.value = r.name;
							this.refreshSubmitLabel();
						},
						(r) => r.name,
						false
					);
				}
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') void this.submit();
				});
				window.setTimeout(() => text.inputEl.focus());
			});
		}

		// Quests place their tag pills after "Received in session"; everyone else
		// right below the name.
		if (this.type !== 'quest') this.renderTagPills();

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

			// Quest tags (main / important / side) sit right after the session.
			this.renderTagPills();

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
			// Birth session (skipped only when the session page already provides
			// it): search over sessions, the pick becomes a session tag with ✕.
			// Every event is created through this one session flow.
			if (!this.options.noteSession) {
				const sessionLabel = (s: EntityRecord) =>
					s.date ? formatLoomDate(s.date, this.project.config) : s.name;
				const sessions = this.plugin.indexer
					.getAll('session', this.project.root)
					.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0));
				const sessionSetting = new Setting(this.contentEl)
					.setName('Session')
					.setDesc('When it happened; leave unspecified for a lore event with no session.');
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
			const missingPcs = () =>
				this.plugin.indexer
					.getGroupMembers(this.project.root)
					.filter(
						(r) =>
							!(this.fields.involved ?? []).includes(linkTargetOf(r)) &&
							!(this.fields.group ?? []).includes(linkTargetOf(r))
					);
			const taken = (r: EntityRecord) =>
				(this.fields.involved ?? []).includes(linkTargetOf(r)) ||
				(this.fields.group ?? []).includes(linkTargetOf(r));
			const candidates = () => [
				// The virtual "Group" faction: picking it snapshots the current
				// party into the note's `group` list (one chip, individual links).
				...(missingPcs().length > 0 &&
				(involveFilter === null || involveFilter === 'faction' || involveFilter === 'character')
					? [pcGroupStub(this.project.root, groupNameOf(this.project.config))]
					: []),
				...this.plugin.indexer
					.getAll(undefined, this.project.root)
					.filter((r) => r.type !== 'session' && r.type !== 'event')
					.filter((r) => involveFilter === null || r.type === involveFilter)
					.filter((r) => !taken(r))
					.sort((a, b) => a.name.localeCompare(b.name)),
			];
			new Setting(this.contentEl)
				.setName('Involved entities')
				.addText((text) => {
					text.setPlaceholder('Involve…');
					new RecordInputSuggest(this.app, text.inputEl, candidates, (r) => {
						if (r.path === PC_GROUP_VALUE) {
							const group = (this.fields.group ??= []);
							for (const pc of missingPcs()) group.push(linkTargetOf(pc));
						} else {
							(this.fields.involved ??= []).push(linkTargetOf(r));
						}
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
				if ((this.fields.group ?? []).length > 0) {
					const label = groupNameOf(this.project.config);
					this.renderChip(involvedChips, pcGroupStub(this.project.root, label), label, () => {
						this.fields.group = undefined;
						refreshInvolved();
					});
				}
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

		if (this.type === 'character') {
			// Faction memberships: "+ Add faction" reveals a row — role (default
			// Member) of <faction> at <location> — applied to the faction's members
			// after the character is created.
			this.fields.factions = [];
			const factions = this.plugin.indexer
				.getAll('faction', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));
			const locations = this.plugin.indexer
				.getAll('location', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));
			// Row list lives BELOW the add button (created after it).
			let rowsEl: HTMLElement;
			const render = () => {
				rowsEl.empty();
				(this.fields.factions ?? []).forEach((m, i) => {
					const row = rowsEl.createDiv({ cls: 'loom-modal-faction-row' });
					const roleInput = row.createEl('input', { type: 'text', attr: { placeholder: 'Member' } });
					roleInput.value = m.role;
					roleInput.addEventListener('input', () => (m.role = roleInput.value.trim()));
					row.createSpan({ text: 'of', cls: 'loom-modal-faction-lbl' });
					const factionInput = row.createEl('input', { type: 'text', attr: { placeholder: 'Faction…' } });
					new RecordInputSuggest(
						this.app,
						factionInput,
						() => factions.filter((f) => !(this.fields.factions ?? []).some((x) => x.faction === linkTargetOf(f))),
						(r) => {
							m.faction = linkTargetOf(r);
							factionInput.value = r.name;
						},
						(r) => r.name,
						false
					);
					row.createSpan({ text: 'at', cls: 'loom-modal-faction-lbl' });
					const locInput = row.createEl('input', { type: 'text', attr: { placeholder: 'Location…' } });
					new RecordInputSuggest(
						this.app,
						locInput,
						() => locations,
						(r) => {
							m.location = linkTargetOf(r);
							locInput.value = r.name;
						},
						(r) => this.locLabel(r),
						false
					);
					const rm = row.createEl('button', { text: '✕', cls: 'loom-chip-remove' });
					rm.addEventListener('click', (e) => {
						e.preventDefault();
						this.fields.factions = (this.fields.factions ?? []).filter((_, j) => j !== i);
						render();
					});
				});
			};
			new Setting(this.contentEl).setName('Faction').addButton((btn) => {
				// "Add faction" (sentence case) + a separate "+ " so it reads
				// "+ Add faction" like the character page without tripping the lint.
				btn.setButtonText('Add faction');
				btn.buttonEl.prepend('+ ');
				btn.onClick(() => {
					(this.fields.factions ??= []).push({ faction: '', role: 'Member', location: '' });
					render();
				});
			});
			rowsEl = this.contentEl.createDiv({ cls: 'loom-modal-factions' });
			render();
			const charDesc = new Setting(this.contentEl)
				.setName('Description')
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			charDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'faction') {
			// Member characters written straight into this faction's own `members`.
			this.fields.members = [];
			const characters = this.plugin.indexer
				.getAll('character', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));
			const locations = this.plugin.indexer
				.getAll('location', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));
			let rowsEl: HTMLElement;
			// Rebuilds recreate every row's inputs — restore their values from the
			// stored fields (link targets → display names), or adding a second
			// member visually wipes the first.
			const displayNameOf = (records: EntityRecord[], linkTarget: string) =>
				records.find((r) => linkTargetOf(r) === linkTarget)?.name ?? linkTarget;
			const render = () => {
				rowsEl.empty();
				(this.fields.members ?? []).forEach((m, i) => {
					const row = rowsEl.createDiv({ cls: 'loom-modal-faction-row' });
					const roleInput = row.createEl('input', { type: 'text', attr: { placeholder: 'Member' } });
					roleInput.value = m.role;
					roleInput.addEventListener('input', () => (m.role = roleInput.value.trim()));
					const charInput = row.createEl('input', { type: 'text', attr: { placeholder: 'Character…' } });
					charInput.value = m.character === '' ? '' : displayNameOf(characters, m.character);
					new RecordInputSuggest(
						this.app,
						charInput,
						() =>
							characters.filter(
								(c) => !(this.fields.members ?? []).some((x) => x.character === linkTargetOf(c))
							),
						(r) => {
							m.character = linkTargetOf(r);
							charInput.value = r.name;
						},
						(r) => r.name,
						false
					);
					row.createSpan({ text: 'at', cls: 'loom-modal-faction-lbl' });
					const locInput = row.createEl('input', { type: 'text', attr: { placeholder: 'Location…' } });
					locInput.value = m.location === '' ? '' : displayNameOf(locations, m.location);
					new RecordInputSuggest(
						this.app,
						locInput,
						() => locations,
						(r) => {
							m.location = linkTargetOf(r);
							locInput.value = r.name;
						},
						(r) => this.locLabel(r),
						false
					);
					const rm = row.createEl('button', { text: '✕', cls: 'loom-chip-remove' });
					rm.addEventListener('click', (e) => {
						e.preventDefault();
						this.fields.members = (this.fields.members ?? []).filter((_, j) => j !== i);
						render();
					});
				});
			};
			new Setting(this.contentEl).setName('Members').addButton((btn) => {
				btn.setButtonText('Add member');
				btn.buttonEl.prepend('+ ');
				btn.onClick(() => {
					(this.fields.members ??= []).push({ character: '', role: 'Member', location: '' });
					render();
				});
			});
			rowsEl = this.contentEl.createDiv({ cls: 'loom-modal-factions' });
			render();
			const facDesc = new Setting(this.contentEl)
				.setName('Description')
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			facDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'item') {
			const itemDesc = new Setting(this.contentEl)
				.setName('Description')
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			itemDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'location') {
			// Sublocation of (optional) + a full-width Description.
			const locations = this.plugin.indexer
				.getAll('location', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));
			let pickedParent: EntityRecord | null = this.options.parentLocation ?? null;
			if (pickedParent) this.fields.parentLocation = linkTargetOf(pickedParent);
			const parentSetting = new Setting(this.contentEl).setName('Sublocation of');
			const parentEl = parentSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
			const refreshParent = () => {
				parentEl.empty();
				if (pickedParent) {
					this.renderChip(parentEl, pickedParent, pickedParent.name, () => {
						pickedParent = null;
						this.fields.parentLocation = '';
						refreshParent();
					});
				} else {
					const input = parentEl.createEl('input', { type: 'text', attr: { placeholder: '(Optional)' } });
					new RecordInputSuggest(
						this.app,
						input,
						() => locations,
						(r) => {
							pickedParent = r;
							this.fields.parentLocation = linkTargetOf(r);
							refreshParent();
						},
						(r) => this.locLabel(r)
					);
				}
			};
			refreshParent();
			const locDesc = new Setting(this.contentEl)
				.setName('Description')
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			locDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'event') {
			const evDesc = new Setting(this.contentEl)
				.setName('Description')
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			evDesc.setClass('loom-modal-wide');
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

		new Setting(this.contentEl).addButton((btn) => {
			this.submitBtn = btn;
			btn
				.setButtonText('Create')
				.setCta()
				.onClick(() => void this.submit());
			this.refreshSubmitLabel();
		});
	}

	/** Primary button reads "Add" when a name search matched an existing
	 *  event/quest (it gets pinned to the session), "Create" otherwise. */
	private refreshSubmitLabel(): void {
		this.submitBtn?.setButtonText(this.pickedExisting ? 'Add' : 'Create');
	}

	private async submit(): Promise<void> {
		// Name search matched an existing event/quest: pin it to the session
		// rather than creating a duplicate.
		if (this.pickedExisting && this.options.noteSession) {
			await this.pinExisting(this.pickedExisting, this.options.noteSession);
			return;
		}
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
			await this.applyFactions(file.basename);
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

	/** Pins an existing entity to `session` via a session note (skips if it's
	 *  already there), then closes — the session-page hub picks it up. */
	/** Writes the just-created character into each chosen faction's `members`
	 *  (a plain link for a default-role/no-location membership, else an object). */
	private async applyFactions(charBasename: string): Promise<void> {
		const charLink = `[[${charBasename}]]`;
		for (const m of this.fields.factions ?? []) {
			if (m.faction === '') continue;
			const factionFile = this.plugin.app.metadataCache.getFirstLinkpathDest(m.faction, '');
			if (!factionFile) continue;
			const roleIsDefault = m.role === '' || m.role.toLowerCase() === DEFAULT_MEMBER_ROLE.toLowerCase();
			let entry: unknown = charLink;
			if (!roleIsDefault || m.location !== '') {
				const o: Record<string, unknown> = { character: charLink };
				if (!roleIsDefault) o.role = m.role;
				if (m.location !== '') o.location = `[[${m.location}]]`;
				entry = o;
			}
			await this.plugin.app.fileManager.processFrontMatter(factionFile, (fm: Record<string, unknown>) => {
				const cur = fmLoomValue(fm, FM.members);
				const arr = Array.isArray(cur) ? cur : [];
				arr.push(entry);
				setLoomKey(fm, FM.members, arr);
			});
		}
	}

	private async pinExisting(entity: EntityRecord, session: EntityRecord): Promise<void> {
		const already = entity.sessionNotes.some(
			(n) => n.session !== null && this.plugin.indexer.resolve(n.session, entity.path)?.path === session.path
		);
		if (already) {
			new Notice(`"${entity.name}" is already in this session.`);
			this.close();
			return;
		}
		const f = this.plugin.app.vault.getFileByPath(entity.path);
		if (!f) return;
		try {
			await this.plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				const cur = fmLoomValue(fm, FM.sessionNotes);
				const arr = Array.isArray(cur) ? cur : [];
				arr.push({ session: `[[${linkTargetOf(session)}]]`, text: '', seq: Date.now() });
				setLoomKey(fm, FM.sessionNotes, arr);
			});
			this.close();
			if (this.options.onCreated) this.options.onCreated(f);
		} catch (e) {
			console.error('Loom Loom: failed to pin existing entity', e);
			new Notice('Could not add it to the session.');
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
