import {
	AbstractInputSuggest,
	App,
	ButtonComponent,
	EventRef,
	FuzzySuggestModal,
	Menu,
	Modal,
	Notice,
	Setting,
	TextAreaComponent,
	TextComponent,
	TFile,
	TFolder,
	moment as momentImport,
	normalizePath,
	setIcon,
	stringifyYaml,
} from 'obsidian';

/** `obsidian`'s own re-exported `moment` loses its call signature under this
 *  project's `isolatedModules` TS setting — a known interop quirk with
 *  `import * as X` re-exporting a CommonJS `export =` module (moment.js's
 *  own typings). Cast once, narrowly, to the exact callable shape this file
 *  actually uses, rather than fighting the full `moment.Moment` type surface. */
const moment = momentImport as unknown as (
	input?: string,
	format?: string,
	strict?: boolean
) => { isValid(): boolean; format(fmt: string): string };
import {
	BOOK_EXTENSION,
	defaultMemberRole,
	ENTITY_META,
	ENTITY_TAGS,
	ENTITY_TYPES,
	EntityOrigin,
	EntityRecord,
	EntityType,
	EventKind,
	FM,
	LOOM_EXTENSION,
	PC_GROUP_VALUE,
	SCRIPT_EXTENSION,
	TIMELINES_FOLDER,
	VIEW_LIST,
	entityLabel,
	newEntityTitle,
	entityPlural,
	formatTimestamp,
	pcGroupStub,
	bySeq,
} from './types';
import { defaultProjectConfig, groupNameOf, serializeProjectConfig, todayRaw } from './calendar';
import {
	DEFAULT_PROJECT_KIND,
	DEFAULT_WRITER_MODE,
	PROJECT_KIND_META,
	PROJECT_KINDS,
	ProjectKind,
	WriterMode,
	featuresOf,
	projectFolderPath,
	projectKindDescription,
	projectKindLabel,
	projectRoleType,
	projectTypes,
	roleOf,
	roleType,
	typesFor,
	isInvolvableType,
} from './project-kind';
import { managedEntityFileName, managedSessionFileName, projectPath, sanitizeFileName } from './naming';
import { locationLabel, mainLocationFirst, recordLabel } from './display';
import { ProjectDef, extractLinkpath, linkTargetOf } from './indexer';
import { appendLoomList, newNoteEntry, setLoomKey, writeFmAt, writeNoteBody } from './fm';
import { queueWrite } from './write-queue';
import { recomputeEventLocks, waitForMetadataSync } from './gm-lock';
import { SessionConflict, cascadeDecisionPointSession, setEventSession } from './gm-decision-point';
import { canCreateProjectOfKind } from './license/gating';
import { LocaleKey, article, t } from './i18n';
import {
	appendAct,
	appendScene,
	applyDisplayTitles,
	joinLocationSub,
	moveSceneToSection,
	parseFountain,
	reorderScenesInSection,
	reorderTopSections,
	setSceneHeadingParts,
} from './fountain';
import {
	appendBookAct,
	appendBookChapter,
	ensureBookIds,
	moveBookChapterToAct,
	parseBook,
	reorderBookActs,
	reorderBookChaptersInAct,
} from './prose';
import { ensureScriptBufferLoaded, flushScriptBufferNow, mutateScriptBuffer } from './views/script-buffer';
import type LoomLoomPlugin from './main';

/** Folders scaffolded for a new project: only the entity types its kind (and,
 *  for Writer, its sub-mode) actually holds, so a writer/script project gets
 *  Acts/Scenes, a writer/prose one gets Chapters, and a player one gets
 *  Sessions/Events — never more than one of these at once. Types added to a
 *  kind later are covered by `createEntity`, which ensures its folder on the
 *  way in. */
function projectSubfolders(kind: ProjectKind, writerMode: WriterMode = DEFAULT_WRITER_MODE): string[] {
	return ['Entities', ...typesFor(kind, writerMode).map((t) => ENTITY_META[t].folder), TIMELINES_FOLDER];
}

export async function ensureFolder(app: App, path: string): Promise<void> {
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

/**
 * Creates the project structure inside `rootPath` and its .loom home file
 * (named after the folder). Returns the .loom file.
 */
export async function scaffoldProject(
	app: App,
	rootPath: string,
	kind: ProjectKind = DEFAULT_PROJECT_KIND,
	writerMode: WriterMode = DEFAULT_WRITER_MODE
): Promise<TFile> {
	const root = normalizePath(rootPath);
	await ensureFolder(app, root);
	for (const sub of projectSubfolders(kind, writerMode)) {
		await ensureFolder(app, root + '/' + sub);
	}
	const anchorType = roleType(kind, 'anchor', writerMode);
	const beatType = roleType(kind, 'beat', writerMode);
	const timelineTypes = [anchorType, beatType];
	const timelinePath = root + '/' + TIMELINES_FOLDER + '/Main timeline.md';
	if (!app.vault.getFileByPath(timelinePath)) {
		await app.vault.create(
			timelinePath,
			[
				'---',
				`${FM.name}: Main timeline`,
				`${FM.timelineTypes}: [${timelineTypes.join(', ')}]`,
				`${FM.tags}: []`,
				'---',
				'',
				`Timeline definition. \`${FM.timelineTypes}\` lists which entity types populate it`,
				`(${timelineTypes.join(', ')}); \`${FM.tags}\` optionally filters to entities carrying one`,
				'of those plugin tags.',
				'',
			].join('\n')
		);
	}
	const baseName = root.split('/').pop() ?? 'Project';
	const loomPath = normalizePath(`${root}/${baseName}.${LOOM_EXTENSION}`);
	// Writer/Script projects get their Fountain script up front — it's the
	// spine of that sub-mode, and an empty one carrying a title page is
	// friendlier than an empty view with a "create it" button. Writer/Prose
	// has no equivalent single file — its Chapters are created individually.
	if (featuresOf(kind, writerMode).script) {
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
	const config = defaultProjectConfig(kind);
	config.writerMode = writerMode;
	return app.vault.create(loomPath, serializeProjectConfig(config));
}

export interface NewEntityFields {
	name: string;
	tag: string;
	date: string;
	description?: string;
	/** Session only: `[[<daily note name>]]` for `date`, computed by
	 *  `createEntity` (needs `app` to read the vault's Daily Notes format) and
	 *  passed in so `buildEntityContent` itself stays a pure string builder. */
	dailyNote?: string;
	/** When set, the new note declares this relationship in its frontmatter. */
	relationship?: { type: string; target: string };
	/** Location only: parent location name — the new location is its sublocation. */
	parentLocation?: string;
	/** Location only: region name — the new location is part of this region. */
	region?: string;
	/** Event only (GM projects): decision point name — the new event is part
	 *  of this decision point. */
	decisionPoint?: string;
	/** Event only (GM projects): planning status, defaults to `planned` — see
	 *  ROADMAP.md's "Game Master" entry. Absent on every other kind/type. */
	eventKind?: EventKind;
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

/**
 * The vault's configured Daily Notes date format, falling back to Obsidian's
 * own default (`YYYY-MM-DD`) when the core Daily Notes plugin isn't enabled/
 * configured. `internalPlugins` has no public typings — every daily-note-
 * aware community plugin reaches into this same undocumented shape, hence
 * the casts; wrapped in a `try` since that shape is Obsidian's own internal
 * detail, not a contract, and could change across versions.
 */
function dailyNoteFormat(app: App): string {
	const DEFAULT_FORMAT = 'YYYY-MM-DD';
	try {
		const internalPlugins = (
			app as unknown as {
				internalPlugins: {
					plugins: Record<string, { enabled: boolean; instance?: { options?: { format?: string } } }>;
				};
			}
		).internalPlugins;
		const daily = internalPlugins?.plugins?.['daily-notes'];
		if (daily?.enabled && daily.instance?.options?.format) return daily.instance.options.format;
	} catch (e) {
		console.error('Loom Loom: could not read the Daily Notes format, using the default', e);
	}
	return DEFAULT_FORMAT;
}

/**
 * `[[<daily note name>]]` for a raw `YYYY-MM-DD` date string (a Session's own
 * date is always Gregorian, stored exactly this way — see calendar.ts) — a
 * real wikilink, so Obsidian's own native graph connects the session to its
 * daily note even before that note exists (a ghost note, same as any other
 * unresolved `[[link]]`). `null` for an unparseable/empty date.
 */
export function dailyNoteLink(app: App, raw: string): string | null {
	if (raw.trim() === '') return null;
	const parsed = moment(raw.trim(), 'YYYY-MM-DD', true);
	if (!parsed.isValid()) return null;
	return `[[${parsed.format(dailyNoteFormat(app))}]]`;
}

export function buildEntityContent(type: EntityType, fields: NewEntityFields): string {
	const rels = fields.relationship ? [fields.relationship] : [];
	// A starting session note carries the birth session and/or the involved
	// entities. Involvement without a session (a lore event) writes a
	// session-less note — involved links still connect (relType `involved`).
	const involved = fields.involved ?? [];
	const group = fields.group ?? [];
	const places = fields.places ?? [];
	const hasSessionNote =
		(fields.noteSession && fields.noteSession !== '') || involved.length > 0 || group.length > 0 || places.length > 0;
	// An Event's own creation modal writes its "Description" field into the
	// starting session note's `text` instead of `loomDescription` whenever
	// that note actually exists — the note is what's immediately visible
	// (the session page, or the involved entities' own Events sections),
	// where `loomDescription` is only ever seen by opening the event's own
	// page. No session note (a bare event with none of noteSession/involved/
	// group/places set) has nowhere to put it, so it falls back to
	// `loomDescription` rather than silently dropping what was typed. Every
	// other entity type is unaffected — this only branches for the beat role.
	const descriptionToSessionNote = roleOf(type) === 'beat' && hasSessionNote;
	const link = (target: string) => `[[${target}]]`;
	const fm: Record<string, unknown> = { [FM.type]: type };
	// Sessions have no user-entered name — their display is the date and their
	// file name is managed from it. Everyone else stores the entered name
	// (`loomName`, the display source of truth) plus a native alias so
	// Obsidian's own [[link]] autocomplete finds the note by that name.
	if (type !== 'session') {
		fm[FM.name] = fields.name;
		fm.aliases = [fields.name];
	}
	fm[FM.tags] = fields.tag === '' ? [] : [fields.tag];
	fm[FM.description] = descriptionToSessionNote ? '' : (fields.description ?? '');
	fm[FM.relationships] = rels.map((r) => ({ type: r.type, target: link(r.target) }));
	if (hasSessionNote) {
		const note: Record<string, unknown> = {
			session: fields.noteSession && fields.noteSession !== '' ? link(fields.noteSession) : '',
			text: descriptionToSessionNote ? (fields.description ?? '') : '',
			seq: Date.now(),
		};
		if (involved.length > 0) note.involved = involved.map(link);
		if (group.length > 0) note.group = group.map(link);
		if (places.length > 0) note.places = places.map(link);
		fm[FM.sessionNotes] = [note];
	}
	if (type === 'location' && fields.parentLocation && fields.parentLocation !== '') {
		fm[FM.parentLocation] = link(fields.parentLocation);
	}
	if (type === 'location' && fields.region && fields.region !== '') fm[FM.region] = link(fields.region);
	if (type === 'event' && fields.decisionPoint && fields.decisionPoint !== '') {
		fm[FM.decisionPoint] = link(fields.decisionPoint);
	}
	if (type === 'event' && fields.eventKind) fm[FM.eventKind] = fields.eventKind;
	if (type === 'faction') {
		// A member with the default role and no location is a plain link.
		fm[FM.members] = (fields.members ?? [])
			.filter((m) => m.character !== '')
			.map((m) => {
				const roleIsDefault = m.role === '' || m.role.toLowerCase() === defaultMemberRole().toLowerCase();
				if (roleIsDefault && m.location === '') return link(m.character);
				return {
					character: link(m.character),
					...(roleIsDefault ? {} : { role: m.role }),
					...(m.location !== '' ? { location: link(m.location) } : {}),
				};
			});
	}
	if (type === 'character') fm[FM.alive] = true;
	if (type === 'event' || type === 'session') fm[FM.date] = fields.date;
	if (type === 'session') {
		fm[FM.attendance] = [];
		if (fields.dailyNote) fm[FM.dailyNote] = fields.dailyNote;
	}
	// Acts aren't dated — they carry a manual order (stamped on the first
	// reorder) and the title that goes into the exported script.
	if (type === 'act') fm[FM.displayTitle] = '';
	if (type === 'quest') {
		fm[FM.questGiver] = (fields.questGivers ?? []).filter((n) => n !== '').map(link);
		fm[FM.questReceived] = fields.questReceived && fields.questReceived !== '' ? link(fields.questReceived) : '';
		fm[FM.questOutcome] = '';
		fm[FM.questOutcomeSession] = '';
		fm[FM.reward] = fields.reward ?? '';
	}
	// Loom-managed timestamps: captured at creation so the real creation date
	// survives cloud-sync overwriting the filesystem ctime. Datetime-property
	// format so Obsidian renders them in the date & time picker.
	const now = formatTimestamp(Date.now());
	fm[FM.created] = now;
	fm[FM.modified] = now;
	// Obsidian's own YAML writer — the same one `processFrontMatter` uses for
	// every later edit, so a new note starts in its final format.
	return `---\n${stringifyYaml(fm)}---\n\n`;
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

/** Removes every structured reference to a note, then moves it to the trash. */
export async function deleteEntityNote(
	plugin: LoomLoomPlugin,
	record: { path: string; project: string }
): Promise<void> {
	const file = plugin.app.vault.getFileByPath(record.path);
	if (!file) return;
	await purgeEntityReferences(plugin, record.path, record.project);
	await plugin.app.fileManager.trashFile(file);
}

/** One-line text prompt (rename, alias, date…) by default — Enter or the CTA
 *  submits. `multiline` swaps the `<input>` for an auto-growing `<textarea>`
 *  (same technique as `AltTextModal`'s own "New alternative wording" field
 *  below: grows with typing up to a CSS `max-height`, then scrolls) for a
 *  caller whose answer can legitimately span more than one line — there,
 *  Enter has to make a newline like any text field, not submit, so only the
 *  CTA button does. */
/** Fits a modal textarea's height to its content (CSS caps it). */
function growToContent(el: HTMLTextAreaElement | HTMLInputElement): void {
	el.setCssProps({ height: 'auto' });
	el.style.height = `${el.scrollHeight}px`;
}

export class TextInputModal extends Modal {
	private submitted = false;

	constructor(
		app: App,
		private opts: {
			title: string;
			/** A line of explanation above the input. */
			desc?: string;
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
		if (this.opts.desc) this.contentEl.createEl('p', { cls: 'setting-item-description', text: this.opts.desc });
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
			const autoGrow = () => growToContent(input);
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
				.setButtonText(this.opts.cta ?? t('project.common.save'))
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
		this.setTitle(t('project.altText.title'));
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
			attr: { placeholder: t('project.altText.newPlaceholder'), rows: 1 },
		});
		// A plain button, not `Setting(...).addButton(...)` — a `Setting` wraps
		// its own content in a full `.setting-item` (its own internal flex
		// layout, a name/description column it assumes is there, and a default
		// top border meant to separate list rows), which fought with `addRow`'s
		// own single-row flex layout instead of joining it: the button landed
		// pushed to the setting-item's own far edge rather than centered next
		// to the input, and that stray top border showed as a half-cut
		// separator line above the row.
		const addBtn = addRow.createEl('button', { cls: 'mod-cta loom-alt-modal-add-btn', text: t('project.common.add') });
		const autoGrowAddTextarea = () => growToContent(input);
		// The button's height is copied from the textarea's natural one-line
		// `scrollHeight` (the two elements' default box models differ, so CSS
		// alone can't match them), deferred a frame until both are laid out.
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
			const autoGrow = () => growToContent(textarea);
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
			const draftBtn = pills.createEl('button', { cls: 'loom-seg-btn', text: t('project.altText.draft') });
			const acceptBtn = pills.createEl('button', { cls: 'loom-seg-btn', text: t('project.altText.accept') });
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
				attr: { 'aria-label': t('project.altText.deleteAria') },
			});
			setIcon(deleteBtn, 'trash-2');
			deleteBtn.disabled = this.options.length <= 1;
			deleteBtn.addEventListener('click', () => {
				new ConfirmModal(
					this.app,
					t('project.altText.deleteConfirmTitle'),
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
					t('project.common.delete')
				).open();
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Search/display label of a record in pickers — the same labels the pages
 *  use: an anchor's date, a sublocation's ancestry ("Tavern, City A", per the
 *  full-ancestry setting), everything else its name. */
export function recordPickLabel(plugin: LoomLoomPlugin, project: ProjectDef, r: EntityRecord): string {
	return r.type === 'location' ? locationLabel(r, plugin) : recordLabel(r, project);
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
		new Notice(t('project.common.nameExists'));
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
		const base = managedSessionFileName(project.name, record.date?.raw ?? '');
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
		this.titleEl.setText(t('project.addRelationship.title'));
		new Setting(this.contentEl).setName(t('project.addRelationship.identifier')).addText((tc) => {
			tc.setPlaceholder(t('project.addRelationship.identifierPlaceholder'));
			tc.onChange((v) => (this.relType = v));
		});
		new Setting(this.contentEl).setName(t('project.addRelationship.target')).addText((tc) => {
			tc.setPlaceholder(t('project.addRelationship.targetPlaceholder'));
			new RecordInputSuggest(
				this.app,
				tc.inputEl,
				() =>
					this.plugin.indexer
						.getAll(undefined, this.project.root)
						.filter((r) => r.path !== this.record.path)
						.sort((a, b) => a.name.localeCompare(b.name)),
				(r) => {
					this.target = r;
					tc.setValue(recordPickLabel(this.plugin, this.project, r));
				},
				(r) => recordPickLabel(this.plugin, this.project, r),
				false,
				// Any entity type can be a relationship target, so this has to
				// ask WHICH type before it can create anything — the same
				// type-picker flow the Involved-entities picker uses (see
				// `view.entity.sessionNotes.createNewEntityAction`'s own key),
				// not a single-type `CreateEntityModal` the way most other
				// `RecordInputSuggest` callers open one directly.
				() =>
					new EntityTypeSuggestModal(this.plugin, (type) =>
						new CreateEntityModal(this.plugin, type, this.project, {
							onCreated: (f) => {
								void waitForMetadataSync(this.app, f).then(() => {
									const rec = this.plugin.indexer.resolve(f.basename, this.project.loomPath) ?? {
										...pcGroupStub(this.project.root),
										path: f.path,
										name: f.basename,
										type,
									};
									this.target = rec;
									tc.setValue(recordPickLabel(this.plugin, this.project, rec));
								});
							},
						}).open()
					).open(),
				t('view.entity.sessionNotes.createNewEntityAction')
			);
		});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText(t('project.common.add'))
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		if (!this.target) {
			new Notice(t('project.addRelationship.pickTarget'));
			return;
		}
		const target = `[[${linkTargetOf(this.target)}]]`;
		const relType = this.relType.trim() === '' ? 'related' : this.relType.trim();
		if (!(await writeFmAt(this.app, this.record.path, (fm) => appendLoomList(fm, FM.relationships, { type: relType, target })))) {
			return;
		}
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
		this.titleEl.setText(
			t('project.addToHolders.title', { item: this.item.name, plural: entityPlural(this.holderType).toLowerCase() })
		);
		let chips: HTMLElement;
		const alreadyHolds = (r: EntityRecord) =>
			r.items.some((lp) => this.plugin.indexer.resolve(lp, r.path)?.path === this.item.path);
		new Setting(this.contentEl).setName(entityPlural(this.holderType)).addText((tc) => {
			tc.setPlaceholder(t('project.common.searchPlaceholder'));
			new RecordInputSuggest(
				this.app,
				tc.inputEl,
				() =>
					this.plugin.indexer
						.getAll(this.holderType, this.project.root)
						.filter((r) => !this.picked.some((p) => p.path === r.path) && !alreadyHolds(r))
						.sort((a, b) => a.name.localeCompare(b.name)),
				(r) => {
					this.picked.push(r);
					refresh();
				},
				(r) => recordPickLabel(this.plugin, this.project, r),
				true,
				() =>
					new CreateEntityModal(this.plugin, this.holderType, this.project, {
						onCreated: (f) => {
							void waitForMetadataSync(this.app, f).then(() => {
								const rec = this.plugin.indexer.resolve(f.basename, this.project.loomPath) ?? {
									...pcGroupStub(this.project.root),
									path: f.path,
									name: f.basename,
									type: this.holderType,
								};
								this.picked.push(rec);
								refresh();
							});
						},
					}).open(),
				t('project.createEntity.createNewAction', { label: entityLabel(this.holderType) })
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
				.setButtonText(t('project.common.add'))
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		if (this.picked.length === 0) {
			new Notice(t('project.addToHolders.pickAtLeastOne', { label: entityLabel(this.holderType).toLowerCase() }));
			return;
		}
		const link = `[[${linkTargetOf(this.item)}]]`;
		for (const holder of this.picked) {
			await writeFmAt(this.app, holder.path, (fm) => appendLoomList(fm, FM.items, link));
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

/** The type-filter menu behind every filter icon beside an entity search:
 *  "All entities", then one checked row per type. */
export function showTypeFilterMenu(
	evt: MouseEvent,
	types: readonly EntityType[],
	current: EntityType | null,
	onPick: (type: EntityType | null) => void
): void {
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(t('project.createEntity.allEntities'))
			.setIcon('filter')
			.setChecked(current === null)
			.onClick(() => onPick(null))
	);
	for (const et of types) {
		menu.addItem((item) =>
			item
				.setTitle(entityPlural(et))
				.setIcon(ENTITY_META[et].icon)
				.setChecked(current === et)
				.onClick(() => onPick(et))
		);
	}
	menu.showAtMouseEvent(evt);
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

/** Sentinel path for the synthetic "+ Create new …" row `RecordInputSuggest`
 *  can prepend to its own suggestion list — never a real file, so nothing
 *  else needs to recognize it except `selectSuggestion` itself below. */
const CREATE_NEW_SUGGESTION = 'loom:create-new-suggestion';

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
		private clearOnPick = true,
		/** When set, a "+ Create new …" row always leads the suggestion list —
		 *  every selectable search should expose a way to create what it's
		 *  missing, not just show empty when nothing matches yet. A function
		 *  (rather than a plain string) so a field whose target TYPE can
		 *  change after construction (the Involved picker's type filter) can
		 *  still read that choice live instead of freezing it at build time. */
		private onCreateNew?: () => void,
		private createLabel?: string | (() => string)
	) {
		super(app, input);
	}

	private createLabelText(): string {
		return typeof this.createLabel === 'function' ? this.createLabel() : (this.createLabel ?? '');
	}

	getSuggestions(query: string): EntityRecord[] {
		const q = query.toLowerCase();
		const matches = this.records().filter(
			(r) => r.name.toLowerCase().includes(q) || this.label(r).toLowerCase().includes(q)
		);
		if (!this.onCreateNew) return matches;
		const createRow: EntityRecord = { ...pcGroupStub(''), path: CREATE_NEW_SUGGESTION, name: this.createLabelText() };
		return [createRow, ...matches];
	}

	renderSuggestion(r: EntityRecord, el: HTMLElement): void {
		if (r.path === CREATE_NEW_SUGGESTION) {
			el.addClass('loom-suggest-create-new');
			el.setText(this.createLabelText());
			return;
		}
		el.setText(this.label(r));
	}

	selectSuggestion(r: EntityRecord): void {
		if (r.path === CREATE_NEW_SUGGESTION) {
			this.close();
			this.onCreateNew?.();
			return;
		}
		this.pick(r);
		if (this.clearOnPick) this.input.value = '';
		this.close();
	}
}

/** The sublocation of `main` named `name` (case-insensitive), created when
 *  missing — a just-created one comes back as a stand-in record, since the
 *  index hasn't seen it yet. */
export async function findOrCreateSublocation(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	main: EntityRecord,
	name: string
): Promise<EntityRecord> {
	const key = name.trim().toLowerCase();
	const existing = plugin.indexer
		.getAll('location', project.root)
		.find(
			(r) =>
				r.parentLocation !== null &&
				r.name.trim().toLowerCase() === key &&
				plugin.indexer.resolve(r.parentLocation, r.path)?.path === main.path
		);
	if (existing) return existing;
	const parentLocation = linkTargetOf(main);
	const created = await createEntity(plugin, project, 'location', {
		name: name.trim(),
		tag: '',
		date: '',
		description: '',
		parentLocation,
	});
	return { ...pcGroupStub(project.root), path: created.path, name: name.trim(), type: 'location', parentLocation };
}

/** Types whose names legitimately repeat — sessions are named by date, and
 *  scenes/acts/chapters by their script or book heading — so a clash gets a
 *  numbered file. Every other type is named by the user and must be unique. */
const REPEATABLE_NAME_TYPES: ReadonlySet<EntityType> = new Set(['session', 'scene', 'act', 'chapter']);

/** The managed path a new entity of `type` named by `fields` would take. */
export function newEntityPath(plugin: LoomLoomPlugin, project: ProjectDef, type: EntityType, fields: NewEntityFields): string {
	// A new sublocation embeds its parent's name in the file name.
	const parentName =
		type === 'location' && fields.parentLocation && fields.parentLocation !== ''
			? plugin.indexer.resolve(fields.parentLocation, '')?.name
			: undefined;
	const base =
		type === 'session'
			? managedSessionFileName(project.name, fields.date)
			: managedEntityFileName(project.name, type, fields.name, parentName);
	return normalizePath(`${projectPath(project, ENTITY_META[type].folder)}/${base}.md`);
}

/** Whether a user-named entity's managed file name is already taken. */
export function entityNameTaken(plugin: LoomLoomPlugin, project: ProjectDef, type: EntityType, fields: NewEntityFields): boolean {
	return !REPEATABLE_NAME_TYPES.has(type) && plugin.app.vault.getAbstractFileByPath(newEntityPath(plugin, project, type, fields)) !== null;
}

/** Creates an entity note at its managed path. A user-named entity whose name
 *  is taken returns the EXISTING note rather than a numbered duplicate
 *  (numbered copies multiply across synced machines); a repeatable-name type
 *  gets `<name> 2`, `<name> 3`, …. */
export async function createEntity(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	type: EntityType,
	fields: NewEntityFields
): Promise<TFile> {
	await ensureFolder(plugin.app, projectPath(project, ENTITY_META[type].folder));
	const first = newEntityPath(plugin, project, type, fields);
	let path = first;
	const existing = plugin.app.vault.getFileByPath(first);
	if (existing && !REPEATABLE_NAME_TYPES.has(type)) return existing;
	const base = first.slice(0, -'.md'.length);
	for (let i = 2; plugin.app.vault.getAbstractFileByPath(path) !== null; i++) {
		path = `${base} ${i}.md`;
	}
	if (type === 'session' && !fields.dailyNote) {
		fields = { ...fields, dailyNote: dailyNoteLink(plugin.app, fields.date) ?? undefined };
	}
	return plugin.app.vault.create(path, buildEntityContent(type, fields));
}

/**
 * Reads/rewrites the project's Book file — `editBook`'s job (book-view.tsx),
 * duplicated here because book-view.tsx imports from this module. Creates the
 * Book on first write (a Prose project has none scaffolded), like
 * `createBookFile`, and runs `ensureBookIds` on the result like
 * `editBookAndSync`, so a chapter/act created through a modal is normalized
 * at creation time, not on the next edit. Serialized on the same per-path
 * queue as `editBook` (`queueWrite`, write-queue.ts), so the two can't race
 * on the file.
 */
async function editBookFile(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	apply: (text: string) => string
): Promise<string> {
	const fullPath = projectPath(project, `${project.name}.${BOOK_EXTENSION}`);
	return queueWrite(fullPath, async () => {
		let file = plugin.app.vault.getFileByPath(fullPath);
		if (!file) file = await plugin.app.vault.create(fullPath, '');
		const raw = await plugin.app.vault.read(file);
		const next = ensureBookIds(apply(raw)).text;
		if (next !== raw) await plugin.app.vault.modify(file, next);
		return next;
	});
}

/** Sentinel path for the "+ New act" pinned entry in the Scene creation
 *  modal's act picker — never a real file, same trick as the virtual
 *  Group faction (`PC_GROUP_VALUE`). */
const NEW_ACT_SENTINEL = 'loom:new-act';
function newActStub(projectRoot: string): EntityRecord {
	return { ...pcGroupStub(projectRoot), path: NEW_ACT_SENTINEL, name: t('project.newActStub'), type: 'act' };
}

/** Writes a newly-created Scene/Act/Chapter's Notes as the note's raw body. */
async function writeNotesBody(plugin: LoomLoomPlugin, file: TFile, notes: string): Promise<void> {
	const trimmed = notes.trim();
	if (trimmed !== '') await writeNoteBody(plugin.app, file, trimmed);
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
	const path = normalizePath(`${folder}/${base}.md`);
	// This character already has a copy of this item — reuse it rather than
	// making a numbered duplicate.
	const existing = plugin.app.vault.getFileByPath(path);
	if (existing) return existing;
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
	/** Events only (GM projects): prefill the new event's Decision Point. */
	decisionPoint?: EntityRecord;
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
	/** Acts only: called with a full stand-in record instead of opening the
	 *  new page or firing `onCreated` — the Scene modal's "+ New act" nested
	 *  pick uses this so it can hand the created act straight to its own
	 *  act picker instead of navigating away mid-scene-creation. */
	onActCreated?: (record: EntityRecord) => void;
	/** Scenes/Chapters only: pre-picks the Act field — the Act page's own
	 *  "+ New scene"/"+ New chapter" button uses this so a scene/chapter
	 *  added from there lands in THIS act without making the user pick it
	 *  again. Still changeable; just a starting pick, not a lock. */
	defaultAct?: EntityRecord;
}

/** A `SearchableSelect` "+ Create new <type>" action opening `CreateEntityModal`;
 *  `undefined` (no action) without a project. */
export function createAction(
	plugin: LoomLoomPlugin,
	type: EntityType,
	project: ProjectDef | null | undefined,
	options: CreateEntityOptions
): { label: string; onPick: () => void } | undefined {
	if (!project) return undefined;
	return {
		label: t('project.createEntity.createNewAction', { label: entityLabel(type) }),
		onPick: () => new CreateEntityModal(plugin, type, project, options).open(),
	};
}

export class CreateEntityModal extends Modal {
	/** Index subscriptions held while open (chip rows redraw as notes index). */
	private indexRefs: EventRef[] = [];
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
		const setting = new Setting(this.contentEl).setName(t('project.createEntity.tagLabel'));
		const seg = setting.controlEl.createDiv({ cls: 'loom-seg' });
		const buttons: HTMLButtonElement[] = [];
		const refresh = () => {
			for (const b of buttons) b.classList.toggle('loom-seg-on', this.fields.tag === b.dataset.tag);
		};
		const tagLabel = (tag: string) =>
			this.type === 'quest' ? t(`settings.entities.questTagNames.${tag}` as LocaleKey) : tag;
		for (const opt of [{ v: '', label: '—' }, ...vocab.map((tag) => ({ v: tag, label: tagLabel(tag) }))]) {
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

	/** Resolves a picked name back to its record (for chip colors). */
	private resolveName(name: string): EntityRecord | null {
		return this.plugin.indexer.resolve(name, this.project.loomPath);
	}

	/**
	 * A "+ Create new …" pick inside this modal opens a NESTED CreateEntityModal
	 * and needs the new file back as an `EntityRecord` (for its chip) as soon
	 * as it closes — but metadataCache re-parses a just-written file on a later
	 * tick (see `waitForMetadataSync`). Falls back to a minimal stand-in
	 * (name/type only) if resolution still misses, so the pick never silently
	 * does nothing.
	 */
	private async resolveAfterCreate(f: TFile, type: EntityType): Promise<EntityRecord> {
		const indexed = this.plugin.indexer.resolve(f.basename, this.project.loomPath);
		if (indexed) return indexed;
		await waitForMetadataSync(this.app, f);
		return (
			this.plugin.indexer.resolve(f.basename, this.project.loomPath) ?? {
				...pcGroupStub(this.project.root),
				path: f.path,
				name: f.basename,
				type,
			}
		);
	}

	/** Closes the modal and hands the new note on: `onActCreated` (with its
	 *  record, when given one), else `onCreated`, else opens its page with the
	 *  type's list as the Back origin. */
	private finishCreate(created: TFile, record?: EntityRecord): void {
		this.close();
		if (record && this.options.onActCreated) this.options.onActCreated(record);
		else if (this.options.onCreated) this.options.onCreated(created);
		else {
			const origin: EntityOrigin = { type: VIEW_LIST, state: { project: this.project.root, entityType: this.type } };
			this.plugin.openEntityFile(created.path, origin);
		}
	}

	/** A picker input whose "+ Create new" opens a nested modal and picks the
	 *  created record once it's indexed. */
	private singlePickInput(
		el: HTMLElement,
		placeholder: string,
		options: () => EntityRecord[],
		label: (r: EntityRecord) => string,
		type: EntityType,
		pick: (r: EntityRecord) => void
	): void {
		const input = el.createEl('input', { type: 'text', attr: { placeholder } });
		new RecordInputSuggest(
			this.app,
			input,
			options,
			pick,
			label,
			true,
			() =>
				new CreateEntityModal(this.plugin, type, this.project, {
					onCreated: (f) => {
						void this.resolveAfterCreate(f, type).then(pick);
					},
				}).open(),
			t('project.createEntity.createNewAction', { label: entityLabel(type) })
		);
	}

	/** A multi-pick field: a search whose picks collect into `this.fields[key]`
	 *  as ✕ chips. `create` runs the "+ Create new" flow and hands it
	 *  `addCreated`, which waits for the new note to index so its chip shows its
	 *  name and colour. `onPick` returning true means it handled the pick itself;
	 *  `leadingChips` draws chips ahead of the list's own. Returns the chip
	 *  refresher. */
	private multiPick(o: {
		key: 'questGivers' | 'involved' | 'places';
		name: string;
		placeholder: string;
		candidates: () => EntityRecord[];
		label: (r: EntityRecord) => string;
		createLabel: string;
		create: (addCreated: (f: TFile, type: EntityType) => void) => void;
		onPick?: (r: EntityRecord) => boolean;
		leadingChips?: (el: HTMLElement, refresh: () => void) => void;
		decorate?: (setting: Setting) => void;
	}): () => void {
		const list = () => (this.fields[o.key] ??= []);
		const refresh = () => {
			chips.empty();
			o.leadingChips?.(chips, refresh);
			for (const target of list()) {
				const rec = this.resolveName(target);
				renderChipEl(this.plugin, chips, rec, rec ? o.label(rec) : target, () => {
					this.fields[o.key] = list().filter((n) => n !== target);
					refresh();
				});
			}
		};
		const setting = new Setting(this.contentEl).setName(o.name).addText((text) => {
			text.setPlaceholder(o.placeholder);
			new RecordInputSuggest(
				this.app,
				text.inputEl,
				o.candidates,
				(r) => {
					if (!o.onPick?.(r)) list().push(linkTargetOf(r));
					refresh();
				},
				o.label,
				true,
				() =>
					o.create((f, type) => {
						void this.resolveAfterCreate(f, type).then((rec) => {
							list().push(linkTargetOf(rec));
							refresh();
						});
					}),
				o.createLabel
			);
		});
		o.decorate?.(setting);
		const chips = this.contentEl.createDiv({ cls: 'loom-modal-chips' });
		refresh();
		// A note created from "+ Create new" can land in the index after its chip
		// was drawn — redraw then, so the chip shows its name and colour.
		this.indexRefs.push(this.plugin.indexer.events.on('changed', refresh));
		return refresh;
	}

	/** Role · (of) target · at location · ✕ rows under a "+ Add" button — a
	 *  character's Faction(s) or a faction's Members. `rows` is the live
	 *  `this.fields` list. */
	private membershipRows<K extends 'faction' | 'character'>(
		key: K,
		rows: (Record<K, string> & { role: string; location: string })[],
		heading: string,
		addLabel: string
	): void {
		const targets = this.plugin.indexer.getAll(key, this.project.root).sort((a, b) => a.name.localeCompare(b.name));
		const locations = this.plugin.indexer
			.getAll('location', this.project.root)
			.sort((a, b) => a.name.localeCompare(b.name));
		// Row list lives BELOW the add button (created after it).
		let rowsEl: HTMLElement;
		// Rebuilds recreate every row's inputs — restore their values from the
		// stored fields (link targets → display names), or adding a second row
		// visually wipes every earlier one's text.
		const displayNameOf = (records: EntityRecord[], linkTarget: string) =>
			records.find((r) => linkTargetOf(r) === linkTarget)?.name ?? linkTarget;
		/** Input + suggester + create-new for one record field of a row. */
		const pickInput = (
			row: HTMLElement,
			type: EntityType,
			placeholder: string,
			value: string,
			records: EntityRecord[],
			options: () => EntityRecord[],
			label: (r: EntityRecord) => string,
			set: (target: string) => void
		) => {
			const input = row.createEl('input', { type: 'text', attr: { placeholder } });
			input.value = value === '' ? '' : displayNameOf(records, value);
			new RecordInputSuggest(
				this.app,
				input,
				options,
				(r) => {
					set(linkTargetOf(r));
					input.value = r.name;
				},
				label,
				false,
				() =>
					new CreateEntityModal(this.plugin, type, this.project, {
						onCreated: (f) => {
							set(f.basename);
							void waitForMetadataSync(this.app, f).then(() => {
								input.value = this.plugin.indexer.resolve(f.basename, this.project.loomPath)?.name ?? f.basename;
							});
						},
					}).open(),
				t('project.createEntity.createNewAction', { label: entityLabel(type) })
			);
		};
		const render = () => {
			rowsEl.empty();
			rows.forEach((m, i) => {
				const row = rowsEl.createDiv({ cls: 'loom-modal-faction-row' });
				const roleInput = row.createEl('input', {
					type: 'text',
					attr: { placeholder: t('project.createEntity.memberPlaceholder') },
				});
				roleInput.value = m.role;
				roleInput.addEventListener('input', () => (m.role = roleInput.value.trim()));
				if (key === 'faction') row.createSpan({ text: t('project.createEntity.ofLabel'), cls: 'loom-modal-faction-lbl' });
				pickInput(
					row,
					key,
					t(key === 'faction' ? 'project.createEntity.factionEllipsis' : 'project.createEntity.characterEllipsis'),
					m[key],
					targets,
					() => targets.filter((r) => !rows.some((x) => x[key] === linkTargetOf(r))),
					(r) => r.name,
					(target) => (m[key] = target as (typeof m)[K])
				);
				row.createSpan({ text: t('project.createEntity.atLabel'), cls: 'loom-modal-faction-lbl' });
				pickInput(
					row,
					'location',
					t('project.createEntity.locationEllipsis'),
					m.location,
					locations,
					() => locations,
					(r) => locationLabel(r, this.plugin),
					(target) => (m.location = target)
				);
				const rm = row.createEl('button', { text: '✕', cls: 'loom-chip-remove' });
				rm.addEventListener('click', (e) => {
					e.preventDefault();
					rows.splice(i, 1);
					render();
				});
			});
		};
		new Setting(this.contentEl).setName(heading).addButton((btn) => {
			// Sentence-case label + a separate "+ " so it reads "+ Add …" without
			// tripping the lint.
			btn.setButtonText(addLabel);
			btn.buttonEl.prepend('+ ');
			btn.onClick(() => {
				rows.push({ [key]: '', role: defaultMemberRole(), location: '' } as (typeof rows)[number]);
				render();
			});
		});
		rowsEl = this.contentEl.createDiv({ cls: 'loom-modal-factions' });
		render();
	}

	onOpen(): void {
		// Scene, Act and Chapter are structural beat/anchor types with no
		// generic Name/Involved/Locations/Date/Description shape — Scene and
		// Act are script-backed (their writing lives in the .fountain file,
		// not note fields); Chapter is book-backed the same way once the Book
		// parser exists. All three get their own dedicated layout instead of
		// falling through the generic fields below.
		if (this.type === 'scene') {
			this.renderSceneModal();
			return;
		}
		if (this.type === 'act') {
			this.renderActModal();
			return;
		}
		if (this.type === 'chapter') {
			this.renderChapterModal();
			return;
		}
		this.setTitle(
			this.options.parentLocation
				? t('project.createEntity.newSublocationTitle')
				: newEntityTitle(this.type)
		);

		if (this.type !== 'session') {
			// The event/quest Name is always a search over existing ones —
			// whether opened from a session page or the plain entity list, so
			// there's one event-creation experience, not two: picking a match
			// pins it to the session when one is known (`noteSession`), or just
			// opens the existing one otherwise (see `submit()`'s `pickedExisting`
			// branch); typing a new name just creates it either way.
			const searchable = roleOf(this.type) === 'beat' || this.type === 'quest';
			const noun = entityLabel(this.type).toLowerCase();
			const indefinite = article(noun);
			new Setting(this.contentEl)
				.setName(
					t(
						this.type === 'character'
							? 'project.createEntity.characterNameLabel'
							: 'project.createEntity.nameLabel'
					)
				)
				.addText((text) => {
				text
					.setPlaceholder(
						searchable
							? t('project.createEntity.namePlaceholderSearchable', { article: indefinite, noun })
							: t('project.createEntity.namePlaceholderNew', { label: entityLabel(this.type) })
					)
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
			const sessions = this.plugin.indexer
				.getAll(projectRoleType(this.project.config, 'anchor'), this.project.root)
				.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0));
			const characters = this.plugin.indexer
				.getAll('character', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));

			// Quest givers: search + entity tags with ✕, like the quest page.
			this.fields.questGivers = [];
			this.multiPick({
				key: 'questGivers',
				name: t('project.createEntity.questGiver'),
				placeholder: t('project.createEntity.addQuestGiver'),
				candidates: () => characters.filter((c) => !(this.fields.questGivers ?? []).includes(linkTargetOf(c))),
				label: (r) => r.name,
				createLabel: t('project.createEntity.createNewAction', { label: entityLabel('character') }),
				create: (addCreated) =>
					new CreateEntityModal(this.plugin, 'character', this.project, {
						onCreated: (f) => addCreated(f, 'character'),
					}).open(),
			});

			// Received session: search like the quest page; the pick becomes a
			// session tag with ✕. Quests born from a session page (or from an event
			// note that already carries a session) default there.
			this.receivedSession = this.options.noteSession ?? this.options.receivedSession ?? null;
			const receivedSetting = new Setting(this.contentEl).setName(t('project.createEntity.receivedInSession'));
			const receivedEl = receivedSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
			const refreshReceived = () => {
				receivedEl.empty();
				if (this.receivedSession) {
					renderChipEl(this.plugin, receivedEl, this.receivedSession, recordLabel(this.receivedSession, this.project), () => {
						this.receivedSession = null;
						refreshReceived();
					});
				} else {
					this.singlePickInput(
						receivedEl,
						t('project.createEntity.pickSession'),
						() => sessions,
						(r) => recordLabel(r, this.project),
						projectRoleType(this.project.config, 'anchor'),
						(r) => {
							this.receivedSession = r;
							refreshReceived();
						}
					);
				}
			};
			refreshReceived();

			// Quest tags (main / important / side) sit right after the session.
			this.renderTagPills();

			const reward = new Setting(this.contentEl)
				.setName(t('project.createEntity.reward'))
				.addTextArea((text) =>
					text.setPlaceholder(t('common.notSpecified')).onChange((v) => (this.fields.reward = v.trim()))
				);
			reward.setClass('loom-modal-wide');
			// Full-width row: label above, the text box using the whole window width.
			const desc = new Setting(this.contentEl)
				.setName(t('project.createEntity.description'))
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			desc.setClass('loom-modal-wide');
		}

		if (this.type === 'session') {
			// Sessions are always Gregorian, so a native date input's calendar
			// picker applies cleanly — no free-text/custom-calendar ambiguity
			// like events have, and it already lands on today by default.
			new Setting(this.contentEl).setName(t('project.createEntity.date')).addText((text) => {
				text.inputEl.type = 'date';
				text.setValue(this.fields.date).onChange((v) => (this.fields.date = v));
			});
		}

	if (roleOf(this.type) === 'beat') {
			// Birth session (skipped only when the session page already provides
			// it): search over sessions, the pick becomes a session tag with ✕.
			// Every event is created through this one session flow.
			if (!this.options.noteSession) {
				const sessions = this.plugin.indexer
					.getAll(projectRoleType(this.project.config, 'anchor'), this.project.root)
					.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0));
				// A scene MUST have an act — that's where its writing lives, so
				// an actless scene has nowhere to belong. An event may be a
				// session-less lore event, so there the pick stays optional.
				const anchorType = projectRoleType(this.project.config, 'anchor');
				const sessionSetting = new Setting(this.contentEl)
					.setName(entityLabel(anchorType))
					.setDesc(
						this.anchorRequired()
							? t('project.createEntity.anchorDescRequired', {
									anchor: entityLabel(anchorType).toLowerCase(),
									type: entityLabel(this.type).toLowerCase(),
								})
							: t('project.createEntity.anchorDescOptional')
					);
				const sessionEl = sessionSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
				const refreshSession = () => {
					sessionEl.empty();
					if (this.pickedSession) {
						renderChipEl(this.plugin, sessionEl, this.pickedSession, recordLabel(this.pickedSession, this.project), () => {
							this.pickedSession = null;
							refreshSession();
						});
					} else {
						this.singlePickInput(
							sessionEl,
							this.anchorRequired()
								? t('project.createEntity.pickAnchor', { anchor: entityLabel(anchorType).toLowerCase() })
								: t('common.notSpecified'),
							() => sessions,
							(r) => recordLabel(r, this.project),
							anchorType,
							(r) => {
								this.pickedSession = r;
								refreshSession();
							}
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
					.filter((r) => isInvolvableType(r.type))
					.filter((r) => involveFilter === null || r.type === involveFilter)
					.filter((r) => !taken(r))
					.sort((a, b) => a.name.localeCompare(b.name)),
			];
			this.multiPick({
				key: 'involved',
				name: t('project.createEntity.involvedEntities'),
				placeholder: t('project.createEntity.involvePlaceholder'),
				candidates,
				label: (r) => r.name,
				createLabel: t('view.entity.sessionNotes.createNewEntityAction'),
				// Same "pick a type, then create" flow as the entity page's own
				// Involve… control: an active type filter creates that type
				// directly, otherwise `EntityTypeSuggestModal` asks.
				create: (addCreated) => {
					const createAs = (type: EntityType) =>
						new CreateEntityModal(this.plugin, type, this.project, {
							onCreated: (f) => addCreated(f, type),
						}).open();
					if (involveFilter !== null) createAs(involveFilter);
					else new EntityTypeSuggestModal(this.plugin, createAs, this.project, ['decisionPoint']).open();
				},
				// The virtual "Group" snapshots the current party into `group`.
				onPick: (r) => {
					if (r.path !== PC_GROUP_VALUE) return false;
					const group = (this.fields.group ??= []);
					for (const pc of missingPcs()) group.push(linkTargetOf(pc));
					return true;
				},
				leadingChips: (el, refresh) => {
					if ((this.fields.group ?? []).length === 0) return;
					const label = groupNameOf(this.project.config);
					renderChipEl(this.plugin, el, pcGroupStub(this.project.root, label), label, () => {
						this.fields.group = undefined;
						refresh();
					});
				},
				decorate: (setting) => {
					setting.addExtraButton((btn) => {
						btn.setIcon('filter').setTooltip(t('project.createEntity.filterByType'));
						btn.extraSettingsEl.addEventListener('click', (e) =>
							showTypeFilterMenu(e, projectTypes(this.project.config).filter(isInvolvableType), involveFilter, (type) => {
								involveFilter = type;
								btn.setIcon(type ? ENTITY_META[type].icon : 'filter');
							})
						);
					});
				},
			});

			// Locations: where the event takes place — written into the starting
			// note's `places` (like the pages' Location… picker). Main locations
			// sort above their sublocations.
			const placeTaken = (r: EntityRecord) => (this.fields.places ?? []).includes(linkTargetOf(r));
			const placeCandidates = () =>
				this.plugin.indexer
					.getAll('location', this.project.root)
					.filter((r) => !placeTaken(r))
					.sort(mainLocationFirst);
			this.multiPick({
				key: 'places',
				name: entityPlural('location'),
				placeholder: t('project.createEntity.locationEllipsis'),
				candidates: placeCandidates,
				label: (r) => locationLabel(r, this.plugin),
				createLabel: t('project.createEntity.createNewAction', { label: entityLabel('location') }),
				create: (addCreated) =>
					new CreateEntityModal(this.plugin, 'location', this.project, {
						onCreated: (f) => addCreated(f, 'location'),
					}).open(),
			});
		}

		// Events born from a session page need no date — the session carries it.
		// (The Involved picker below writes into that session note, so it only
		// appears for session-born events.)
		if (roleOf(this.type) === 'beat' && !this.options.noteSession) {
			let dateText: TextComponent;
			new Setting(this.contentEl)
				.setName(t('project.createEntity.date'))
				.setDesc(t('project.createEntity.dateFormatDesc'))
				.addText((text) => {
					dateText = text;
					text
						.setPlaceholder(t('project.createEntity.dateFormatPlaceholder'))
						.setValue(this.fields.date)
						.onChange((v) => (this.fields.date = v.trim()));
				})
				.addExtraButton((btn) =>
					btn
						.setIcon('calendar')
						.setTooltip(t('project.createEntity.setToToday'))
						.onClick(() => {
							this.fields.date = todayRaw();
							dateText.setValue(this.fields.date);
						})
				);
		}

		if (this.type === 'character') {
			// Faction memberships — role (default Member) of <faction> at
			// <location> — applied to the faction's members after creation.
			this.fields.factions = [];
			this.membershipRows('faction', this.fields.factions, entityLabel('faction'), t('project.createEntity.addFactionButton'));
			const charDesc = new Setting(this.contentEl)
				.setName(t('project.createEntity.description'))
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			charDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'faction') {
			// Member characters written straight into this faction's own `members`.
			this.fields.members = [];
			this.membershipRows(
				'character',
				this.fields.members,
				t('project.createEntity.membersLabel'),
				t('project.createEntity.addMemberButton')
			);
			const facDesc = new Setting(this.contentEl)
				.setName(t('project.createEntity.description'))
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			facDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'item') {
			const itemDesc = new Setting(this.contentEl)
				.setName(t('project.createEntity.description'))
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			itemDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'location') {
			// Sublocation of (optional) + a full-width Description. Main locations
			// sort above their sublocations (same ordering as the other pickers).
			const locations = this.plugin.indexer
				.getAll('location', this.project.root)
				.sort(mainLocationFirst);
			let pickedParent: EntityRecord | null = this.options.parentLocation ?? null;
			if (pickedParent) this.fields.parentLocation = linkTargetOf(pickedParent);
			const parentSetting = new Setting(this.contentEl).setName(t('project.createEntity.sublocationOf'));
			const parentEl = parentSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
			// Part of region (optional, MAIN locations only) — a grouping layer
			// above locations. A sublocation inherits its region from whichever
			// main location it sits under (computed on its own page, never its
			// own field — see `FM.region`'s doc comment for why: a directly-set
			// sublocation region would also draw its own graph edge, which isn't
			// wanted, only location->region and sublocation->location are), so
			// the picker below is a MAIN-location-only field and hides the
			// moment a parent gets picked here.
			const regions = this.plugin.indexer
				.getAll('region', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));
			let pickedRegion: EntityRecord | null = this.options.region ?? null;
			if (pickedRegion) this.fields.region = linkTargetOf(pickedRegion);
			const regionSetting = new Setting(this.contentEl).setName(t('project.createEntity.partOfRegion'));
			const regionEl = regionSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
			const refreshRegion = () => {
				regionSetting.settingEl.style.display = pickedParent ? 'none' : '';
				regionEl.empty();
				if (pickedRegion) {
					renderChipEl(this.plugin, regionEl, pickedRegion, pickedRegion.name, () => {
						pickedRegion = null;
						this.fields.region = '';
						refreshRegion();
					});
				} else {
					this.singlePickInput(
						regionEl,
						t('project.createEntity.notSpecifiedParens'),
						() => regions,
						(r) => r.name,
						'region',
						(r) => {
							pickedRegion = r;
							this.fields.region = linkTargetOf(r);
							refreshRegion();
						}
					);
				}
			};
			const refreshParent = () => {
				parentEl.empty();
				if (pickedParent) {
					renderChipEl(this.plugin, parentEl, pickedParent, pickedParent.name, () => {
						pickedParent = null;
						this.fields.parentLocation = '';
						refreshParent();
					});
				} else {
					this.singlePickInput(
						parentEl,
						t('project.createEntity.optionalPlaceholder'),
						() => locations,
						(r) => locationLabel(r, this.plugin),
						'location',
						(r) => {
							pickedParent = r;
							this.fields.parentLocation = linkTargetOf(r);
							// A sublocation's region is inherited, never picked here.
							pickedRegion = null;
							this.fields.region = '';
							refreshParent();
							refreshRegion();
						}
					);
				}
				refreshRegion();
			};
			refreshParent();
			const locDesc = new Setting(this.contentEl)
				.setName(t('project.createEntity.description'))
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			locDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'region' || this.type === 'decisionPoint') {
			const groupDesc = new Setting(this.contentEl)
				.setName(t('project.createEntity.description'))
				.addTextArea((text) => text.onChange((v) => (this.fields.description = v.trim())));
			groupDesc.setClass('loom-modal-wide');
		}

		if (this.type === 'event' && featuresOf(this.project.config.kind, this.project.config.writerMode).eventPlanning) {
			// New events default to Planned (see ROADMAP.md's "Game Master"
			// entry) — never surfaced as a field here, just written on submit.
			this.fields.eventKind = 'planned';
			const decisionPoints = this.plugin.indexer
				.getAll('decisionPoint', this.project.root)
				.sort((a, b) => a.name.localeCompare(b.name));
			let pickedDp: EntityRecord | null = this.options.decisionPoint ?? null;
			if (pickedDp) this.fields.decisionPoint = linkTargetOf(pickedDp);
			const dpSetting = new Setting(this.contentEl).setName(t('project.createEntity.decisionPoint'));
			const dpEl = dpSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
			const refreshDp = () => {
				dpEl.empty();
				if (pickedDp) {
					renderChipEl(this.plugin, dpEl, pickedDp, pickedDp.name, () => {
						pickedDp = null;
						this.fields.decisionPoint = '';
						refreshDp();
					});
				} else {
					this.singlePickInput(
						dpEl,
						t('project.createEntity.notSpecifiedParens'),
						() => decisionPoints,
						(r) => r.name,
						'decisionPoint',
						(r) => {
							pickedDp = r;
							this.fields.decisionPoint = linkTargetOf(r);
							refreshDp();
						}
					);
				}
			};
			refreshDp();
		}

		if (roleOf(this.type) === 'beat') {
			// Born with a session (from a session page — the common case this
			// covers), this field writes into the STARTING session note's own
			// text (`buildEntityContent`'s `descriptionToSessionNote`) rather than
			// `loomDescription`, so what's typed here is immediately visible on
			// the session page instead of only from the event's own page. Labeled
			// accordingly — a session-less event (opened without `noteSession`)
			// keeps the plain "Description" label, since whether one ends up
			// created here depends on live Involved/Locations picks made further
			// up the form, not something worth relabeling dynamically for.
			// When an existing event is picked (session-page add), its description
			// is shown read-only — you're adding it to the session, not editing it.
			const bornWithSession = this.options.noteSession !== undefined;
			const evDesc = new Setting(this.contentEl).setName(
				bornWithSession ? t('project.createEntity.sessionNoteLabel') : t('project.createEntity.description')
			);
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
				if (existing) {
					roEl.setText(existing.description !== '' ? existing.description : t('project.createEntity.noDescription'));
				}
				evDesc.setName(
					existing
						? t('project.createEntity.descriptionExisting')
						: bornWithSession
							? t('project.createEntity.sessionNoteLabel')
							: t('project.createEntity.description')
				);
			};
			this.refreshDesc();
		}

		const connectTo = this.options.connectTo;
		if (connectTo) {
			new Setting(this.contentEl)
				.setName(t('project.createEntity.relationship'))
				.setDesc(
					t('project.createEntity.relationshipDesc', {
						type: entityLabel(this.type).toLowerCase(),
						target: connectTo.label,
					})
				)
				.addText((text) =>
					text
						.setPlaceholder(t('project.createEntity.identifierPlaceholder'))
						.onChange((v) => (this.relComment = v.trim()))
				);
		}

		new Setting(this.contentEl).addButton((btn) => {
			this.submitBtn = btn;
			btn
				.setButtonText(t('project.createEntity.createButton'))
				.setCta()
				.onClick(() => void this.submit());
			this.refreshSubmitLabel();
		});
	}

	/** Primary button reads "Add" when a name search matched an existing
	 *  event/quest (it gets pinned to the session), "Create" otherwise. */
	private refreshSubmitLabel(): void {
		this.submitBtn?.setButtonText(this.pickedExisting ? t('project.common.add') : t('project.createEntity.createButton'));
	}

	/**
	 * Whether this entity cannot be created without an anchor. A Scene's writing
	 * lives inside its Act's section of the script, so an actless scene
	 * has nowhere to be stored; an Event, by contrast, may legitimately be a
	 * session-less lore event.
	 */
	private anchorRequired(): boolean {
		return this.type === 'scene';
	}

	private async submit(): Promise<void> {
		// Name search matched an existing event/quest: pin it to the session
		// rather than creating a duplicate — or, with no session in context
		// (opened from the plain entity list), just open the existing one.
		if (this.pickedExisting) {
			await this.pinExisting(this.pickedExisting, this.options.noteSession ?? null);
			return;
		}
		if (this.type !== 'session' && this.fields.name === '') {
			new Notice(t('project.createEntity.nameRequired'));
			return;
		}
		if (this.type === 'session' && this.fields.date === '') {
			new Notice(t('project.createEntity.dateRequired'));
			return;
		}
		if (this.anchorRequired() && !this.options.noteSession && !this.pickedSession) {
			const anchorType = projectRoleType(this.project.config, 'anchor');
			new Notice(t('project.createEntity.anchorRequiredNotice', { anchor: entityLabel(anchorType) }));
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
		if (entityNameTaken(this.plugin, this.project, this.type, this.fields)) {
			new Notice(t('project.common.nameExists'));
			return;
		}
		try {
			const file = await createEntity(this.plugin, this.project, this.type, this.fields);
			await this.applyFactions(file.basename);
			// A new event born straight into a Decision Point that already has a
			// Happened sibling should show Locked immediately, not just on the
			// next unrelated GM edit.
			if (this.type === 'event' && this.fields.decisionPoint) {
				await waitForMetadataSync(this.app, file);
				await recomputeEventLocks(this.app, this.plugin.indexer, this.project.root);
			}
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
			new Notice(t('project.createEntity.createNoteFailed'));
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
			const roleIsDefault = m.role === '' || m.role.toLowerCase() === defaultMemberRole().toLowerCase();
			let entry: unknown = charLink;
			if (!roleIsDefault || m.location !== '') {
				const o: Record<string, unknown> = { character: charLink };
				if (!roleIsDefault) o.role = m.role;
				if (m.location !== '') o.location = `[[${m.location}]]`;
				entry = o;
			}
			await this.plugin.app.fileManager.processFrontMatter(factionFile, (fm: Record<string, unknown>) =>
				appendLoomList(fm, FM.members, entry)
			);
		}
	}

	/** Pins an existing entity to `session` via a session note (skips if it's
	 *  already there), then closes — the session-page hub picks it up. */
	private async pinExisting(entity: EntityRecord, session: EntityRecord | null): Promise<void> {
		const f = this.plugin.app.vault.getFileByPath(entity.path);
		if (!f) return;
		// No session in context (opened from the plain entity list, not a
		// session page) — nothing to pin, just open what already exists
		// instead of creating a same-named duplicate.
		if (session === null) {
			this.close();
			if (this.options.onCreated) this.options.onCreated(f);
			return;
		}
		const already = entity.sessionNotes.some(
			(n) => n.session !== null && this.plugin.indexer.resolve(n.session, entity.path)?.path === session.path
		);
		if (already) {
			new Notice(t('project.createEntity.alreadyInSession', { name: entity.name }));
			this.close();
			return;
		}
		try {
			// This session note carries whatever was picked in the modal — an
			// existing event's involved list is per-session-note, so the same
			// event can involve different entities in different sessions.
			const note = newNoteEntry(`[[${linkTargetOf(session)}]]`);
			const links = (names?: string[]) => (names ?? []).map((n) => `[[${n}]]`);
			if ((this.fields.involved ?? []).length > 0) note.involved = links(this.fields.involved);
			if ((this.fields.group ?? []).length > 0) note.group = links(this.fields.group);
			if ((this.fields.places ?? []).length > 0) note.places = links(this.fields.places);
			await this.plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) =>
				appendLoomList(fm, FM.sessionNotes, note)
			);
			this.close();
			if (this.options.onCreated) this.options.onCreated(f);
		} catch (e) {
			console.error('Loom Loom: failed to pin existing entity', e);
			new Notice(t('project.createEntity.addToSessionFailed'));
		}
	}

	/**
	 * Scene creation: a heading row (INT./EXT., Location, Sublocation, Time —
	 * the same four parts the Scene page's own modular heading editor writes),
	 * an Act picker (mandatory — a scene with no act has nowhere to live
	 * in the script), and a Notes field. Submitting inserts the scene into the
	 * script under the chosen act and stamps the note's fields directly
	 * (mirroring what `syncScenes` would do on its next pass) rather than
	 * waiting for that pass, so the new page can be opened immediately.
	 */
	private renderSceneModal(): void {
		this.setTitle(t('project.createEntity.newSceneTitle'));
		// The heading row alone (a dropdown + three text fields) is wider than
		// Obsidian's default modal — without this it clips at the edge.
		this.modalEl.addClass('loom-modal-scene');
		let intExt = 'INT.';
		let mainLoc = '';
		let subLoc = '';
		let timeOfDay = '';
		let pickedAct: EntityRecord | null = this.options.defaultAct ?? null;
		let sceneAppendToEnd = true;
		let notes = '';
		// Reassigned once the position picker is built further down — declared
		// (and callable) up front so the Act picker's earlier pick/clear
		// callbacks can refresh it without caring about source order.
		let refreshSceneOrderItems: () => void = () => {};

		const headingSetting = new Setting(this.contentEl).setName(t('project.createEntity.sceneHeadingLabel'));
		headingSetting.setClass('loom-modal-scene-heading');
		headingSetting.addDropdown((dd) => {
			// Fountain scene-heading prefixes — literal document syntax written
			// into the .fountain file, never translated (see fountain.ts).
			for (const opt of ['INT.', 'EXT.', 'INT./EXT.', 'EST.']) dd.addOption(opt, opt);
			dd.setValue(intExt).onChange((v) => (intExt = v));
		});
		headingSetting.addText((text) => {
			text.setPlaceholder(entityLabel('location')).onChange((v) => (mainLoc = v));
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
			text.setPlaceholder(t('project.createEntity.sublocationOptional')).onChange((v) => (subLoc = v));
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
			text.setPlaceholder(t('project.createEntity.timePlaceholder')).onChange((v) => (timeOfDay = v));
		});

		const actType = projectRoleType(this.project.config, 'anchor');
		const actSetting = new Setting(this.contentEl)
			.setName(entityLabel(actType))
			.setDesc(t('project.createEntity.actDesc', { anchor: entityLabel(actType).toLowerCase() }));
		const actEl = actSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
		const refreshAct = () => {
			actEl.empty();
			if (pickedAct) {
				renderChipEl(this.plugin, actEl, pickedAct, pickedAct.name, () => {
					pickedAct = null;
					refreshAct();
					refreshSceneOrderItems();
				});
				return;
			}
			const input = actEl.createEl('input', {
				type: 'text',
				attr: { placeholder: t('project.createEntity.pickAnchor', { anchor: entityLabel(actType).toLowerCase() }) },
			});
			new RecordInputSuggest(
				this.app,
				input,
				() => [
					newActStub(this.project.root),
					...this.plugin.indexer
						.getAll('act', this.project.root)
						.sort(bySeq),
				],
				(r) => {
					if (r.path === NEW_ACT_SENTINEL) {
						new CreateEntityModal(this.plugin, 'act', this.project, {
							onActCreated: (record) => {
								pickedAct = record;
								refreshAct();
								refreshSceneOrderItems();
							},
						}).open();
						return;
					}
					pickedAct = r;
					refreshAct();
					refreshSceneOrderItems();
				},
				(r) => r.name
			);
		};
		refreshAct();

		const sceneOrderPicker = this.appendOrOrder(t('project.createEntity.appendToEndAct.name'), t('project.createEntity.appendToEndAct.desc'), t('project.createEntity.newSceneTitle'), (v) => (sceneAppendToEnd = v));
		refreshSceneOrderItems = () => {
			const actScenes = pickedAct
				? this.plugin.indexer.membersOfAct(pickedAct, 'scene').sort(bySeq)
				: [];
			sceneOrderPicker.setItems(actScenes.map((sc) => sc.name));
		};
		refreshSceneOrderItems();

		this.notesField((v) => (notes = v));

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText(t('project.createEntity.createButton'))
				.setCta()
				.onClick(() =>
					void this.submitScene({
						intExt,
						mainLoc,
						subLoc,
						timeOfDay,
						pickedAct,
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
		pickedAct: EntityRecord | null;
		sceneAppendToEnd: boolean;
		insertIndex: number;
		notes: string;
	}): Promise<void> {
		const mainLoc = fields.mainLoc.trim();
		if (mainLoc === '') {
			new Notice(t('project.createEntity.locationRequired'));
			return;
		}
		if (!fields.pickedAct) {
			new Notice(
				t('project.createEntity.anchorRequiredNotice', {
					anchor: entityLabel(projectRoleType(this.project.config, 'anchor')),
				})
			);
			return;
		}
		const act = fields.pickedAct;
		// Read before the script write below — the same query the position
		// picker's list was built from, so its index lines up with this order.
		const existingSceneIds =
			act.actId !== ''
				? this.plugin.indexer.membersOfAct(act, 'scene').sort(bySeq)
						.map((sc) => sc.sceneId)
				: [];

		let newId: string | null = null;
		let nextText: string | null = null;
		await ensureScriptBufferLoaded(this.plugin, this.project);
		const applied = mutateScriptBuffer(this.plugin, this.project, (raw) => {
			let t = appendScene(raw, mainLoc);
			const parsed = parseFountain(t);
			const created = parsed.scenes[parsed.scenes.length - 1];
			newId = created?.loomId ?? null;
			if (!newId) return t;
			if (act.actId !== '') {
				t = moveSceneToSection(t, newId, act.actId) ?? t;
				if (!fields.sceneAppendToEnd) {
					const order = [...existingSceneIds];
					const clamped = Math.max(0, Math.min(fields.insertIndex, order.length));
					order.splice(clamped, 0, newId);
					t = reorderScenesInSection(t, act.actId, order) ?? t;
				}
			}
			t =
				setSceneHeadingParts(t, newId, {
					intExt: fields.intExt.trim() === '' ? 'INT.' : fields.intExt.trim(),
					location: joinLocationSub(mainLoc, fields.subLoc),
					timeOfDay: fields.timeOfDay.trim(),
				}) ?? t;
			nextText = t;
			return t;
		});
		if (!applied || nextText === null || !newId) {
			new Notice(t('project.createEntity.sceneWriteFailed'));
			return;
		}

		const location = await this.resolveModalLocation(mainLoc, fields.subLoc);
		const scene = parseFountain(nextText).scenes.find((sc) => sc.loomId === newId);
		if (!scene) {
			new Notice(t('project.createEntity.sceneCreateFailed'));
			return;
		}
		const place = scene.location.trim() === '' ? t('project.createEntity.untitledScene') : scene.location.trim();
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
				setLoomKey(fm, FM.sceneAct, `[[${linkTargetOf(act)}]]`);
				setLoomKey(fm, FM.sceneBranch, scene.branchLoomId ?? '');
				setLoomKey(fm, FM.seq, scene.index);
			});
			await writeNotesBody(this.plugin, created, fields.notes);
			// The note already carries `newId` at this point, so `syncScenes`
			// (run inside this flush's own post-flush hook) matches it by id
			// and updates it in place rather than creating a duplicate — this
			// is what derives the note's cast/factions/mentioned-locations
			// immediately, instead of leaving them stale until some later,
			// unrelated script edit happens to trigger a sync.
			await flushScriptBufferNow(this.plugin, this.project);
			this.finishCreate(created);
		} catch (e) {
			console.error('Loom Loom: failed to create the scene', e);
			new Notice(t('project.createEntity.createNoteFailed'));
		}
	}

	/** Resolves a scene heading's main/sublocation text to Location entities,
	 *  creating whichever doesn't exist yet — mirrors `resolveSceneLocation` in
	 *  script-view.tsx's `syncScenes` (duplicated for the same import-cycle
	 *  reason as `editBookFile` above), so a name typed fresh here connects
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
		if (subName.trim() === '') return mainRecord;
		return findOrCreateSublocation(this.plugin, this.project, mainRecord, subName);
	}

	/** "Append to the end" toggle (default on); turning it off reveals an order
	 *  picker with the new entry as its draggable `phantomLabel` row. */
	private appendOrOrder(name: string, desc: string, phantomLabel: string, onAppend: (append: boolean) => void) {
		new Setting(this.contentEl)
			.setName(name)
			.setDesc(desc)
			.addToggle((tg) =>
				tg.setValue(true).onChange((v) => {
					onAppend(v);
					orderWrap.classList.toggle('loom-modal-order-wrap-hidden', v);
				})
			);
		const orderWrap = this.contentEl.createDiv({ cls: 'loom-modal-order-wrap loom-modal-order-wrap-hidden' });
		const picker = this.buildOrderPicker(orderWrap);
		picker.setPhantomLabel(phantomLabel);
		return picker;
	}

	/** The structural modals' Notes field (written as the note's body). */
	private notesField(onChange: (notes: string) => void): void {
		new Setting(this.contentEl)
			.setName(t('project.notes'))
			.addTextArea((text) => text.onChange((v) => onChange(v.trim())))
			.setClass('loom-modal-wide');
	}

	/**
	 * Builds the "where does the new one land" position picker shared by the
	 * Scene and Act creation modals: existing items render ONCE as static,
	 * non-draggable rows in normal document flow (their own order never
	 * changes); the new/unsaved item is the ONE draggable row, taken out of
	 * flow (absolute) so the statics never reflow around it, starting at slot 0
	 * ("sits first", easiest to find). Dragging uses a fixed row-height slot
	 * (`SLOT`, matches the CSS exactly) rather than measuring the DOM — the
	 * grabbed row rides the raw cursor delta with no transition, static rows
	 * slide a whole slot with one via `transform`, same "slide to reorder" feel
	 * as the Sublocation/Outline drag lists elsewhere in the app.
	 * `setItems` lets the Scene modal rebuild the list when its Act pick
	 * changes (a different act means a different set of existing scenes to
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
	 * Act creation, Script and Prose alike: Title (→ the `#` heading), Display
	 * title (Script only — the centered `>**…**<` marker under the section,
	 * `applyDisplayTitles`; Prose prints no such line), where to insert it
	 * (append, or drag among the existing acts), and Notes. Writes the script
	 * or book FIRST and stamps the note from what that write produced.
	 */
	private renderActModal(): void {
		const prose = this.project.config.writerMode === 'prose';
		this.setTitle(t('project.createEntity.newActTitle'));
		let title = '';
		let displayTitle = '';
		let appendToEnd = true;
		let notes = '';
		const existingActs = this.plugin.indexer
			.getAll('act', this.project.root)
			.sort(bySeq);

		let displayTitleInput: TextComponent | null = null;
		new Setting(this.contentEl).setName(t('project.createEntity.titleLabel')).addText((text) => {
			text.setPlaceholder(t('project.createEntity.newActTitle'));
			text.onChange((v) => {
				title = v;
				orderPicker.setPhantomLabel(v.trim() === '' ? t('project.createEntity.newActTitle') : v.trim());
				// Mirrors what an empty Display title will actually resolve to
				// (`applyDisplayTitles` falls back to the Title) rather than a
				// generic hint.
				displayTitleInput?.setPlaceholder(v.trim());
			});
			window.setTimeout(() => text.inputEl.focus());
		});
		if (!prose) {
			new Setting(this.contentEl)
				.setName(t('project.createEntity.displayTitle.name'))
				.setDesc(t('project.createEntity.displayTitle.desc'))
				.addText((text) => {
					displayTitleInput = text;
					text.onChange((v) => (displayTitle = v));
				});
		}

		const orderPicker = prose
			? this.appendOrOrder(t('project.createEntity.appendToEndBook.name'), t('project.createEntity.appendToEndBook.desc'), t('project.createEntity.newActTitle'), (v) => (appendToEnd = v))
			: this.appendOrOrder(t('project.createEntity.appendToEndScript.name'), t('project.createEntity.appendToEndScript.desc'), t('project.createEntity.newActTitle'), (v) => (appendToEnd = v));
		orderPicker.setItems(existingActs.map((c) => c.name));

		this.notesField((v) => (notes = v));

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText(t('project.createEntity.createButton'))
				.setCta()
				.onClick(() =>
					void this.submitAct({
						title,
						displayTitle: prose ? '' : displayTitle,
						appendToEnd,
						insertIndex: orderPicker.getIndex(),
						existingActs,
						notes,
					})
				)
		);
	}

	private async submitAct(fields: {
		title: string;
		displayTitle: string;
		appendToEnd: boolean;
		insertIndex: number;
		existingActs: EntityRecord[];
		notes: string;
	}): Promise<void> {
		const title = fields.title.trim();
		if (title === '') {
			new Notice(t('project.createEntity.titleRequired'));
			return;
		}
		const displayTitle = fields.displayTitle.trim();
		const prose = this.project.config.writerMode === 'prose';
		/** Act ids in document order — the new act is the last one appended. */
		const actIds = (text: string): string[] =>
			prose
				? parseBook(text).acts.filter((a) => a.loomId !== null).sort((a, b) => a.line - b.line).map((a) => a.loomId as string)
				: parseFountain(text)
						.sections.filter((sec) => sec.level === 1 && sec.loomId !== null)
						.sort((a, b) => a.line - b.line)
						.map((sec) => sec.loomId as string);

		let newId: string | null = null;
		const place = (raw: string): string => {
			let text = prose ? appendBookAct(raw, title) : appendAct(raw, title);
			const ids = actIds(text);
			newId = ids[ids.length - 1] ?? null;
			if (!newId) return text;
			if (!fields.appendToEnd) {
				const order = fields.existingActs.map((c) => c.actId);
				const clamped = Math.max(0, Math.min(fields.insertIndex, order.length));
				order.splice(clamped, 0, newId);
				text = (prose ? reorderBookActs(text, order) : reorderTopSections(text, order)) ?? text;
			}
			if (displayTitle !== '') text = applyDisplayTitles(text, new Map([[newId, displayTitle]]));
			return text;
		};
		let nextText: string | null = null;
		if (prose) {
			nextText = await editBookFile(this.plugin, this.project, place);
		} else {
			await ensureScriptBufferLoaded(this.plugin, this.project);
			const applied = mutateScriptBuffer(this.plugin, this.project, (raw) => (nextText = place(raw)));
			if (!applied) nextText = null;
		}
		if (nextText === null || !newId) {
			new Notice(t('project.createEntity.actWriteFailed'));
			return;
		}
		const actId: string = newId;
		const seq = actIds(nextText).indexOf(actId) + 1;

		try {
			const created = await createEntity(this.plugin, this.project, 'act', {
				name: title,
				tag: '',
				date: '',
				description: '',
			});
			await this.plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.actId, actId);
				setLoomKey(fm, FM.seq, seq);
				if (displayTitle !== '') setLoomKey(fm, FM.displayTitle, displayTitle);
			});
			await writeNotesBody(this.plugin, created, fields.notes);
			const record: EntityRecord = {
				...pcGroupStub(this.project.root),
				path: created.path,
				name: title,
				type: 'act',
				actId,
				seq,
				displayTitle,
			};
			// Same reasoning as `submitScene`'s own flush — the note already
			// carries the id, so `syncScenes` (this flush's post-flush hook)
			// matches and updates it rather than creating a duplicate.
			if (!prose) await flushScriptBufferNow(this.plugin, this.project);
			this.finishCreate(created, record);
		} catch (e) {
			console.error('Loom Loom: failed to create the act', e);
			new Notice(t('project.createEntity.createNoteFailed'));
		}
	}

	/**
	 * Chapter creation (Writer/Prose): Title, a mandatory Act picker (same
	 * search-with-"+ New act" widget the Scene modal's own Act picker uses),
	 * where to insert it — append to the end (default) or drag it to a
	 * specific spot among the picked act's existing chapters, same
	 * `buildOrderPicker` the Act modal uses — and a Notes field. No Involved/
	 * Locations/Date/Description fields: prose has no `@[...]`-style inline
	 * entity-link derivation yet (a Fountain-only feature so far), so there's
	 * nothing to hand-pick at creation time either way. Writes the Book file
	 * first (`editBookFile`/`appendBookChapter`/`moveBookChapterToAct`/
	 * `reorderBookChaptersInAct`) and stamps the note from what that write
	 * actually produced — mirrors `submitScene`.
	 */
	private renderChapterModal(): void {
		this.setTitle(newEntityTitle('chapter'));
		let name = '';
		let pickedAct: EntityRecord | null = this.options.defaultAct ?? null;
		let chapterAppendToEnd = true;
		let notes = '';
		// Reassigned once the position picker is built further down — same
		// forward-declaration reason `refreshSceneOrderItems` has in the Scene
		// modal (the Act picker's pick/clear callbacks need to refresh it).
		let refreshChapterOrderItems: () => void = () => {};

		new Setting(this.contentEl).setName(t('project.createEntity.titleLabel')).addText((text) => {
			text.setPlaceholder(newEntityTitle('chapter'));
			text.onChange((v) => {
				name = v;
				chapterOrderPicker.setPhantomLabel(v.trim() === '' ? newEntityTitle('chapter') : v.trim());
			});
			window.setTimeout(() => text.inputEl.focus());
		});

		const actType = projectRoleType(this.project.config, 'anchor');
		const actSetting = new Setting(this.contentEl)
			.setName(entityLabel(actType))
			.setDesc(t('project.createEntity.chapterActDesc', { anchor: entityLabel(actType).toLowerCase() }));
		const actEl = actSetting.controlEl.createDiv({ cls: 'loom-modal-pick' });
		const refreshAct = () => {
			actEl.empty();
			if (pickedAct) {
				renderChipEl(this.plugin, actEl, pickedAct, pickedAct.name, () => {
					pickedAct = null;
					refreshAct();
					refreshChapterOrderItems();
				});
				return;
			}
			const input = actEl.createEl('input', {
				type: 'text',
				attr: { placeholder: t('project.createEntity.pickAnchor', { anchor: entityLabel(actType).toLowerCase() }) },
			});
			new RecordInputSuggest(
				this.app,
				input,
				() => [
					newActStub(this.project.root),
					...this.plugin.indexer
						.getAll('act', this.project.root)
						.sort(bySeq),
				],
				(r) => {
					if (r.path === NEW_ACT_SENTINEL) {
						new CreateEntityModal(this.plugin, 'act', this.project, {
							onActCreated: (record) => {
								pickedAct = record;
								refreshAct();
								refreshChapterOrderItems();
							},
						}).open();
						return;
					}
					pickedAct = r;
					refreshAct();
					refreshChapterOrderItems();
				},
				(r) => r.name
			);
		};
		refreshAct();

		const chapterOrderPicker = this.appendOrOrder(t('project.createEntity.appendToEndActChapter.name'), t('project.createEntity.appendToEndActChapter.desc'), newEntityTitle('chapter'), (v) => (chapterAppendToEnd = v));
		refreshChapterOrderItems = () => {
			const actChapters = pickedAct
				? this.plugin.indexer.membersOfAct(pickedAct, 'chapter').sort(bySeq)
				: [];
			chapterOrderPicker.setItems(actChapters.map((ch) => ch.name));
		};
		refreshChapterOrderItems();

		this.notesField((v) => (notes = v));

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText(t('project.createEntity.createButton'))
				.setCta()
				.onClick(() =>
					void this.submitChapter({
						name,
						pickedAct,
						chapterAppendToEnd,
						insertIndex: chapterOrderPicker.getIndex(),
						notes,
					})
				)
		);
	}

	private async submitChapter(fields: {
		name: string;
		pickedAct: EntityRecord | null;
		chapterAppendToEnd: boolean;
		insertIndex: number;
		notes: string;
	}): Promise<void> {
		const name = fields.name.trim();
		if (name === '') {
			new Notice(t('project.createEntity.titleRequired'));
			return;
		}
		if (!fields.pickedAct) {
			new Notice(
				t('project.createEntity.anchorRequiredNotice', {
					anchor: entityLabel(projectRoleType(this.project.config, 'anchor')),
				})
			);
			return;
		}
		const act = fields.pickedAct;
		// Read before the Book write below — the same query the position
		// picker's list was built from, so its index lines up with this order.
		const existingChapterIds =
			act.actId !== ''
				? this.plugin.indexer.membersOfAct(act, 'chapter').sort(bySeq)
						.map((ch) => ch.chapterId)
				: [];

		let newId: string | null = null;
		const nextText = await editBookFile(this.plugin, this.project, (raw) => {
			let text = appendBookChapter(raw, name);
			const parsed = parseBook(text);
			const created = parsed.chapters[parsed.chapters.length - 1];
			newId = created?.loomId ?? null;
			if (!newId) return text;
			if (act.actId !== '') {
				text = moveBookChapterToAct(text, newId, act.actId) ?? text;
				if (!fields.chapterAppendToEnd) {
					const order = [...existingChapterIds];
					const clamped = Math.max(0, Math.min(fields.insertIndex, order.length));
					order.splice(clamped, 0, newId);
					text = reorderBookChaptersInAct(text, act.actId, order) ?? text;
				}
			}
			return text;
		});
		if (!newId) {
			new Notice(t('project.createEntity.actWriteFailed'));
			return;
		}
		const chapters = parseBook(nextText)
			.chapters.filter((c) => c.loomId !== null)
			.sort((a, b) => a.line - b.line);
		const seq = chapters.findIndex((c) => c.loomId === newId) + 1;

		try {
			const created = await createEntity(this.plugin, this.project, 'chapter', {
				name,
				tag: '',
				date: '',
				description: '',
			});
			await this.plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.chapterId, newId);
				setLoomKey(fm, FM.chapterAct, `[[${linkTargetOf(act)}]]`);
				setLoomKey(fm, FM.seq, seq);
			});
			await writeNotesBody(this.plugin, created, fields.notes);
			this.finishCreate(created);
		} catch (e) {
			console.error('Loom Loom: failed to create the chapter', e);
			new Notice(t('project.createEntity.createNoteFailed'));
		}
	}

	onClose(): void {
		for (const ref of this.indexRefs) this.plugin.indexer.events.offref(ref);
		this.indexRefs = [];
		this.contentEl.empty();
	}
}

/**
 * Folder suggestions attached to a plain text input: typing searches existing
 * vault folders, but any path (including one that doesn't exist yet) stays
 * typeable — unlike a pick-only fuzzy modal.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private input: HTMLInputElement) {
		super(app, input);
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
	private name = '';
	private kind: ProjectKind = DEFAULT_PROJECT_KIND;
	/** Writer only: Fountain script vs. prose — mutually exclusive per project
	 *  (see project-kind.ts's `WriterMode` doc comment). Ignored for every
	 *  other kind. */
	private writerMode: WriterMode = DEFAULT_WRITER_MODE;

	constructor(private plugin: LoomLoomPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle(t('project.setup.title'));
		// Anchored to the top instead of Obsidian's vertical centering: the
		// modal's height changes with the picked kind (Writer adds its pills),
		// and centering would move its top edge on every switch.
		this.containerEl.addClass('loom-setup-modal-container');
		this.render();
	}

	private render(): void {
		this.contentEl.empty();

		new Setting(this.contentEl)
			.setName(t('project.setup.projectName'))
			.addText((text) => {
				text.setPlaceholder(t('project.setup.projectNamePlaceholder'))
					.setValue(this.name)
					.onChange((v) => (this.name = v.trim()));
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') void this.submit();
				});
				window.setTimeout(() => text.inputEl.focus());
			});

		// The kind decides which entity types the project holds, so it is
		// picked up front — fixed at creation, not something you switch later.
		new Setting(this.contentEl)
			.setName(t('project.setup.projectType'))
			.setDesc(projectKindDescription(this.kind))
			.addDropdown((dd) => {
				for (const kind of PROJECT_KINDS) dd.addOption(kind, projectKindLabel(kind));
				dd.setValue(this.kind).onChange((v) => {
					this.kind = v as ProjectKind;
					this.render();
				});
				// The current kind's icon, same one used everywhere else this app
				// shows a kind (the Projects settings table's Type column) — placed
				// before the `<select>` so it reads left-to-right as "this kind's
				// dropdown", and re-created fresh on every `render()` call (which
				// already fires on every kind change), so it stays in sync for free
				// with no separate update wiring.
				const icon = createSpan({ cls: 'loom-setup-kind-icon' });
				setIcon(icon, PROJECT_KIND_META[this.kind].icon);
				dd.selectEl.before(icon);
				// Fixed width for the longest option ("Game Master") as an inline
				// style (see settings.ts `renderFixedWidthDropdown` for why).
				dd.selectEl.setCssProps({ width: '17ch' });
			});

		// Writer's own sub-mode pick — mutually exclusive (never both in one
		// project, see project-kind.ts), so a `.loom-seg` pill pair same as the
		// Create/Use pills above rather than a second dropdown.
		if (this.kind === 'writer') {
			const modePills = this.contentEl.createDiv({ cls: 'loom-seg loom-setup-mode-pills' });
			const modePill = (mode: WriterMode, label: string) => {
				const btn = modePills.createEl('button', {
					cls: 'loom-seg-btn' + (this.writerMode === mode ? ' loom-seg-on' : ''),
					text: label,
				});
				btn.addEventListener('click', () => {
					this.writerMode = mode;
					this.render();
				});
			};
			modePill('script', t('project.setup.pillScript'));
			modePill('prose', t('project.setup.pillProse'));
		}

		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: t('project.setup.holds', {
				list: typesFor(this.kind, this.writerMode)
					.map((et) => entityPlural(et))
					.join(', '),
			}),
		});

		// Freemium gate: one project of each kind is free with every feature;
		// a license key unlocks unlimited projects. Gates NEW creation only —
		// existing projects are never blocked. See src/license/gating.ts.
		const blocked = !canCreateProjectOfKind(
			this.plugin.licenseManager.getTier(),
			this.plugin.indexer.getProjects(),
			this.kind
		);
		if (blocked) {
			// Its own `Setting` row (no name, no control) purely so it picks up
			// the same native top-border separator every other row in this modal
			// already has — without it, this read as though it belonged to the
			// "Project type" row right above rather than its own distinct notice.
			new Setting(this.contentEl).setDesc(
				createFragment((frag) => {
					const box = frag.createDiv({ cls: 'loom-setup-warning' });
					box.createDiv({
						text: t('project.setup.alreadyFreeTier', { kind: projectKindLabel(this.kind).toLowerCase() }),
					});
					box.createDiv({ text: t('project.setup.licenseUnlocks') });
					box.createDiv({ text: t('project.setup.seeSettings') });
				})
			);
		}

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText(t('project.setup.createProjectButton'))
				.setCta()
				.setDisabled(blocked)
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		const name = sanitizeFileName(this.name);
		if (name === '') {
			new Notice(t('project.setup.projectNameRequired'));
			return;
		}
		const root = projectFolderPath(this.plugin.settings.loomRoot, this.kind, name);
		if (this.app.vault.getAbstractFileByPath(root)) {
			new Notice(t('project.setup.projectExists'));
			return;
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
			new Notice(t('project.setup.alreadyFreeTierNotice'));
			return;
		}
		try {
			const loomFile = await scaffoldProject(this.app, root, this.kind, this.writerMode);
			this.plugin.indexer.rebuild();
			this.close();
			new Notice(t('project.setup.projectReady'));
			await this.app.workspace.getLeaf('tab').openFile(loomFile);
		} catch (e) {
			console.error('Loom Loom: failed to scaffold project', e);
			new Notice(t('project.setup.setupFailed'));
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
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private detail: string,
		private onConfirm: () => void | Promise<void>,
		private confirmText = t('project.confirm.continueDefault'),
		/** An optional switch shown above the buttons; `value` is updated in
		 *  place, so `onConfirm` reads the user's choice from the same object. */
		private option?: { label: string; value: boolean }
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		// pre-line so a multi-paragraph detail (e.g. the script-import warning,
		// which has to spell out what is and isn't destroyed) keeps its breaks.
		this.contentEl.createEl('p', { cls: 'loom-confirm-detail', text: this.detail });
		const option = this.option;
		if (option) {
			new Setting(this.contentEl)
				.setName(option.label)
				.addToggle((tg) => tg.setValue(option.value).onChange((v) => (option.value = v)));
		}
		new Setting(this.contentEl)
			.addButton((btn) => btn.setButtonText(t('project.common.cancel')).onClick(() => this.close()))
			.addButton((btn) => {
				// mod-warning by class: setWarning() is deprecated and its
				// replacement (setDestructive) is 1.13/Catalyst-only.
				btn.setButtonText(this.confirmText).onClick(() => {
					// Obsidian's own `Modal.close()` calls `onClose()`
					// synchronously on desktop, so a caller wrapping this in a
					// Promise that reads a flag from inside `onClose` (see
					// `confirmDialog`, entity-view.tsx) only ever sees that
					// flag's value as of THIS point — `onConfirm` has to run
					// before `close()`, not after, or the flag it sets always
					// arrives one tick too late to be read.
					void this.onConfirm();
					this.close();
				});
				btn.buttonEl.addClass('mod-warning');
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * GM projects: a Decision Point and an event about to join it each already
 * have a DIFFERENT session — asks which one wins rather than silently
 * picking a side (see `reconcileSessionBeforeLink`, gm-decision-point.ts).
 * "Use the Decision Point's session" only touches this one event; "Use the
 * event's session" cascades onto the Decision Point AND every one of its
 * OTHER member events too, same as any other Decision-Point session change —
 * both buttons close the modal and resolve the promise the caller awaits,
 * "Cancel" resolves it `false` (the whole link action is abandoned, not just
 * the session choice).
 */
export class SessionConflictModal extends Modal {
	private resolve!: (linked: boolean) => void;

	constructor(
		app: App,
		private conflict: SessionConflict,
		private plugin: LoomLoomPlugin,
		private project: ProjectDef
	) {
		super(app);
	}

	/** `Modal.open()` itself stays void-returning (its own base signature —
	 *  overriding it to return a Promise trips
	 *  `@typescript-eslint/no-misused-promises` for any caller that only
	 *  knows it as a plain `Modal`), so this is a separate method: opens the
	 *  modal and resolves once a choice is made — `true` for either
	 *  session-reconciling button, `false` for Cancel. */
	openAndWait(): Promise<boolean> {
		this.open();
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		const { dp, event, dpSession, eventSession } = this.conflict;
		const dpLabel = recordPickLabel(this.plugin, this.project, dpSession);
		const eventLabel = recordPickLabel(this.plugin, this.project, eventSession);
		this.setTitle(t('project.sessionConflict.title'));
		this.contentEl.createEl('p', {
			cls: 'loom-confirm-detail',
			text: t('project.sessionConflict.detail', { dp: dp.name, dpSession: dpLabel, event: event.name, eventSession: eventLabel }),
		});
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText(t('project.common.cancel')).onClick(() => {
					this.close();
					this.resolve(false);
				})
			)
			.addButton((btn) =>
				btn.setButtonText(t('project.sessionConflict.useEventSession', { label: eventLabel })).onClick(() => {
					this.close();
					void cascadeDecisionPointSession(this.app, this.plugin.indexer, dp, linkTargetOf(eventSession)).then(() =>
						this.resolve(true)
					);
				})
			)
			.addButton((btn) => {
				btn.setButtonText(t('project.sessionConflict.useDpSession', { label: dpLabel })).onClick(() => {
					this.close();
					void setEventSession(this.app, event, linkTargetOf(dpSession)).then(() => this.resolve(true));
				});
				btn.buttonEl.addClass('mod-cta');
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
		private project?: ProjectDef,
		/** Types to drop from the list regardless of the above — for a
		 *  caller whose `onPick` auto-links the freshly created entity into
		 *  a specific list (Involved, a Relationship target, …) where a
		 *  grouping-only type like Decision Point would never belong. Every
		 *  OTHER caller (the command palette, entity-list "+ New", the `[[`
		 *  create-link flow) leaves this unset — Decision Point stays
		 *  reachable there, same as Region already is. */
		private excludeTypes?: readonly EntityType[]
	) {
		super(plugin.app);
		this.setPlaceholder(t('project.pickEntityType'));
	}

	getItems(): EntityType[] {
		const types = this.project ? [...projectTypes(this.project.config)] : [...ENTITY_TYPES];
		return this.excludeTypes ? types.filter((t) => !this.excludeTypes?.includes(t)) : types;
	}

	getItemText(type: EntityType): string {
		return entityLabel(type);
	}

	onChooseItem(type: EntityType): void {
		this.onPick(type);
	}
}

export class ProjectSuggestModal extends FuzzySuggestModal<ProjectDef> {
	constructor(private plugin: LoomLoomPlugin, private onPick: (project: ProjectDef) => void) {
		super(plugin.app);
		this.setPlaceholder(t('project.pickProject'));
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
