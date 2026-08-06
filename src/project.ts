import {
	AbstractInputSuggest,
	App,
	ButtonComponent,
	FuzzySuggestModal,
	Menu,
	Modal,
	Notice,
	Setting,
	TextAreaComponent,
	TextComponent,
	TFile,
	TFolder,
	normalizePath,
	setIcon,
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
	SCRIPT_EXTENSION,
	TIMELINES_FOLDER,
	VIEW_LIST,
	formatTimestamp,
	pcGroupStub,
} from './types';
import { defaultProjectConfig, formatLoomDate, groupNameOf, serializeProjectConfig, todayRaw } from './calendar';
import {
	DEFAULT_PROJECT_KIND,
	PROJECT_KIND_META,
	PROJECT_KINDS,
	ProjectKind,
	featuresOf,
	projectRoleType,
	projectTypes,
	roleOf,
	roleType,
	typesFor,
} from './project-kind';
import { managedEntityFileName, managedSessionFileName, sanitizeFileName } from './naming';
import { ProjectDef, extractLinkpath, linkTargetOf } from './indexer';
import { fmLoomValue, setLoomKey } from './fm';
import { canCreateProjectOfKind } from './license/gating';
import {
	appendChapter,
	appendScene,
	applyDisplayTitles,
	joinLocationSub,
	moveSceneToSection,
	parseFountain,
	reorderScenesInSection,
	reorderTopSections,
	setSceneHeadingParts,
} from './fountain';
import type LoomLoomPlugin from './main';

/** Folders scaffolded for a new project: only the entity types its kind
 *  actually holds, so a writer project gets Chapters/Scenes and a player one
 *  Sessions/Events rather than both. Types added to a kind later are covered
 *  by `createEntity`, which ensures its folder on the way in. */
function projectSubfolders(kind: ProjectKind): string[] {
	return ['Entities', ...typesFor(kind).map((t) => ENTITY_META[t].folder), TIMELINES_FOLDER];
}

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
export async function scaffoldProject(
	app: App,
	rootPath: string,
	kind: ProjectKind = DEFAULT_PROJECT_KIND
): Promise<TFile> {
	const root = normalizePath(rootPath);
	await ensureFolder(app, root);
	for (const sub of projectSubfolders(kind)) {
		await ensureFolder(app, root + '/' + sub);
	}
	const anchorType = roleType(kind, 'anchor');
	const beatType = roleType(kind, 'beat');
	const timelinePath = root + '/' + TIMELINES_FOLDER + '/Main timeline.md';
	if (!app.vault.getFileByPath(timelinePath)) {
		await app.vault.create(
			timelinePath,
			[
				'---',
				`${FM.name}: Main timeline`,
				`${FM.timelineTypes}: [${anchorType}, ${beatType}]`,
				`${FM.tags}: []`,
				'---',
				'',
				`Timeline definition. \`${FM.timelineTypes}\` lists which entity types populate it`,
				`(${anchorType}, ${beatType}); \`${FM.tags}\` optionally filters to entities carrying one`,
				'of those plugin tags.',
				'',
			].join('\n')
		);
	}
	const baseName = root.split('/').pop() ?? 'Project';
	const loomPath = normalizePath(`${root}/${baseName}.${LOOM_EXTENSION}`);
	// Writer projects get their Fountain script up front — it's the spine of the
	// kind, and an empty one carrying a title page is friendlier than an empty
	// view with a "create it" button.
	if (featuresOf(kind).script) {
		const scriptPath = normalizePath(`${root}/${baseName}.${SCRIPT_EXTENSION}`);
		if (!app.vault.getFileByPath(scriptPath)) {
			await app.vault.create(
				scriptPath,
				[`Title: ${baseName}`, 'Credit: Written by', 'Author:', 'Draft date:', '', ''].join('\n')
			);
		}
	}
	const existing = app.vault.getFileByPath(loomPath);
	if (existing) return existing;
	return app.vault.create(loomPath, serializeProjectConfig(defaultProjectConfig(kind)));
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
	/** Location only: region name — the new location is part of this region. */
	region?: string;
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
	if (type === 'location' && fields.region && fields.region !== '') {
		lines.push(`${FM.region}: ${yamlQuote(`[[${fields.region}]]`)}`);
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
	// Chapters aren't dated — they carry a manual order (stamped on the first
	// reorder) and the title that goes into the exported script.
	if (type === 'chapter') lines.push(`${FM.displayTitle}: ""`);
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
	// Loom-managed timestamps: captured at creation so the real creation date
	// survives cloud-sync overwriting the filesystem ctime. Datetime-property
	// format so Obsidian renders them in the date & time picker.
	const now = formatTimestamp(Date.now());
	lines.push(`${FM.created}: ${now}`, `${FM.modified}: ${now}`);
	lines.push('---', '', '');
	return lines.join('\n');
}

/**
 * Removes every frontmatter reference to a deleted entity from other notes in
 * the project — relationships, members, involved/group/places on session notes,
 * item/quest-giver/attendance/sublocation-order lists, objective finish
 * sessions, and the scalar link fields (parentLocation, deathSession, quest
 * received/outcome sessions, item origin/owner). Body-text `[[links]]` are left
 * alone — only structured fields are cleared. Run BEFORE trashing the note so
 * links still resolve.
 */
export async function purgeEntityReferences(
	plugin: LoomLoomPlugin,
	deletedPath: string,
	projectRoot: string
): Promise<void> {
	const others = plugin.indexer.getAll(undefined, projectRoot).filter((r) => r.path !== deletedPath);
	for (const rec of others) {
		// Only touch notes that actually connect to the deleted one (this includes
		// body links, but we edit frontmatter only, so body links are untouched).
		if (!plugin.indexer.getOutgoing(rec.path).some((c) => c.record.path === deletedPath)) continue;
		const f = plugin.app.vault.getFileByPath(rec.path);
		if (!f) continue;
		const dead = (v: unknown): boolean =>
			typeof v === 'string' &&
			plugin.indexer.resolve(extractLinkpath(v) ?? '', rec.path)?.path === deletedPath;
		const isObj = (v: unknown): v is Record<string, unknown> =>
			typeof v === 'object' && v !== null && !Array.isArray(v);
		try {
			await plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				for (const key of Object.keys(fm)) {
					const lower = key.replace(/^loom/i, '').toLowerCase();
					const val = fm[key];
					// Scalar link fields → drop the key when it points at the deleted note.
					if (
						[
							'parentlocation',
							'deathsession',
							'questreceived',
							'questoutcomesession',
							'itemorigin',
							'itemowner',
						].includes(lower)
					) {
						if (dead(val)) delete fm[key];
						continue;
					}
					if (!Array.isArray(val)) continue;
					if (lower === 'relationships') {
						fm[key] = val.filter((e) => !(isObj(e) && dead(e.target)));
					} else if (lower === 'members') {
						fm[key] = val
							.filter((e) => !dead(e) && !(isObj(e) && dead(e.character)))
							.map((e): unknown => {
								if (isObj(e) && dead(e.location)) {
									const { location, ...rest } = e;
									void location;
									return rest;
								}
								return e;
							});
					} else if (lower === 'sessionnotes') {
						fm[key] = val.map((e): unknown => {
							if (!isObj(e)) return e;
							const next = { ...e };
							if (dead(next.session)) delete next.session;
							for (const listKey of ['involved', 'group', 'places']) {
								const list = next[listKey];
								if (Array.isArray(list)) next[listKey] = list.filter((v) => !dead(v));
							}
							return next;
						});
					} else if (lower === 'objectives') {
						fm[key] = val.map((e): unknown => {
							if (isObj(e) && dead(e.finishedOn)) {
								const { finishedOn, ...rest } = e;
								void finishedOn;
								return rest;
							}
							return e;
						});
					} else {
						// Plain link lists: items, questGiver, attendance, sublocationOrder.
						fm[key] = val.filter((v) => !dead(v));
					}
				}
			});
		} catch (e) {
			console.error('Loom Loom: failed to purge references from', rec.path, e);
		}
	}
}

/** One-line text prompt (rename, alias, date…) by default — Enter or the CTA
 *  submits. `multiline` swaps the `<input>` for an auto-growing `<textarea>`
 *  (same technique as `AltTextModal`'s own "New alternative wording" field
 *  below: grows with typing up to a CSS `max-height`, then scrolls) for a
 *  caller whose answer can legitimately span more than one line — there,
 *  Enter has to make a newline like any text field, not submit, so only the
 *  CTA button does. */
export class TextInputModal extends Modal {
	private submitted = false;

	constructor(
		app: App,
		private opts: {
			title: string;
			initial?: string;
			placeholder?: string;
			cta?: string;
			multiline?: boolean;
			onSubmit: (value: string) => void;
			/** Called once, only if the modal closes WITHOUT ever submitting
			 *  (the X button, Esc, or a click outside) — for a caller that
			 *  already made some provisional change in anticipation of this
			 *  modal's answer (e.g. inserting a fresh marker pair right before
			 *  opening it) and needs to undo that if the user backs out. */
			onCancel?: () => void;
		}
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		const input: HTMLInputElement | HTMLTextAreaElement = this.opts.multiline
			? this.contentEl.createEl('textarea', {
					cls: 'loom-modal-input loom-modal-textarea',
					attr: { rows: 1 },
				})
			: this.contentEl.createEl('input', { type: 'text', cls: 'loom-modal-input' });
		input.value = this.opts.initial ?? '';
		if (this.opts.placeholder) input.placeholder = this.opts.placeholder;
		const submit = () => {
			const value = input.value.trim();
			if (value === '') return;
			this.submitted = true;
			this.close();
			this.opts.onSubmit(value);
		};
		if (this.opts.multiline) {
			const autoGrow = () => {
				input.setCssProps({ height: 'auto' });
				input.style.height = `${input.scrollHeight}px`;
			};
			// Deferred a frame — the textarea isn't laid out yet (0 scrollHeight)
			// synchronously right after `createEl` inserts it.
			window.setTimeout(autoGrow, 0);
			input.addEventListener('input', autoGrow);
			// No Enter-submits binding here — a `<textarea>`'s Enter is a
			// newline, full stop, exactly like `AltTextModal`'s own "New
			// alternative wording" field, which has no keydown handler either.
		} else {
			input.addEventListener('keydown', (e) => {
				if ((e as KeyboardEvent).key === 'Enter') submit();
			});
		}
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
		if (!this.submitted) this.opts.onCancel?.();
	}
}

/**
 * A real closeable window for an alt-text span's option list — opened by
 * right-clicking its gutter/margin icon. Every option renders as its own
 * EDITABLE textarea, not a read-only label to pick from: the user can
 * rewrite an existing alternative's wording in place, not just add new ones.
 * Owns its own local `options`/`activeIndex`/`acceptedIndex` copy and
 * re-renders its list after every action, so it never needs to be
 * re-created or externally refreshed while open — the caller's callbacks
 * only need to persist the change to the sidecar (and, for the active
 * option specifically, push it into the live document), never hand data
 * back in EXCEPT `onDeleteOption`, which has to (deleting can shift every
 * later index, and duplicating that renumbering logic here as well as in
 * the caller would be one more place for the two to drift apart).
 *
 * "Draft" and "Accept" are two distinct actions: both make an option the
 * currently-displayed text, but only Accept marks it as the FINALIZED
 * choice for this span (`acceptedIndex`) — Draft explicitly clears any
 * prior acceptance, since picking a different draft means the span is back
 * to "still deciding." Whichever row is currently ACTIVE gets an accent
 * background so it stands out in the list at a glance; the pressed pill
 * (`.loom-seg-on`, this codebase's usual segmented-pill class) distinguishes
 * "this is just the draft" from "this is the accepted one."
 */
export class AltTextModal extends Modal {
	private options: string[];
	private activeIndex: number;
	private acceptedIndex: number | null;
	private listEl: HTMLElement | null = null;

	constructor(
		app: App,
		private opts: {
			options: string[];
			activeIndex: number;
			acceptedIndex: number | null;
			/** A row was picked as the active DRAFT (clears acceptance). */
			onDraft: (index: number) => void;
			/** A row was picked as the ACCEPTED, final option. */
			onAccept: (index: number) => void;
			/** An existing option's wording was edited in place. */
			onEditOption: (index: number, newText: string) => void;
			/** A brand-new option was appended (never activated automatically —
			 *  add and swap stay distinct actions). */
			onAddOption: (text: string) => void;
			/** Removes one option outright — the caller re-derives (and
			 *  persists) the shifted `activeIndex`/`acceptedIndex` and hands the
			 *  fresh values back so this modal's own list stays in sync without
			 *  reimplementing that renumbering itself. `undefined` means the
			 *  delete was refused (e.g. the last remaining option). */
			onDeleteOption: (
				index: number
			) => Promise<{ options: string[]; activeIndex: number; acceptedIndex: number | null } | undefined>;
		}
	) {
		super(app);
		this.options = opts.options.slice();
		this.activeIndex = opts.activeIndex;
		this.acceptedIndex = opts.acceptedIndex;
	}

	onOpen(): void {
		this.setTitle('Alternative text');
		this.modalEl.addClass('loom-alt-modal');
		this.listEl = this.contentEl.createDiv({ cls: 'loom-alt-modal-list' });
		this.renderList();

		const addRow = this.contentEl.createDiv({ cls: 'loom-alt-modal-add' });
		// A `<textarea>`, not `<input type="text">` — a new alternative's
		// wording can be multi-line same as an existing option's, so Enter has
		// to make a newline here too, not submit (an input's own Enter-submits
		// convention was actively wrong for that). Auto-grows with typing (same
		// technique as each option's own textarea in `renderList` below) up to
		// a CSS `max-height`, past which `overflow-y: auto` takes over rather
		// than growing the modal itself indefinitely.
		const input = addRow.createEl('textarea', {
			cls: 'loom-modal-input loom-alt-modal-add-textarea',
			attr: { placeholder: 'New alternative wording…', rows: 1 },
		});
		// A plain button, not `Setting(...).addButton(...)` — a `Setting` wraps
		// its own content in a full `.setting-item` (its own internal flex
		// layout, a name/description column it assumes is there, and a default
		// top border meant to separate list rows), which fought with `addRow`'s
		// own single-row flex layout instead of joining it: the button landed
		// pushed to the setting-item's own far edge rather than centered next
		// to the input, and that stray top border showed as a half-cut
		// separator line above the row.
		const addBtn = addRow.createEl('button', { cls: 'mod-cta loom-alt-modal-add-btn', text: 'Add' });
		const autoGrowAddTextarea = () => {
			input.setCssProps({ height: 'auto' });
			input.style.height = `${input.scrollHeight}px`;
		};
		// Measured, not guessed via matching CSS padding — a `<textarea>` and a
		// `<button>` don't share the same default border/padding, so no amount
		// of CSS tweaking landed them on the exact same pixel height. Reading
		// the textarea's own natural (single empty line) `scrollHeight` once at
		// mount and copying THAT value onto the button's fixed `height`
		// guarantees an exact match regardless of what either element's
		// individual box-model happens to be. Deferred a frame — neither
		// element is laid out yet (0 `scrollHeight`) synchronously right after
		// `createEl` inserts them.
		window.setTimeout(() => {
			autoGrowAddTextarea();
			addBtn.style.height = `${input.scrollHeight}px`;
		}, 0);
		input.addEventListener('input', autoGrowAddTextarea);
		const submit = () => {
			const value = input.value.trim();
			if (value === '') return;
			this.options.push(value);
			this.opts.onAddOption(value);
			input.value = '';
			autoGrowAddTextarea();
			this.renderList();
		};
		addBtn.addEventListener('click', submit);
	}

	private renderList(): void {
		const listEl = this.listEl;
		if (!listEl) return;
		listEl.empty();
		this.options.forEach((opt, i) => {
			const row = listEl.createDiv({
				cls: i === this.activeIndex ? 'loom-alt-modal-row loom-alt-modal-row-highlight' : 'loom-alt-modal-row',
			});
			const textarea = row.createEl('textarea', { cls: 'loom-alt-modal-textarea', attr: { rows: 1 } });
			textarea.value = opt;
			const autoGrow = () => {
				textarea.setCssProps({ height: 'auto' });
				textarea.style.height = `${textarea.scrollHeight}px`;
			};
			// Deferred a frame — the textarea isn't laid out yet (0 scrollHeight)
			// synchronously right after `createEl` inserts it.
			window.setTimeout(autoGrow, 0);
			textarea.addEventListener('input', autoGrow);
			textarea.addEventListener('blur', () => {
				const value = textarea.value;
				if (value.trim() === '' || value === this.options[i]) {
					textarea.value = this.options[i];
					return;
				}
				this.options[i] = value;
				this.opts.onEditOption(i, value);
			});

			const actions = row.createDiv({ cls: 'loom-alt-modal-row-actions' });
			const pills = actions.createDiv({ cls: 'loom-seg loom-alt-modal-pills' });
			const draftBtn = pills.createEl('button', { cls: 'loom-seg-btn', text: 'Draft' });
			const acceptBtn = pills.createEl('button', { cls: 'loom-seg-btn', text: 'Accept' });
			draftBtn.classList.toggle('loom-seg-on', i === this.activeIndex && this.acceptedIndex !== i);
			acceptBtn.classList.toggle('loom-seg-on', i === this.acceptedIndex);
			draftBtn.addEventListener('click', () => {
				this.activeIndex = i;
				this.acceptedIndex = null;
				this.opts.onDraft(i);
				this.renderList();
			});
			acceptBtn.addEventListener('click', () => {
				this.activeIndex = i;
				this.acceptedIndex = i;
				this.opts.onAccept(i);
				this.renderList();
			});

			const deleteBtn = actions.createEl('button', {
				cls: 'loom-alt-modal-delete',
				attr: { 'aria-label': 'Delete this alternative' },
			});
			setIcon(deleteBtn, 'trash-2');
			deleteBtn.disabled = this.options.length <= 1;
			deleteBtn.addEventListener('click', () => {
				new ConfirmModal(
					this.app,
					'Delete this alternative?',
					opt.length > 120 ? `${opt.slice(0, 120)}…` : opt,
					async () => {
						const next = await this.opts.onDeleteOption(i);
						if (!next) {
							// `undefined` means the span was stripped down to plain
							// text (the last-alternative-standing case) — there's no
							// longer anything for this window to show, so close it
							// rather than leave it open on a now-stale option list.
							this.close();
							return;
						}
						this.options = next.options;
						this.activeIndex = next.activeIndex;
						this.acceptedIndex = next.acceptedIndex;
						this.renderList();
					},
					'Delete'
				).open();
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Search/display label of a record in pickers: session dates, sublocations
 *  as "Tavern, City A", everything else its name. */
export function recordPickLabel(plugin: LoomLoomPlugin, project: ProjectDef, r: EntityRecord): string {
	if (roleOf(r.type) === 'anchor' && r.date) return formatLoomDate(r.date, project.config);
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
 * Reads/rewrites the project's script file — the same small job `editScript`
 * (script-view.tsx) does, duplicated here rather than imported: script-view.tsx
 * already imports FROM this module, so importing it back would be a cycle.
 * fountain.ts itself has no such problem (it depends on nothing), so every
 * actual script-editing function the modal below uses comes from there.
 */
async function editScriptFile(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string
): Promise<string | null> {
	const path = normalizePath(`${project.name}.${SCRIPT_EXTENSION}`);
	const fullPath = project.root === '' ? path : normalizePath(`${project.root}/${path}`);
	const file = plugin.app.vault.getFileByPath(fullPath);
	if (!file) return null;
	const raw = await plugin.app.vault.read(file);
	const next = apply(raw);
	if (next !== raw) await plugin.app.vault.modify(file, next);
	return next;
}

/** Sentinel path for the "+ New chapter" pinned entry in the Scene creation
 *  modal's chapter picker — never a real file, same trick as the virtual
 *  Group faction (`PC_GROUP_VALUE`). */
const NEW_CHAPTER_SENTINEL = 'loom:new-chapter';
function newChapterStub(projectRoot: string): EntityRecord {
	return { ...pcGroupStub(projectRoot), path: NEW_CHAPTER_SENTINEL, name: '+ New chapter', type: 'chapter' };
}

/** Matches the file's own frontmatter block — same regex as `FRONTMATTER_RE`
 *  in views/common.tsx, duplicated for the same reason `editScriptFile` is:
 *  common.tsx is a view, and views already import FROM this module. Used to
 *  write a newly-created Scene/Chapter's Notes as the note's raw body. */
const FM_BLOCK_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;
async function writeNotesBody(plugin: LoomLoomPlugin, file: TFile, notes: string): Promise<void> {
	const trimmed = notes.trim();
	if (trimmed === '') return;
	await plugin.app.vault.process(file, (data) => {
		const m = FM_BLOCK_RE.exec(data);
		return (m ? m[0] : '') + trimmed;
	});
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
		const now = formatTimestamp(Date.now());
		setLoomKey(fm, FM.created, now);
		setLoomKey(fm, FM.modified, now);
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
	/** Locations only: prefill the new location's "Part of region". */
	region?: EntityRecord;
	/** The new entity starts with a session note pinned to this session. */
	noteSession?: EntityRecord;
	/** Quests only: prefills "Received in session" without pinning a session
	 *  note — e.g. a quest created from an event note's Involve search, where the
	 *  event already carries the session and the quest is just involved in it. */
	receivedSession?: EntityRecord;
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
	/** Chapters only: called with a full stand-in record instead of opening the
	 *  new page or firing `onCreated` — the Scene modal's "+ New chapter" nested
	 *  pick uses this so it can hand the created chapter straight to its own
	 *  chapter picker instead of navigating away mid-scene-creation. */
	onChapterCreated?: (record: EntityRecord) => void;
	/** Scenes only: pre-picks the Chapter field — the Chapter page's own
	 *  "+ New scene" button uses this so a scene added from there lands in
	 *  THIS chapter without making the user pick it again. Still changeable;
	 *  just a starting pick, not a lock. */
	defaultChapter?: EntityRecord;
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
	/** Event modal: re-renders the Description field read-only vs editable when
	 *  the Name search toggles between an existing pick and a new name. */
	private refreshDesc?: () => void;
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

	/** Sublocation label: full ancestry ("Secret room, Tavern, City"), or just
	 *  the own name when `subChipFullAncestry` is off. */
	private locLabel(r: EntityRecord): string {
		if (r.type !== 'location' || r.parentLocation === null) return r.name;
		if (!this.plugin.settings.subChipFullAncestry) return r.name;
		const parts = [r.name];
		let cur: EntityRecord | null = r;
		const seen = new Set<string>([r.path]);
		for (let guard = 0; guard < 20 && cur?.parentLocation != null; guard++) {
			const parent = this.plugin.indexer.resolve(cur.parentLocation, cur.path);
			if (parent?.type !== 'location' || seen.has(parent.path)) break;
			parts.push(parent.name);
			seen.add(parent.path);
			cur = parent;
		}
		return parts.join(', ');
	}

	onOpen(): void {
		// Scene and Chapter are script-backed structural types — their writing
		// lives in the .fountain file, not in note fields the way every other
		// type works, so they get their own dedicated layout entirely instead
		// of falling through the generic fields below.
		if (this.type === 'scene') {
			this.renderSceneModal();
			return;
		}
		if (this.type === 'chapter') {
			this.renderChapterModal();
			return;
		}
		const meta = ENTITY_META[this.type];
		this.setTitle(this.options.parentLocation ? 'New sublocation' : `New ${meta.label.toLowerCase()}`);

		if (this.type !== 'session') {
			// From a session page (noteSession set), the event/quest Name is a
			// search over existing ones: picking a match pins it to the session on
			// submit; typing a new name just creates it.
			const searchable =
				(roleOf(this.type) === 'beat' || this.type === 'quest') &&
				this.options.noteSession !== undefined;
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
						this.refreshDesc?.();
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
							this.refreshDesc?.();
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
				.getAll(projectRoleType(this.project.config, 'anchor'), this.project.root)
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
			// session tag with ✕. Quests born from a session page (or from an event
			// note that already carries a session) default there.
			this.receivedSession = this.options.noteSession ?? this.options.receivedSession ?? null;
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

			const reward = new Setting(this.contentEl)
				.setName('Reward')
				.setDesc('Supports markdown and multiple lines, so you can link an [[item]].')
				.addTextArea((text) =>
					text.setPlaceholder('Not specified').onChange((v) => (this.fields.reward = v.trim()))
				);
			reward.setClass('loom-modal-wide');
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

	if (roleOf(this.type) === 'beat') {
			// Birth session (skipped only when the session page already provides
			// it): search over sessions, the pick becomes a session tag with ✕.
			// Every event is created through this one session flow.
			if (!this.options.noteSession) {
				const sessionLabel = (s: EntityRecord) =>
					s.date ? formatLoomDate(s.date, this.project.config) : s.name;
				const sessions = this.plugin.indexer
					.getAll(projectRoleType(this.project.config, 'anchor'), this.project.root)
					.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0));
				// A scene MUST have a chapter — that's where its writing lives, so
				// a chapterless scene has nowhere to belong. An event may be a
				// session-less lore event, so there the pick stays optional.
				const anchorMeta = ENTITY_META[projectRoleType(this.project.config, 'anchor')];
				const sessionSetting = new Setting(this.contentEl)
					.setName(anchorMeta.label)
					.setDesc(
						this.anchorRequired()
							? `Which ${anchorMeta.label.toLowerCase()} this ${ENTITY_META[
									this.type
								].label.toLowerCase()} belongs to.`
							: 'When it happened; leave unspecified for a lore event with no session.'
					);
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
							attr: {
								placeholder: this.anchorRequired()
									? `Pick the ${anchorMeta.label.toLowerCase()}…`
									: 'Not specified',
							},
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
					.filter((r) => roleOf(r.type) === null)
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
						for (const t of projectTypes(this.project.config).filter((t) => roleOf(t) === null)) {
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

			// Locations: where the event takes place — written into the starting
			// note's `places` (like the pages' Location… picker). Main locations
			// sort above their sublocations.
			const placeTaken = (r: EntityRecord) => (this.fields.places ?? []).includes(linkTargetOf(r));
			const placeCandidates = () =>
				this.plugin.indexer
					.getAll('location', this.project.root)
					.filter((r) => !placeTaken(r))
					.sort(
						(a, b) =>
							(a.parentLocation === null ? 0 : 1) - (b.parentLocation === null ? 0 : 1) ||
							a.name.localeCompare(b.name)
					);
			new Setting(this.contentEl).setName('Locations').addText((text) => {
				text.setPlaceholder('Location…');
				new RecordInputSuggest(
					this.app,
					text.inputEl,
					placeCandidates,
					(r) => {
						(this.fields.places ??= []).push(linkTargetOf(r));
						refreshPlaces();
					},
					(r) => this.locLabel(r)
				);
			});
			const placeChips = this.contentEl.createDiv({ cls: 'loom-modal-chips' });
			const refreshPlaces = () => {
				placeChips.empty();
				for (const target of this.fields.places ?? []) {
					const rec = this.resolveName(target);
					this.renderChip(placeChips, rec, rec ? this.locLabel(rec) : target, () => {
						this.fields.places = (this.fields.places ?? []).filter((n) => n !== target);
						refreshPlaces();
					});
				}
			};
			refreshPlaces();
		}

		// Events born from a session page need no date — the session carries it.
		// (The Involved picker below writes into that session note, so it only
		// appears for session-born events.)
		if (roleOf(this.type) === 'beat' && !this.options.noteSession) {
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
			// Rebuilds recreate every row's inputs — restore their values from the
			// stored fields (link targets → display names), or adding a second row
			// visually wipes every earlier one's Faction/Location text.
			const displayNameOf = (records: EntityRecord[], linkTarget: string) =>
				records.find((r) => linkTargetOf(r) === linkTarget)?.name ?? linkTarget;
			const render = () => {
				rowsEl.empty();
				(this.fields.factions ?? []).forEach((m, i) => {
					const row = rowsEl.createDiv({ cls: 'loom-modal-faction-row' });
					const roleInput = row.createEl('input', { type: 'text', attr: { placeholder: 'Member' } });
					roleInput.value = m.role;
					roleInput.addEventListener('input', () => (m.role = roleInput.value.trim()));
					row.createSpan({ text: 'of', cls: 'loom-modal-faction-lbl' });
					const factionInput = row.createEl('input', { type: 'text', attr: { placeholder: 'Faction…' } });
					factionInput.value = m.faction === '' ? '' : displayNameOf(factions, m.faction);
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
			// Sublocation of (optional) + a full-width Description. Main locations
			// sort above their sublocations (same ordering as the other pickers).
			const locations = this.plugin.indexer
				.getAll('location', this.project.root)
				.sort(
					(a, b) =>
						(a.parentLocation === null ? 0 : 1) - (b.parentLocation === null ? 0 : 1) ||
						a.name.localeCompare(b.name)
				);
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
			// Part of region (optional) — a grouping layer above main locations.
			const regions = this.plugin.indexer
				.getAll('region', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));
			let pickedRegion: EntityRecord | null = this.options.region ?? null;
			if (pickedRegion) this.fields.region = linkTargetOf(pickedRegion);
			const regionSetting = new Setting(this.contentEl).setName('Part of region');
			const regionEl = regionSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
			const refreshRegion = () => {
				regionEl.empty();
				if (pickedRegion) {
					this.renderChip(regionEl, pickedRegion, pickedRegion.name, () => {
						pickedRegion = null;
						this.fields.region = '';
						refreshRegion();
					});
				} else {
					const input = regionEl.createEl('input', { type: 'text', attr: { placeholder: '(Not specified)' } });
					new RecordInputSuggest(
						this.app,
						input,
						() => regions,
						(r) => {
							pickedRegion = r;
							this.fields.region = linkTargetOf(r);
							refreshRegion();
						},
						(r) => r.name
					);
				}
			};
			refreshRegion();
			const locDesc = new Setting(this.contentEl)
				.setName('Description')
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			locDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'region') {
			const regDesc = new Setting(this.contentEl)
				.setName('Description')
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			regDesc.setClass('loom-modal-wide');
		}

		if (roleOf(this.type) === 'beat') {
			// When an existing event is picked (session-page add), its description
			// is shown read-only — you're adding it to the session, not editing it.
			const evDesc = new Setting(this.contentEl).setName('Description');
			evDesc.setClass('loom-modal-wide');
			const roEl = evDesc.controlEl.createDiv({ cls: 'loom-modal-existing-desc' });
			let ta: TextAreaComponent | null = null;
			evDesc.addTextArea((text) => {
				ta = text;
				text.onChange((v) => (this.fields.description = v.trim()));
			});
			this.refreshDesc = () => {
				const existing = this.pickedExisting;
				if (ta) ta.inputEl.style.display = existing ? 'none' : '';
				roEl.style.display = existing ? '' : 'none';
				if (existing) roEl.setText(existing.description !== '' ? existing.description : '(No description)');
				evDesc.setName(existing ? 'Description (existing event)' : 'Description');
			};
			this.refreshDesc();
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

	/**
	 * Whether this entity cannot be created without an anchor. A Scene's writing
	 * lives inside its Chapter's section of the script, so a chapterless scene
	 * has nowhere to be stored; an Event, by contrast, may legitimately be a
	 * session-less lore event.
	 */
	private anchorRequired(): boolean {
		return this.type === 'scene';
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
		if (this.anchorRequired() && !this.options.noteSession && !this.pickedSession) {
			const anchorMeta = ENTITY_META[projectRoleType(this.project.config, 'anchor')];
			new Notice(`${anchorMeta.label} is required.`);
			return;
		}
		const connectTo = this.options.connectTo;
		if (connectTo) {
			this.fields.relationship = {
				type: this.relComment === '' ? 'related' : this.relComment,
				target: linkTargetOf(connectTo.record),
			};
		}
		// `fields.parentLocation` is NOT re-derived from `options.parentLocation`
		// here — the "Sublocation of" field (built below, for `type === 'location'`)
		// already seeds it from that option AND keeps it current as the user picks
		// a different parent or clears it; re-applying the original option here
		// would silently discard that choice.
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

	/** Pins an existing entity to `session` via a session note (skips if it's
	 *  already there), then closes — the session-page hub picks it up. */
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
				// This session note carries whatever was picked in the modal — an
				// existing event's involved list is per-session-note, so the same
				// event can involve different entities in different sessions.
				const note: Record<string, unknown> = {
					session: `[[${linkTargetOf(session)}]]`,
					text: '',
					seq: Date.now(),
				};
				const links = (names?: string[]) => (names ?? []).map((n) => `[[${n}]]`);
				if ((this.fields.involved ?? []).length > 0) note.involved = links(this.fields.involved);
				if ((this.fields.group ?? []).length > 0) note.group = links(this.fields.group);
				if ((this.fields.places ?? []).length > 0) note.places = links(this.fields.places);
				arr.push(note);
				setLoomKey(fm, FM.sessionNotes, arr);
			});
			this.close();
			if (this.options.onCreated) this.options.onCreated(f);
		} catch (e) {
			console.error('Loom Loom: failed to pin existing entity', e);
			new Notice('Could not add it to the session.');
		}
	}

	/**
	 * Scene creation: a heading row (INT./EXT., Location, Sublocation, Time —
	 * the same four parts the Scene page's own modular heading editor writes),
	 * a Chapter picker (mandatory — a scene with no chapter has nowhere to live
	 * in the script), and a Notes field. Submitting inserts the scene into the
	 * script under the chosen chapter and stamps the note's fields directly
	 * (mirroring what `syncScenes` would do on its next pass) rather than
	 * waiting for that pass, so the new page can be opened immediately.
	 */
	private renderSceneModal(): void {
		this.setTitle('New scene');
		// The heading row alone (a dropdown + three text fields) is wider than
		// Obsidian's default modal — without this it clips at the edge.
		this.modalEl.addClass('loom-modal-scene');
		let intExt = 'INT.';
		let mainLoc = '';
		let subLoc = '';
		let timeOfDay = '';
		let pickedChapter: EntityRecord | null = this.options.defaultChapter ?? null;
		let sceneAppendToEnd = true;
		let notes = '';
		// Reassigned once the position picker is built further down — declared
		// (and callable) up front so the Chapter picker's earlier pick/clear
		// callbacks can refresh it without caring about source order.
		let refreshSceneOrderItems: () => void = () => {};

		const headingSetting = new Setting(this.contentEl).setName('Scene heading');
		headingSetting.setClass('loom-modal-scene-heading');
		headingSetting.addDropdown((dd) => {
			for (const opt of ['INT.', 'EXT.', 'INT./EXT.', 'EST.']) dd.addOption(opt, opt);
			dd.setValue(intExt).onChange((v) => (intExt = v));
		});
		headingSetting.addText((text) => {
			text.setPlaceholder('Location').onChange((v) => (mainLoc = v));
			new RecordInputSuggest(
				this.app,
				text.inputEl,
				() =>
					this.plugin.indexer
						.getAll('location', this.project.root)
						.filter((r) => r.parentLocation === null),
				(r) => {
					mainLoc = r.name;
					text.setValue(r.name);
				},
				(r) => r.name,
				false
			);
		});
		headingSetting.addText((text) => {
			text.setPlaceholder('Sublocation (optional)').onChange((v) => (subLoc = v));
			new RecordInputSuggest(
				this.app,
				text.inputEl,
				() => {
					const mainRecord = this.plugin.indexer
						.getAll('location', this.project.root)
						.find(
							(r) => r.parentLocation === null && r.name.trim().toLowerCase() === mainLoc.trim().toLowerCase()
						);
					if (!mainRecord) return [];
					return this.plugin.indexer
						.getAll('location', this.project.root)
						.filter(
							(r) =>
								r.parentLocation !== null &&
								this.plugin.indexer.resolve(r.parentLocation, r.path)?.path === mainRecord.path
						);
				},
				(r) => {
					subLoc = r.name;
					text.setValue(r.name);
				},
				(r) => r.name,
				false
			);
		});
		headingSetting.addText((text) => {
			text.setPlaceholder('Time').onChange((v) => (timeOfDay = v));
		});

		const chapterMeta = ENTITY_META[projectRoleType(this.project.config, 'anchor')];
		const chapterSetting = new Setting(this.contentEl)
			.setName(chapterMeta.label)
			.setDesc(`Which ${chapterMeta.label.toLowerCase()} this scene belongs to.`);
		const chapterEl = chapterSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
		const refreshChapter = () => {
			chapterEl.empty();
			if (pickedChapter) {
				this.renderChip(chapterEl, pickedChapter, pickedChapter.name, () => {
					pickedChapter = null;
					refreshChapter();
					refreshSceneOrderItems();
				});
				return;
			}
			const input = chapterEl.createEl('input', {
				type: 'text',
				attr: { placeholder: `Pick the ${chapterMeta.label.toLowerCase()}…` },
			});
			new RecordInputSuggest(
				this.app,
				input,
				() => [
					newChapterStub(this.project.root),
					...this.plugin.indexer
						.getAll('chapter', this.project.root)
						.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created)),
				],
				(r) => {
					if (r.path === NEW_CHAPTER_SENTINEL) {
						new CreateEntityModal(this.plugin, 'chapter', this.project, {
							onChapterCreated: (record) => {
								pickedChapter = record;
								refreshChapter();
								refreshSceneOrderItems();
							},
						}).open();
						return;
					}
					pickedChapter = r;
					refreshChapter();
					refreshSceneOrderItems();
				},
				(r) => r.name
			);
		};
		refreshChapter();

		new Setting(this.contentEl)
			.setName('Append to the end of the chapter')
			.setDesc("Turn off to choose where among the chapter's existing scenes this one lands.")
			.addToggle((t) =>
				t.setValue(true).onChange((v) => {
					sceneAppendToEnd = v;
					sceneOrderWrap.classList.toggle('loom-modal-order-wrap-hidden', v);
				})
			);
		const sceneOrderWrap = this.contentEl.createDiv({
			cls: 'loom-modal-order-wrap loom-modal-order-wrap-hidden',
		});
		const sceneOrderPicker = this.buildOrderPicker(sceneOrderWrap);
		sceneOrderPicker.setPhantomLabel('New scene');
		refreshSceneOrderItems = () => {
			const chapterScenes = pickedChapter
				? this.plugin.indexer
						.getAll('scene', this.project.root)
						.filter(
							(sc) =>
								sc.sceneChapter !== '' &&
								this.plugin.indexer.resolve(sc.sceneChapter, sc.path)?.path === pickedChapter?.path
						)
						.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created))
				: [];
			sceneOrderPicker.setItems(chapterScenes.map((sc) => sc.name));
		};
		refreshSceneOrderItems();

		const notesSetting = new Setting(this.contentEl)
			.setName('Notes')
			.addTextArea((text) => text.onChange((v) => (notes = v.trim())));
		notesSetting.setClass('loom-modal-wide');

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText('Create')
				.setCta()
				.onClick(() =>
					void this.submitScene({
						intExt,
						mainLoc,
						subLoc,
						timeOfDay,
						pickedChapter,
						sceneAppendToEnd,
						insertIndex: sceneOrderPicker.getIndex(),
						notes,
					})
				)
		);
	}

	private async submitScene(fields: {
		intExt: string;
		mainLoc: string;
		subLoc: string;
		timeOfDay: string;
		pickedChapter: EntityRecord | null;
		sceneAppendToEnd: boolean;
		insertIndex: number;
		notes: string;
	}): Promise<void> {
		const mainLoc = fields.mainLoc.trim();
		if (mainLoc === '') {
			new Notice('Location is required.');
			return;
		}
		if (!fields.pickedChapter) {
			new Notice(`${ENTITY_META[projectRoleType(this.project.config, 'anchor')].label} is required.`);
			return;
		}
		const chapter = fields.pickedChapter;
		// Read before the script write below — same query the modal's own
		// position picker used to build its list, so the index it returned
		// lines up with this order.
		const existingSceneIds =
			chapter.chapterId !== ''
				? this.plugin.indexer
						.getAll('scene', this.project.root)
						.filter(
							(sc) =>
								sc.sceneChapter !== '' &&
								this.plugin.indexer.resolve(sc.sceneChapter, sc.path)?.path === chapter.path
						)
						.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created))
						.map((sc) => sc.sceneId)
				: [];

		let newId: string | null = null;
		const nextText = await editScriptFile(this.plugin, this.project, (raw) => {
			let t = appendScene(raw, mainLoc);
			const parsed = parseFountain(t);
			const created = parsed.scenes[parsed.scenes.length - 1];
			newId = created?.loomId ?? null;
			if (!newId) return t;
			if (chapter.chapterId !== '') {
				t = moveSceneToSection(t, newId, chapter.chapterId) ?? t;
				if (!fields.sceneAppendToEnd) {
					const order = [...existingSceneIds];
					const clamped = Math.max(0, Math.min(fields.insertIndex, order.length));
					order.splice(clamped, 0, newId);
					t = reorderScenesInSection(t, chapter.chapterId, order) ?? t;
				}
			}
			t =
				setSceneHeadingParts(t, newId, {
					intExt: fields.intExt.trim() === '' ? 'INT.' : fields.intExt.trim(),
					location: joinLocationSub(mainLoc, fields.subLoc),
					timeOfDay: fields.timeOfDay.trim(),
				}) ?? t;
			return t;
		});
		if (nextText === null || !newId) {
			new Notice('Could not write the scene into the script.');
			return;
		}

		const location = await this.resolveModalLocation(mainLoc, fields.subLoc);
		const scene = parseFountain(nextText).scenes.find((sc) => sc.loomId === newId);
		if (!scene) {
			new Notice('Could not create the scene.');
			return;
		}
		const place = scene.location.trim() === '' ? 'Untitled scene' : scene.location.trim();
		const name = scene.timeOfDay.trim() === '' ? place : `${place} — ${scene.timeOfDay.trim()}`;
		try {
			const created = await createEntity(this.plugin, this.project, 'scene', {
				name,
				tag: '',
				date: '',
				description: '',
			});
			await this.plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.sceneId, newId);
				setLoomKey(fm, FM.sceneIntExt, scene.intExt);
				setLoomKey(fm, FM.sceneTime, scene.timeOfDay);
				setLoomKey(fm, FM.sceneLocation, location ? `[[${linkTargetOf(location)}]]` : '');
				setLoomKey(fm, FM.sceneChapter, `[[${linkTargetOf(chapter)}]]`);
				setLoomKey(fm, FM.sceneBranch, scene.branchLoomId ?? '');
				setLoomKey(fm, FM.seq, scene.index);
			});
			await writeNotesBody(this.plugin, created, fields.notes);
			this.close();
			if (this.options.onCreated) {
				this.options.onCreated(created);
			} else {
				const origin: EntityOrigin = { type: VIEW_LIST, state: { project: this.project.root, entityType: 'scene' } };
				this.plugin.openEntityFile(created.path, origin);
			}
		} catch (e) {
			console.error('Loom Loom: failed to create the scene', e);
			new Notice('Could not create the note. See console for details.');
		}
	}

	/** Resolves a scene heading's main/sublocation text to Location entities,
	 *  creating whichever doesn't exist yet — mirrors `resolveSceneLocation` in
	 *  script-view.tsx's `syncScenes` (duplicated for the same import-cycle
	 *  reason as `editScriptFile` above), so a name typed fresh here connects
	 *  exactly the way the same name typed into the script would. */
	private async resolveModalLocation(mainName: string, subName: string): Promise<EntityRecord | null> {
		const mainKey = mainName.trim().toLowerCase();
		if (mainKey === '') return null;
		let mainRecord =
			this.plugin.indexer
				.getAll('location', this.project.root)
				.find((r) => r.parentLocation === null && r.name.trim().toLowerCase() === mainKey) ?? null;
		if (!mainRecord) {
			const created = await createEntity(this.plugin, this.project, 'location', {
				name: mainName.trim(),
				tag: '',
				date: '',
				description: '',
			});
			mainRecord = { ...pcGroupStub(this.project.root), path: created.path, name: mainName.trim(), type: 'location' };
		}
		const subKey = subName.trim().toLowerCase();
		if (subKey === '') return mainRecord;
		const parentTarget = linkTargetOf(mainRecord);
		let subRecord =
			this.plugin.indexer
				.getAll('location', this.project.root)
				.find(
					(r) =>
						r.parentLocation !== null &&
						r.name.trim().toLowerCase() === subKey &&
						this.plugin.indexer.resolve(r.parentLocation, r.path)?.path === mainRecord.path
				) ?? null;
		if (!subRecord) {
			const created = await createEntity(this.plugin, this.project, 'location', {
				name: subName.trim(),
				tag: '',
				date: '',
				description: '',
				parentLocation: parentTarget,
			});
			subRecord = {
				...pcGroupStub(this.project.root),
				path: created.path,
				name: subName.trim(),
				type: 'location',
				parentLocation: parentTarget,
			};
		}
		return subRecord;
	}

	/**
	 * Builds the "where does the new one land" position picker shared by the
	 * Scene and Chapter creation modals: existing items render ONCE as static,
	 * non-draggable rows in normal document flow (their own order never
	 * changes); the new/unsaved item is the ONE draggable row, taken out of
	 * flow (absolute) so the statics never reflow around it, starting at slot 0
	 * ("sits first", easiest to find). Dragging uses a fixed row-height slot
	 * (`SLOT`, matches the CSS exactly) rather than measuring the DOM — the
	 * grabbed row rides the raw cursor delta with no transition, static rows
	 * slide a whole slot with one via `transform`, same "slide to reorder" feel
	 * as the Sublocation/Outline drag lists elsewhere in the app.
	 * `setItems` lets the Scene modal rebuild the list when its Chapter pick
	 * changes (a different chapter means a different set of existing scenes to
	 * drag among); `setPhantomLabel` keeps the dragged row's own text in sync
	 * with whatever the modal's own name field currently reads.
	 */
	private buildOrderPicker(container: HTMLElement): {
		getIndex: () => number;
		setItems: (labels: string[]) => void;
		setPhantomLabel: (label: string) => void;
	} {
		const SLOT = 34;
		const orderList = container.createDiv({ cls: 'loom-modal-order-list' });
		let staticRows: HTMLElement[] = [];
		let insertIndex = 0;

		const phantomRow = orderList.createDiv({ cls: 'loom-modal-order-row loom-modal-order-row-new' });
		const grip = phantomRow.createSpan({ cls: 'loom-modal-order-grip', text: '⠿' });
		const phantomLabel = phantomRow.createSpan({ text: '' });

		const applyStaticShifts = () => {
			for (let i = 0; i < staticRows.length; i++) {
				// A static row shifts down one slot once the dragged row's current
				// target position is at or above it, opening the gap it needs.
				staticRows[i].style.transform = insertIndex <= i ? `translateY(${SLOT}px)` : '';
			}
		};
		const restPhantom = () => {
			phantomRow.style.transform = `translateY(${insertIndex * SLOT}px)`;
		};
		const setItems = (labels: string[]) => {
			for (const el of staticRows) el.remove();
			staticRows = labels.map((label) => {
				const rowEl = orderList.createDiv({ cls: 'loom-modal-order-row' });
				rowEl.createSpan({ cls: 'loom-modal-order-grip loom-modal-order-grip-spacer' });
				rowEl.createSpan({ text: label });
				orderList.insertBefore(rowEl, phantomRow);
				return rowEl;
			});
			insertIndex = 0;
			orderList.style.height = `${(staticRows.length + 1) * SLOT}px`;
			applyStaticShifts();
			restPhantom();
		};
		setItems([]);

		let dragStart: { startY: number; origin: number } | null = null;
		grip.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			grip.setPointerCapture(e.pointerId);
			dragStart = { startY: e.clientY, origin: insertIndex };
			phantomRow.classList.add('loom-modal-order-row-dragging');
		});
		grip.addEventListener('pointermove', (e) => {
			if (!dragStart) return;
			const dy = e.clientY - dragStart.startY;
			phantomRow.style.transform = `translateY(${dragStart.origin * SLOT + dy}px)`;
			const over = Math.max(0, Math.min(staticRows.length, dragStart.origin + Math.round(dy / SLOT)));
			if (over !== insertIndex) {
				insertIndex = over;
				applyStaticShifts();
			}
		});
		const endDrag = () => {
			if (!dragStart) return;
			dragStart = null;
			phantomRow.classList.remove('loom-modal-order-row-dragging');
			restPhantom();
		};
		grip.addEventListener('pointerup', endDrag);
		grip.addEventListener('pointercancel', endDrag);

		return {
			getIndex: () => insertIndex,
			setItems,
			setPhantomLabel: (label: string) => phantomLabel.setText(label),
		};
	}

	/**
	 * Chapter creation: Title (the script's `#` line) and Display title (the
	 * centered-bold `>**…**<` marker under it), where to insert it — append to
	 * the end (default) or drag it to a specific spot among the existing
	 * chapters — and a Notes field.
	 */
	private renderChapterModal(): void {
		this.setTitle('New chapter');
		let title = '';
		let displayTitle = '';
		let appendToEnd = true;
		let notes = '';
		const existingChapters = this.plugin.indexer
			.getAll('chapter', this.project.root)
			.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));

		let displayTitleInput: TextComponent | null = null;
		new Setting(this.contentEl).setName('Title').addText((text) => {
			text.onChange((v) => {
				title = v;
				orderPicker.setPhantomLabel(v.trim() === '' ? 'New chapter' : v.trim());
				// Mirrors what an empty Display title will actually resolve to
				// (`applyDisplayTitles` falls back to the Title) rather than a
				// generic hint.
				displayTitleInput?.setPlaceholder(v.trim());
			});
			window.setTimeout(() => text.inputEl.focus());
		});
		new Setting(this.contentEl)
			.setName('Display title')
			.setDesc('How the title appears on the printed page — defaults to the title above when left blank.')
			.addText((text) => {
				displayTitleInput = text;
				text.onChange((v) => (displayTitle = v));
			});

		new Setting(this.contentEl)
			.setName('Append to the end of the script')
			.setDesc('Turn off to choose where among the existing chapters this one lands.')
			.addToggle((t) =>
				t.setValue(true).onChange((v) => {
					appendToEnd = v;
					orderWrap.classList.toggle('loom-modal-order-wrap-hidden', v);
				})
			);
		const orderWrap = this.contentEl.createDiv({ cls: 'loom-modal-order-wrap loom-modal-order-wrap-hidden' });
		const orderPicker = this.buildOrderPicker(orderWrap);
		orderPicker.setPhantomLabel('New chapter');
		orderPicker.setItems(existingChapters.map((c) => c.name));

		const notesSetting = new Setting(this.contentEl)
			.setName('Notes')
			.addTextArea((text) => text.onChange((v) => (notes = v.trim())));
		notesSetting.setClass('loom-modal-wide');

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText('Create')
				.setCta()
				.onClick(() =>
					void this.submitChapter({
						title,
						displayTitle,
						appendToEnd,
						insertIndex: orderPicker.getIndex(),
						existingChapters,
						notes,
					})
				)
		);
	}

	private async submitChapter(fields: {
		title: string;
		displayTitle: string;
		appendToEnd: boolean;
		insertIndex: number;
		existingChapters: EntityRecord[];
		notes: string;
	}): Promise<void> {
		const title = fields.title.trim();
		if (title === '') {
			new Notice('Title is required.');
			return;
		}
		const displayTitle = fields.displayTitle.trim();

		let newId: string | null = null;
		const nextText = await editScriptFile(this.plugin, this.project, (raw) => {
			let t = appendChapter(raw, title);
			const parsed = parseFountain(t);
			const last = [...parsed.sections].reverse().find((sec) => sec.level === 1 && sec.loomId !== null);
			newId = last?.loomId ?? null;
			if (!newId) return t;
			if (!fields.appendToEnd) {
				const order = fields.existingChapters.map((c) => c.chapterId);
				const clamped = Math.max(0, Math.min(fields.insertIndex, order.length));
				order.splice(clamped, 0, newId);
				t = reorderTopSections(t, order) ?? t;
			}
			if (displayTitle !== '') t = applyDisplayTitles(t, new Map([[newId, displayTitle]]));
			return t;
		});
		if (nextText === null || !newId) {
			new Notice('Could not write the chapter into the script.');
			return;
		}
		const sections = parseFountain(nextText)
			.sections.filter((sec) => sec.level === 1 && sec.loomId !== null)
			.sort((a, b) => a.line - b.line);
		const seq = sections.findIndex((sec) => sec.loomId === newId) + 1;

		try {
			const created = await createEntity(this.plugin, this.project, 'chapter', {
				name: title,
				tag: '',
				date: '',
				description: '',
			});
			await this.plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.chapterId, newId);
				setLoomKey(fm, FM.seq, seq);
				if (displayTitle !== '') setLoomKey(fm, FM.displayTitle, displayTitle);
			});
			await writeNotesBody(this.plugin, created, fields.notes);
			const record: EntityRecord = {
				...pcGroupStub(this.project.root),
				path: created.path,
				name: title,
				type: 'chapter',
				chapterId: newId,
				seq,
				displayTitle,
			};
			this.close();
			if (this.options.onChapterCreated) {
				this.options.onChapterCreated(record);
			} else if (this.options.onCreated) {
				this.options.onCreated(created);
			} else {
				const origin: EntityOrigin = {
					type: VIEW_LIST,
					state: { project: this.project.root, entityType: 'chapter' },
				};
				this.plugin.openEntityFile(created.path, origin);
			}
		} catch (e) {
			console.error('Loom Loom: failed to create the chapter', e);
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
	private kind: ProjectKind = DEFAULT_PROJECT_KIND;

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

		// The kind decides which entity types the project holds, so it is
		// picked up front — switching later is possible but moves files.
		new Setting(this.contentEl)
			.setName('Project type')
			.setDesc(PROJECT_KIND_META[this.kind].description)
			.addDropdown((dd) => {
				for (const kind of PROJECT_KINDS) dd.addOption(kind, PROJECT_KIND_META[kind].label);
				dd.setValue(this.kind).onChange((v) => {
					this.kind = v as ProjectKind;
					this.render();
				});
			});
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `Holds: ${typesFor(this.kind)
				.map((t) => ENTITY_META[t].plural)
				.join(', ')}.`,
		});

		// Freemium gate: one project of each kind is free with every feature
		// available; a license key unlocks unlimited projects. Only gates NEW
		// creation here — existing projects (however many) are never touched, so
		// a vault that already has several from before this shipped is never
		// blocked from opening or using them. See src/license/gating.ts.
		const blocked = !canCreateProjectOfKind(
			this.plugin.licenseManager.getTier(),
			this.plugin.indexer.getProjects(),
			this.kind
		);
		if (blocked) {
			this.contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: `This vault already has a free-tier ${PROJECT_KIND_META[this.kind].label.toLowerCase()} project. A license key unlocks unlimited projects of every type — see settings → license.`,
			});
		}

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText('Create project')
				.setCta()
				.setDisabled(blocked)
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
		// Authoritative re-check, not just the render()-time disabled state: the
		// index or license tier could have changed between opening this modal and
		// clicking Create.
		if (
			!canCreateProjectOfKind(
				this.plugin.licenseManager.getTier(),
				this.plugin.indexer.getProjects(),
				this.kind
			)
		) {
			new Notice('This vault already has a free-tier project of that type. See settings → license.');
			return;
		}
		try {
			const loomFile = await scaffoldProject(this.app, root, this.kind);
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
		// pre-line so a multi-paragraph detail (e.g. the script-import warning,
		// which has to spell out what is and isn't destroyed) keeps its breaks.
		this.contentEl.createEl('p', { cls: 'loom-confirm-detail', text: this.detail });
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
	constructor(
		plugin: LoomLoomPlugin,
		private onPick: (type: EntityType) => void,
		/** Offers only the types this project's kind holds; without it, every
		 *  type the plugin knows (both chronologies) is listed. */
		private project?: ProjectDef
	) {
		super(plugin.app);
		this.setPlaceholder('Pick the entity type');
	}

	getItems(): EntityType[] {
		return this.project ? [...projectTypes(this.project.config)] : [...ENTITY_TYPES];
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
