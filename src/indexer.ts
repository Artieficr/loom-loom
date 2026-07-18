import {
	App,
	Component,
	Events,
	FrontMatterCache,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	debounce,
	normalizePath,
} from 'obsidian';
import {
	Connection,
	DEFAULT_MEMBER_ROLE,
	EntityRecord,
	EntityType,
	FM,
	FactionMemberDecl,
	LOOM_EXTENSION,
	QUEST_OUTCOMES,
	RelationshipDecl,
	SessionNoteDecl,
	TIMELINES_FOLDER,
	TimelineDef,
	isEntityType,
	legacyFmKeys,
} from './types';
import { ProjectConfig, parseLoomDate, parseProjectConfig } from './calendar';
import { managedEntityFileName } from './naming';
import type LoomLoomPlugin from './main';

/** A project = a folder containing a .loom home file. */
export interface ProjectDef {
	/** Path of the .loom file. */
	loomPath: string;
	/** Root folder path ('' = vault root). */
	root: string;
	/** Project display name = .loom file basename. */
	name: string;
	config: ProjectConfig;
}

/**
 * Extracts the linkpath from a raw target value: "[[Sam|alias]]" -> "Sam".
 * Plain names without brackets are accepted as-is.
 */
export function extractLinkpath(raw: string): string | null {
	const wiki = /\[\[([^\]|#]+)/.exec(raw);
	const path = (wiki ? wiki[1] : raw).trim();
	return path.length > 0 ? path : null;
}

function parseTagList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * Extracts the character linkpath from one raw `members` entry — a plain link
 * string ("[[Sam]]") or an object `{ character, role }`. Shared with the
 * entity page, which edits the faction's raw frontmatter list in place.
 */
export function memberEntryLinkpath(item: unknown): string | null {
	if (typeof item === 'string' && item !== '') return extractLinkpath(item);
	if (typeof item === 'object' && item !== null) {
		const character = (item as { character?: unknown }).character;
		if (typeof character === 'string' && character !== '') return extractLinkpath(character);
	}
	return null;
}

/** Parses a faction's `members` list into deduplicated membership declarations. */
function parseMemberList(value: unknown): FactionMemberDecl[] {
	const raw = Array.isArray(value) ? value : [value];
	const out: FactionMemberDecl[] = [];
	for (const item of raw) {
		const linkpath = memberEntryLinkpath(item);
		if (!linkpath || out.some((m) => m.linkpath === linkpath)) continue;
		const { role, location } =
			typeof item === 'object' && item !== null
				? (item as { role?: unknown; location?: unknown })
				: { role: undefined, location: undefined };
		out.push({
			linkpath,
			role: typeof role === 'string' && role.trim() !== '' ? role : DEFAULT_MEMBER_ROLE,
			location: typeof location === 'string' ? extractLinkpath(location) : null,
		});
	}
	return out;
}

/** Parses a frontmatter value holding one link or a list of links into deduplicated linkpaths. */
function parseLinkList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [value];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== 'string' || item === '') continue;
		const linkpath = extractLinkpath(item);
		if (linkpath && !out.includes(linkpath)) out.push(linkpath);
	}
	return out;
}

/**
 * Frontmatter keys whose links are deliberately hidden: they never become
 * connections or graph edges (session attendance would spray edges over the
 * whole graph; sublocationOrder would duplicate the children's own
 * `sublocation` edges). Lowercase — compared case-insensitively; legacy
 * un-prefixed spellings included for not-yet-migrated notes.
 */
const HIDDEN_LINK_KEYS = [
	'loomattendance',
	'loomdeathsession',
	'loomsublocationorder',
	'attendance',
	'deathsession',
	'sublocationorder',
];

function isHiddenLinkKey(key: string): boolean {
	const lower = key.toLowerCase();
	// List entries come through as "attendance.0", "attendance.1", …
	return HIDDEN_LINK_KEYS.some((k) => lower === k || lower.startsWith(k + '.'));
}

/**
 * Case-insensitive frontmatter lookup. Obsidian's Properties UI treats
 * property names case-insensitively and can rewrite a key to another casing
 * (e.g. `loomTags` → `loomtags`), so our camelCase keys must be read loosely.
 */
function fmField(fm: FrontMatterCache | Record<string, unknown>, key: string): unknown {
	if (fm[key] !== undefined) return fm[key];
	const lower = key.toLowerCase();
	for (const k of Object.keys(fm)) {
		if (k.toLowerCase() === lower) return fm[k];
	}
	return undefined;
}

/** Reads a loom frontmatter key, falling back to its legacy spelling(s). */
function fmLoom(fm: FrontMatterCache | Record<string, unknown>, key: string): unknown {
	const value = fmField(fm, key);
	if (value !== undefined) return value;
	for (const legacy of legacyFmKeys(key)) {
		const v = fmField(fm, legacy);
		if (v !== undefined) return v;
	}
	return undefined;
}

/**
 * The link target for a record: the file basename. Links resolve by file
 * name, never by display name — every plugin-written `[[link]]` must use
 * this, while UI labels use `record.name` (the user-entered `loomName`).
 */
export function linkTargetOf(record: EntityRecord): string {
	const base = record.path.split('/').pop() ?? record.path;
	return base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * The index cache: entity records built from frontmatter across all projects
 * (any folder holding a .loom file).
 *
 * Indexing has no rendering concerns — views subscribe to the `changed`
 * event and query through the public getters; they never re-scan files.
 * Records store *unresolved* linkpaths; resolution to concrete files happens
 * at query time via metadataCache, so renames/creations elsewhere in the
 * vault never leave stale resolved paths in the index.
 */
export class LoomIndexer extends Component {
	readonly events = new Events();
	version = 0;

	private projects = new Map<string, ProjectDef>();
	private records = new Map<string, EntityRecord>();
	private timelines = new Map<string, TimelineDef>();
	/** Lazily built reverse edges: target path -> incoming connections. */
	private incoming: Map<string, Connection[]> | null = null;

	private rebuilding = false;
	private rebuildQueued = false;

	constructor(private app: App, private plugin: LoomLoomPlugin) {
		super();
	}

	onload(): void {
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				if (!this.projectForPath(file.path)) return;
				this.indexFile(file);
				this.bump();
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === LOOM_EXTENSION) this.rebuild();
			})
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile && file.extension === LOOM_EXTENSION) this.rebuild();
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === LOOM_EXTENSION) {
					this.rebuild();
					return;
				}
				if (this.records.delete(file.path) || this.timelines.delete(file.path)) this.bump();
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				// Renames can retarget link resolution or move project roots,
				// so rebuild rather than patch. Renames are rare enough.
				if (
					(file instanceof TFile && file.extension === LOOM_EXTENSION) ||
					this.projectForPath(oldPath) ||
					this.projectForPath(file.path)
				) {
					this.rebuild();
				}
			})
		);
	}

	// --- Rebuild -------------------------------------------------------------

	rebuild(): void {
		if (this.rebuilding) {
			this.rebuildQueued = true;
			return;
		}
		this.rebuilding = true;
		void this.doRebuild().finally(() => {
			this.rebuilding = false;
			if (this.rebuildQueued) {
				this.rebuildQueued = false;
				this.rebuild();
			}
		});
	}

	private async doRebuild(): Promise<void> {
		const loomFiles = this.app.vault.getFiles().filter((f) => f.extension === LOOM_EXTENSION);
		const projects = new Map<string, ProjectDef>();
		for (const file of loomFiles) {
			let config = parseProjectConfig('');
			try {
				config = parseProjectConfig(await this.app.vault.cachedRead(file));
			} catch (e) {
				console.error('Loom Loom: could not read project file', file.path, e);
			}
			const parent = file.parent;
			projects.set(file.path, {
				loomPath: file.path,
				root: parent && parent.path !== '/' ? parent.path : '',
				name: file.basename,
				config,
			});
		}
		this.projects = projects;

		this.records.clear();
		this.timelines.clear();
		for (const project of projects.values()) {
			const folder =
				project.root === '' ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(project.root);
			if (!(folder instanceof TFolder)) continue;
			Vault.recurseChildren(folder, (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') this.indexFile(file);
			});
		}
		this.bump();
	}

	// --- Startup migration -----------------------------------------------------

	/**
	 * One-shot pass after the initial rebuild: rewrites legacy un-prefixed
	 * frontmatter keys to their loom spellings, seeds `loomName` (+ a native
	 * alias) from the file basename where missing, and renames entity files to
	 * the managed `<Project> <Type label> <name>` convention (Obsidian updates
	 * every link). Idempotent — conforming notes are untouched — and automatic:
	 * it runs on load, no command, since no released vaults predate it.
	 */
	async migrateFiles(): Promise<void> {
		for (const record of [...this.records.values()]) {
			const project = this.getProjectByRoot(record.project);
			const file = this.app.vault.getFileByPath(record.path);
			if (!project || !file) continue;
			const isSession = record.type === 'session';
			// record.name already read loomName-with-basename-fallback, so for an
			// unmigrated file it is the old display name — exactly what to keep.
			const displayName = record.name;
			try {
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					for (const key of Object.values(FM)) {
						if (key === FM.timelineTypes) continue; // timeline files only
						const legacyNames = legacyFmKeys(key);
						if (fmField(fm, key) === undefined) {
							for (const legacy of legacyNames) {
								const v = fmField(fm, legacy);
								if (v !== undefined) {
									fm[key] = v;
									break;
								}
							}
						}
						for (const k of Object.keys(fm)) {
							const lower = k.toLowerCase();
							if (k !== key && legacyNames.some((l) => l.toLowerCase() === lower)) delete fm[k];
						}
					}
					if (!isSession) {
						const cur = fmField(fm, FM.name);
						if (typeof cur !== 'string' || cur.trim() === '') fm[FM.name] = displayName;
						const aliases: unknown[] = Array.isArray(fm.aliases) ? (fm.aliases as unknown[]) : [];
						if (!aliases.includes(displayName)) fm.aliases = [displayName, ...aliases];
					}
				});
			} catch (e) {
				console.error('Loom Loom: frontmatter migration failed for', record.path, e);
				continue;
			}
			// Sessions already follow their own managed scheme (from the date).
			if (isSession) continue;
			const base = managedEntityFileName(project.name, record.type, displayName);
			if (file.basename === base) continue;
			const parent = file.parent?.path ?? '';
			let newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
			for (let i = 2; this.app.vault.getAbstractFileByPath(newPath) !== null; i++) {
				newPath = normalizePath(parent === '' ? `${base} ${i}.md` : `${parent}/${base} ${i}.md`);
			}
			try {
				await this.app.fileManager.renameFile(file, newPath);
			} catch (e) {
				console.error('Loom Loom: file rename migration failed for', record.path, e);
			}
		}
		// Timeline definition files: same key rewrite (name/types/tags are
		// plugin-owned there and move under the loom prefix).
		for (const def of [...this.timelines.values()]) {
			const file = this.app.vault.getFileByPath(def.path);
			if (!file) continue;
			try {
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					for (const [legacy, key] of [
						['name', FM.name],
						['types', FM.timelineTypes],
						['tags', FM.tags],
					] as const) {
						if (fmField(fm, key) === undefined && fmField(fm, legacy) !== undefined) {
							fm[key] = fmField(fm, legacy);
						}
						for (const k of Object.keys(fm)) {
							if (k !== key && k.toLowerCase() === legacy) delete fm[k];
						}
					}
				});
			} catch (e) {
				console.error('Loom Loom: timeline migration failed for', def.path, e);
			}
		}
	}

	// --- Projects ------------------------------------------------------------

	getProjects(): ProjectDef[] {
		return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	getProjectByLoomPath(path: string): ProjectDef | undefined {
		return this.projects.get(path);
	}

	getProjectByRoot(root: string): ProjectDef | undefined {
		for (const p of this.projects.values()) if (p.root === root) return p;
		return undefined;
	}

	/** The deepest project whose root contains `path`, or undefined. */
	projectForPath(path: string): ProjectDef | undefined {
		let best: ProjectDef | undefined;
		for (const p of this.projects.values()) {
			if (p.root !== '' && path !== p.root && !path.startsWith(p.root + '/')) continue;
			if (!best || p.root.length > best.root.length) best = p;
		}
		return best;
	}

	// --- Indexing one file -----------------------------------------------------

	private indexFile(file: TFile): void {
		const project = this.projectForPath(file.path);
		if (!project) return;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (this.isTimelineDefPath(file.path, project)) {
			this.records.delete(file.path);
			this.timelines.set(file.path, this.parseTimelineDef(file, project, fm));
			return;
		}
		const record = fm ? this.parseEntity(file, project, fm) : null;
		if (record) {
			this.records.set(file.path, record);
		} else {
			this.records.delete(file.path);
		}
	}

	private isTimelineDefPath(path: string, project: ProjectDef): boolean {
		const prefix = project.root === '' ? TIMELINES_FOLDER : project.root + '/' + TIMELINES_FOLDER;
		return path.startsWith(prefix + '/');
	}

	private parseTimelineDef(file: TFile, project: ProjectDef, fm: FrontMatterCache | undefined): TimelineDef {
		const types: EntityType[] = [];
		const rawTypes = fm ? fmLoom(fm, FM.timelineTypes) : undefined;
		if (Array.isArray(rawTypes)) {
			for (const t of rawTypes) {
				const lower = typeof t === 'string' ? t.toLowerCase() : '';
				if (isEntityType(lower)) types.push(lower);
			}
		}
		const rawName = fm ? fmLoom(fm, FM.name) : undefined;
		const rawTags = fm ? fmLoom(fm, FM.tags) : undefined;
		return {
			path: file.path,
			project: project.root,
			name: typeof rawName === 'string' && rawName.trim() !== '' ? rawName : file.basename,
			types: types.length > 0 ? types : ['session', 'event'],
			tags: Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string') : [],
		};
	}

	private parseEntity(file: TFile, project: ProjectDef, fm: FrontMatterCache): EntityRecord | null {
		const rawType = fmLoom(fm, FM.type);
		const type = typeof rawType === 'string' ? rawType.toLowerCase() : '';
		if (!isEntityType(type)) return null;

		const relationships: RelationshipDecl[] = [];
		const rawRelationships = fmLoom(fm, FM.relationships);
		if (Array.isArray(rawRelationships)) {
			for (const rel of rawRelationships) {
				if (typeof rel !== 'object' || rel === null) continue;
				const { type: relType, target } = rel as { type?: unknown; target?: unknown };
				if (typeof target !== 'string') continue;
				const linkpath = extractLinkpath(target);
				if (!linkpath) continue;
				relationships.push({
					type: typeof relType === 'string' && relType.trim() !== '' ? relType : 'related',
					targetRaw: target,
					linkpath,
				});
			}
		}

		const sessionNotes: SessionNoteDecl[] = [];
		const rawSessionNotes = fmLoom(fm, FM.sessionNotes);
		if (Array.isArray(rawSessionNotes)) {
			for (const note of rawSessionNotes) {
				if (typeof note !== 'object' || note === null) continue;
				const { session, text, places, seq, involved } = note as {
					session?: unknown;
					text?: unknown;
					places?: unknown;
					seq?: unknown;
					involved?: unknown;
				};
				sessionNotes.push({
					session: typeof session === 'string' ? extractLinkpath(session) : null,
					text: typeof text === 'string' ? text : '',
					places: parseLinkList(places),
					seq: typeof seq === 'number' ? seq : null,
					involved: parseLinkList(involved),
				});
			}
		}

		// Sessions always track real-world dates; everything else follows the
		// project's calendar (custom in-game calendar when enabled).
		const calendar =
			type !== 'session' && project.config.customCalendar.enabled ? 'custom' : 'gregorian';
		const nameValue = fmLoom(fm, FM.name);
		const descriptionValue = fmLoom(fm, FM.description);
		const aliveValue = fmLoom(fm, FM.alive);
		const deathValue = fmLoom(fm, FM.deathSession);
		const receivedValue = fmLoom(fm, FM.questReceived);
		const outcomeValue = fmLoom(fm, FM.questOutcome);
		const outcomeSessionValue = fmLoom(fm, FM.questOutcomeSession);
		const parentValue = fmLoom(fm, FM.parentLocation);
		const rewardValue = fmLoom(fm, FM.reward);
		return {
			path: file.path,
			// Display name = `loomName` (the user-entered name; the managed file
			// name is derived from it). Sessions display their date instead and
			// never carry a loomName; a missing loomName falls back to the file
			// basename so foreign/unmigrated notes still work.
			name:
				type !== 'session' && typeof nameValue === 'string' && nameValue.trim() !== ''
					? nameValue.trim()
					: file.basename,
			type,
			project: project.root,
			// `loomTags` is the current key; `pluginTags` is its pre-rename
			// spelling, still read so existing notes keep their tags.
			loomTags: parseTagList(fmLoom(fm, FM.tags)),
			description: typeof descriptionValue === 'string' ? descriptionValue : '',
			relationships,
			sessionNotes,
			date: parseLoomDate(fmLoom(fm, FM.date), calendar, project.config),
			attendance: parseLinkList(fmLoom(fm, FM.attendance)),
			parentLocation: typeof parentValue === 'string' ? extractLinkpath(parentValue) : null,
			sublocationOrder: parseLinkList(fmLoom(fm, FM.sublocationOrder)),
			members: parseMemberList(fmLoom(fm, FM.members)),
			alive: typeof aliveValue === 'boolean' ? aliveValue : true,
			deathSession: typeof deathValue === 'string' ? extractLinkpath(deathValue) : null,
			questReceived: typeof receivedValue === 'string' ? extractLinkpath(receivedValue) : null,
			questOutcome:
				typeof outcomeValue === 'string' &&
				(QUEST_OUTCOMES as readonly string[]).includes(outcomeValue.toLowerCase())
					? outcomeValue.toLowerCase()
					: '',
			questOutcomeSession:
				typeof outcomeSessionValue === 'string' ? extractLinkpath(outcomeSessionValue) : null,
			questGivers: parseLinkList(fmLoom(fm, FM.questGiver)),
			reward: typeof rewardValue === 'string' ? rewardValue : '',
			seq: typeof fmLoom(fm, FM.seq) === 'number' ? (fmLoom(fm, FM.seq) as number) : null,
			created: file.stat.ctime,
			modified: file.stat.mtime,
		};
	}

	private bump(): void {
		this.version++;
		this.incoming = null;
		this.persistLater();
		this.events.trigger('changed');
	}

	/** Re-render subscribed views without re-indexing — for settings changes
	 *  that affect rendering (e.g. quest tag colors) but not the index data. */
	refreshViews(): void {
		this.version++;
		this.events.trigger('changed');
	}

	// --- Queries -----------------------------------------------------------

	get(path: string): EntityRecord | undefined {
		return this.records.get(path);
	}

	getAll(type?: EntityType, projectRoot?: string): EntityRecord[] {
		const all = [...this.records.values()];
		return all.filter(
			(r) => (type === undefined || r.type === type) && (projectRoot === undefined || r.project === projectRoot)
		);
	}

	getTimelines(projectRoot?: string): TimelineDef[] {
		return [...this.timelines.values()]
			.filter((t) => projectRoot === undefined || t.project === projectRoot)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Resolves a linkpath declared in `sourcePath` to an indexed record, or null. */
	resolve(linkpath: string, sourcePath: string): EntityRecord | null {
		const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		return file ? this.records.get(file.path) ?? null : null;
	}

	/**
	 * Connections declared on the note: typed relationships, sessions picked
	 * for session notes, and plain [[wikilinks]] anywhere in the note (body
	 * or frontmatter) that land on another indexed entity.
	 */
	getOutgoing(path: string): Connection[] {
		const record = this.records.get(path);
		if (!record) return [];
		const out: Connection[] = [];
		const linked = new Set<string>();
		for (const rel of record.relationships) {
			const target = this.resolve(rel.linkpath, record.path);
			if (target) {
				out.push({ record: target, relType: rel.type, direction: 'outgoing' });
				linked.add(target.path);
			}
		}
	// Ticked attendance connects the PC to the session (typed edge); the
		// key stays in HIDDEN_LINK_KEYS only to keep the generic pass from
		// double-counting it as a plain link.
		for (const lp of record.attendance) {
			const pc = this.resolve(lp, record.path);
			if (pc?.type === 'character' && !linked.has(pc.path)) {
				out.push({ record: pc, relType: 'attendance', direction: 'outgoing' });
				linked.add(pc.path);
			}
		}
		// Before the generic wikilink pass so these keep their typed relType
		// instead of degrading to a plain 'link'.
		// A custom membership role labels the connection (graph edge, side
		// panel); only the default role reads as plain 'member'.
		for (const m of record.members) {
			const member = this.resolve(m.linkpath, record.path);
			if (member?.type === 'character' && !linked.has(member.path)) {
				out.push({
					record: member,
					relType: m.role === DEFAULT_MEMBER_ROLE ? 'member' : m.role,
					direction: 'outgoing',
				});
				linked.add(member.path);
			}
		}
		if (record.parentLocation !== null) {
			const parent = this.resolve(record.parentLocation, record.path);
			if (parent?.type === 'location' && parent.path !== record.path && !linked.has(parent.path)) {
				out.push({ record: parent, relType: 'sublocation', direction: 'outgoing' });
				linked.add(parent.path);
			}
		}
	for (const note of record.sessionNotes) {
			const target = note.session ? this.resolve(note.session, record.path) : null;
			if (target?.type === 'session' && !linked.has(target.path)) {
				out.push({ record: target, relType: 'session note', direction: 'outgoing' });
				linked.add(target.path);
			}
			for (const lp of note.involved) {
				const inv = this.resolve(lp, record.path);
				if (inv && inv.path !== record.path && !linked.has(inv.path)) {
					out.push({ record: inv, relType: 'involved', direction: 'outgoing' });
					linked.add(inv.path);
				}
			}
			// Events/quests store a note's location per-note in `places`; connect it.
			if (record.type === 'event' || record.type === 'quest') {
				for (const lp of note.places) {
					const loc = this.resolve(lp, record.path);
					if (loc?.type === 'location' && loc.path !== record.path && !linked.has(loc.path)) {
						out.push({ record: loc, relType: 'location', direction: 'outgoing' });
						linked.add(loc.path);
					}
				}
			}
		}
		const file = this.app.vault.getFileByPath(path);
		const cache = file ? this.app.metadataCache.getFileCache(file) : null;
		const fmLinks = (cache?.frontmatterLinks ?? []).filter((l) => !isHiddenLinkKey(l.key));
		for (const link of [...(cache?.links ?? []), ...fmLinks]) {
			const linkpath = extractLinkpath(link.link);
			const target = linkpath ? this.resolve(linkpath, path) : null;
			if (target && target.path !== path && !linked.has(target.path)) {
				out.push({ record: target, relType: 'link', direction: 'outgoing' });
				linked.add(target.path);
			}
		}
		return out;
	}

	getIncoming(path: string): Connection[] {
		if (!this.incoming) {
			this.incoming = new Map();
			for (const record of this.records.values()) {
				for (const conn of this.getOutgoing(record.path)) {
					let list = this.incoming.get(conn.record.path);
					if (!list) {
						list = [];
						this.incoming.set(conn.record.path, list);
					}
					list.push({ record, relType: conn.relType, direction: 'incoming' });
				}
			}
		}
		return this.incoming.get(path) ?? [];
	}

	/**
	 * All connections of a note, both declared on it and declared elsewhere
	 * pointing at it — direction of declaration doesn't matter for visibility.
	 */
	getConnections(path: string): Connection[] {
		const seen = new Set<string>();
		const all: Connection[] = [];
		for (const conn of [...this.getOutgoing(path), ...this.getIncoming(path)]) {
			const key = conn.record.path + ' ' + conn.relType;
			if (seen.has(key)) continue;
			seen.add(key);
			all.push(conn);
		}
		return all;
	}

	// --- Persistence -------------------------------------------------------

	/**
	 * Snapshot of the index written next to the plugin for debugging and fast
	 * cold starts. The in-memory index is authoritative; this file is never
	 * read back as a source of truth within a session.
	 */
	private persistLater = debounce(() => void this.persist(), 2000, true);

	private async persist(): Promise<void> {
		const dir = this.plugin.manifest.dir;
		if (!dir) return;
		const payload = JSON.stringify(
			{
				// v4: members entries became { linkpath, role } declarations.
				schemaVersion: 4,
				generatedAt: Date.now(),
				projects: [...this.projects.values()],
				records: [...this.records.values()],
				timelines: [...this.timelines.values()],
			},
			null,
			'\t'
		);
		try {
			await this.app.vault.adapter.write(normalizePath(dir + '/index-cache.json'), payload);
		} catch (e) {
			console.error('Loom Loom: failed to write index cache', e);
		}
	}
}
