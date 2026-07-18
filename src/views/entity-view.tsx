import { App, Menu, Notice, TFile, ViewStateResult, normalizePath } from 'obsidian';
import {
	CSSProperties,
	MouseEvent as ReactMouseEvent,
	ReactElement,
	ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
	DEFAULT_MEMBER_ROLE,
	ENTITY_META,
	ENTITY_TAGS,
	ENTITY_TYPES,
	EntityOrigin,
	EntityRecord,
	EntityType,
	FM,
	PC_TAG,
	QUEST_OUTCOMES,
	VIEW_ENTITY,
	VIEW_LIST,
} from '../types';
import {
	ConfirmModal,
	CreateEntityModal,
	EntityTypeSuggestModal,
	RecordSuggestModal,
	entityFileName,
	sessionFileName,
} from '../project';
import { formatLoomDateShort, todayRaw } from '../calendar';
import { LoomFileReactView } from './react-view';
import {
	EntityChip,
	FRONTMATTER_RE,
	Icon,
	NavRail,
	SearchableSelect,
	SuggestInput,
	Truncated,
	locationLabel,
	recordLabel,
} from './common';
import { ConnectedEntities } from './connected-entities';
import { LinkOption } from './link-textarea';
import { MarkdownField } from './markdown-field';
import { extractLinkpath, linkTargetOf, memberEntryLinkpath } from '../indexer';
import { fmLoomValue, setLoomKey } from '../fm';
import { MiniGraph } from './mini-graph';
import { useIndexVersion } from './hooks';
import type LoomLoomPlugin from '../main';


/**
 * Entity page: a structured form over an entity's .md file, opened by every
 * loom-internal click. The file stays a normal markdown note — opening it
 * from the file explorer still gives the raw editor, and [[wikilinks]] typed
 * in any field connect exactly like links in any other note.
 */
export class EntityView extends LoomFileReactView {
	/** The view this entity page was opened from; Back returns there. */
	origin: EntityOrigin | null = null;

	getViewType(): string {
		return VIEW_ENTITY;
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), origin: this.origin };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const origin = (state as { origin?: unknown } | null)?.origin;
		if (
			typeof origin === 'object' &&
			origin !== null &&
			typeof (origin as EntityOrigin).type === 'string'
		) {
			this.origin = origin as EntityOrigin;
		}
		await super.setState(state, result);
		this.renderNow();
	}

	getDisplayText(): string {
		if (!this.file) return 'Entity';
		const record = this.plugin.indexer.get(this.file.path);
		if (!record) return this.file.basename;
		const project = this.plugin.indexer.getProjectByRoot(record.project) ?? null;
		return recordLabel(record, project);
	}

	getIcon(): string {
		const record = this.file ? this.plugin.indexer.get(this.file.path) : undefined;
		return record ? ENTITY_META[record.type].icon : 'file';
	}

	canAcceptExtension(extension: string): boolean {
		return extension === 'md';
	}

	async onRename(file: TFile): Promise<void> {
		await super.onRename(file);
		this.renderNow();
	}

	protected renderReact(): ReactElement {
		return <EntityPage key={this.file?.path ?? ''} view={this} />;
	}
}

function useFrontmatterWriter(plugin: LoomLoomPlugin, file: TFile | null) {
	return useMemo(
		() => (apply: (fm: Record<string, unknown>) => void) => {
			if (!file) return;
			plugin.app.fileManager.processFrontMatter(file, apply).catch((e) => {
				console.error('Loom Loom: failed to update frontmatter', e);
				new Notice('Could not save the change.');
			});
		},
		[plugin, file]
	);
}

/**
 * Sets a frontmatter key, first removing other casings of it — Obsidian's
 * Properties UI treats names case-insensitively and may have rewritten ours —
 * plus any listed legacy keys.
 */
interface RelationshipDraft {
	type: string;
	target: string;
	/** Transient, never written: narrows the target autocomplete to one entity type. */
	filter?: EntityType | null;
}

interface SessionNoteDraft {
	/** Session linkpath; '' while no session is picked yet. */
	session: string;
	text: string;
	/** Locations only: linkpaths of places this note is about. */
	places: string[];
	/** Linkpaths of involved entities (the note is their home). */
	involved: string[];
	/** Creation/reorder stamp — carried through commits so ordering survives. */
	seq: number | null;
	/** Index of the stored frontmatter entry this draft was seeded from, or
	 *  null for a not-yet-saved new note. Commits merge into that entry so
	 *  fields this editor doesn't know about survive the round-trip. */
	idx: number | null;
}

/** Session-graph sections left open, by file path — survives page re-opens
 *  within the session (not persisted to disk). */
const openSessionGraphs = new Set<string>();

/** Lucide icon per quest tag. */
const QUEST_TAG_ICONS: Record<string, string> = {
	main: 'star',
	important: 'triangle-alert',
	side: 'shapes',
};
const QUEST_TAG_KEYS = ['main', 'important', 'side'] as const;

/** Live-preview markdown note editor for a hub row (whose note has no draft
 *  state): keeps its own value and commits to the owner's frontmatter on idle. */
function HubNoteText({
	app,
	initial,
	names,
	onOpenLink,
	onCreateEntity,
	onCommit,
}: {
	app: App;
	initial: string;
	names: LinkOption[];
	onOpenLink: (target: string) => void;
	onCreateEntity?: (name: string, insert: (linkInsert: string) => void) => void;
	onCommit: (value: string) => void;
}) {
	const [value, setValue] = useState(initial);
	const timer = useRef(0);
	useEffect(() => setValue(initial), [initial]);
	return (
		<MarkdownField
			app={app}
			value={value}
			names={names}
			onOpenLink={onOpenLink}
			onCreateEntity={onCreateEntity}
			onChange={(v) => {
				setValue(v);
				window.clearTimeout(timer.current);
				timer.current = window.setTimeout(() => onCommit(v), 600);
			}}
		/>
	);
}
/** Black or white, whichever reads better on the given #rrggbb background. */
function readableOn(hex: string): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
	if (!m) return 'var(--text-normal)';
	const n = parseInt(m[1], 16);
	const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
	return lum > 0.6 ? '#000000' : '#ffffff';
}

interface LocNoteEntry {
	owner: EntityRecord;
	idx: number;
	session: string | null;
	text: string;
	seq: number | null;
	involved: string[];
	places: string[];
}

function EntityPage({ view }: { view: EntityView }) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const file = view.file;
	const record = file ? plugin.indexer.get(file.path) : undefined;
	const project = record ? plugin.indexer.getProjectByRoot(record.project) ?? null : null;
	const writeFm = useFrontmatterWriter(plugin, file);

	/** Label a record is searched/shown by in free-text draft inputs: the
	 *  display name — for sessions, their formatted date (their file name is
	 *  managed and never user-facing). */
	const draftLabel = (r: EntityRecord) =>
		r.type === 'session'
			? recordLabel(r, plugin.indexer.getProjectByRoot(r.project) ?? null)
			: r.name;

	// Drafts are seeded once per file (component is keyed by path) so index
	// updates triggered by our own saves never clobber what's being typed.
	const [name, setName] = useState(record?.name ?? '');
	const [description, setDescription] = useState(record?.description ?? '');
	const [reward, setReward] = useState(record?.reward ?? '');
	const [date, setDate] = useState(record?.date?.raw ?? '');
	const [relationships, setRelationships] = useState<RelationshipDraft[]>(
		record?.relationships.map((r) => {
			const target = plugin.indexer.resolve(r.linkpath, record.path);
			return { type: r.type, target: target ? draftLabel(target) : r.linkpath };
		}) ?? []
	);
	const [sessionNotes, setSessionNotes] = useState<SessionNoteDraft[]>(
		record?.sessionNotes.map((n, idx) => ({ session: n.session ?? '', text: n.text, places: n.places, involved: n.involved, seq: n.seq, idx })) ?? []
	);
	const [body, setBody] = useState<string | null>(null);
	/** Live sublocation reorder: rows slide in real time while the grip is
	 *  held; the row itself is never carried by the cursor. */
	const [sublocDrag, setSublocDrag] = useState<{ from: number; over: number; dy: number } | null>(
		null
	);
	const sublocDragRef = useRef<{ startY: number; slot: number } | null>(null);
	const sublocListRef = useRef<HTMLDivElement | null>(null);
	/** Characters: a pending "+ Add faction" row awaiting its faction pick. */
	const [factionDraft, setFactionDraft] = useState(false);
	/** Pending alias text (committed via + / Enter into native `aliases`). */
	const [aliasDraft, setAliasDraft] = useState('');
	/** Session graph section, collapsed by default; remembered per file. */
	const [graphOpen, setGraphOpenState] = useState(() => openSessionGraphs.has(file?.path ?? ''));
	const setGraphOpen = (open: boolean) => {
		setGraphOpenState(open);
		if (!file) return;
		if (open) openSessionGraphs.add(file.path);
		else openSessionGraphs.delete(file.path);
	};
	const [questsOpen, setQuestsOpen] = useState<{ active: boolean; finished: boolean }>({
		active: true,
		finished: false,
	});
	/** Hub row whose action menu (trash / unlink) is slid open, if any. */
	const [hubMenu, setHubMenu] = useState<string | null>(null);
	/** Per-hub-row entity-type filter for the Involve picker. */
	const [hubFilter, setHubFilter] = useState<Record<string, EntityType | null>>({});
	/** Live reorder of entity lists by loomSeq (session-page events + quests);
	 *  `group` scopes the slide so only the dragged list moves. */
	const [seqDrag, setSeqDrag] = useState<{ group: string; from: number; over: number; dy: number } | null>(
		null
	);
	/** `mids` = each row's viewport-Y center, snapshotted at grab time so the
	 *  target index reads off the *static* layout (immune to the live slide). */
	const seqDragRef = useRef<{ startY: number; slot: number; mids: number[] } | null>(null);
	/** Quest-card grid reorder (timeline-style): the grabbed card rides the
	 *  cursor while the rest stay put; a portalled bar previews the drop slot.
	 *  `over` is the insertion index among the *other* cards, read from a static
	 *  rect snapshot so it's immune to any layout shift. */
	type QuestRect = { path: string; left: number; top: number; width: number; height: number };
	const [questDrag, setQuestDrag] = useState<{
		gkey: string;
		active: string;
		over: number;
		dx: number;
		dy: number;
	} | null>(null);
	const questDragRef = useRef<{ startX: number; startY: number; rects: QuestRect[]; over: number } | null>(
		null
	);

	// A freshly created note opens before metadataCache has indexed it, so the
	// record can arrive one tick after mount — seed the drafts then.
	const seeded = useRef(record !== undefined);
	useEffect(() => {
		if (!record || seeded.current) return;
		seeded.current = true;
		setName(record.name);
		setDescription(record.description);
		setReward(record.reward);
		setDate(record.date?.raw ?? '');
		setRelationships(
			record.relationships.map((r) => {
				const target = plugin.indexer.resolve(r.linkpath, record.path);
				return { type: r.type, target: target ? draftLabel(target) : r.linkpath };
			})
		);
		setSessionNotes(record.sessionNotes.map((n, idx) => ({ session: n.session ?? '', text: n.text, places: n.places, involved: n.involved, seq: n.seq, idx })));
	}, [record]);

	useEffect(() => {
		if (!file) return;
		let cancelled = false;
		void plugin.app.vault.cachedRead(file).then((data) => {
			if (!cancelled) setBody(data.replace(FRONTMATTER_RE, ''));
		});
		return () => {
			cancelled = true;
		};
	}, [plugin, file]);


	// Link completions offer only this project's entities, searched by their
	// short (user-entered) name — sessions by their date. Inserted as
	// `target|short name` so the raw link resolves AND reads well.
	const linkNames = useMemo(() => {
		const records = record ? plugin.indexer.getAll(undefined, record.project) : [];
		return records
			.map((r) => {
				const target = linkTargetOf(r);
				const label = draftLabel(r);
				return { label, insert: target === label ? label : `${target}|${label}` };
			})
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [plugin, record, version]);

	const saveBody = useMemo(() => {
		let timer = 0;
		return (value: string) => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				if (!file) return;
				void plugin.app.vault.process(file, (data) => {
					const m = FRONTMATTER_RE.exec(data);
					return (m ? m[0] : '') + value;
				});
			}, 600);
		};
	}, [plugin, file]);

	// Description commits on idle (the markdown field has no blur-style
	// moment that reliably fires before navigation).
	const saveDescription = useMemo(() => {
		let timer = 0;
		return (value: string) => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				if (!file) return;
				plugin.app.fileManager
					.processFrontMatter(file, (fm: Record<string, unknown>) => {
						setLoomKey(fm, FM.description, value);
					})
					.catch((e) => {
						console.error('Loom Loom: failed to save description', e);
					});
			}, 600);
		};
	}, [plugin, file]);

	/** Opens a wikilink target from the markdown fields: loom entities get
	 *  their entity page, anything else Obsidian's normal link opening. */
	const openLinkTarget = (target: string) => {
		if (!record) return;
		const resolved = plugin.indexer.resolve(target, record.path);
		if (resolved) view.openEntity(resolved.path);
		else void plugin.app.workspace.openLinkText(target, record.path);
	};

	/** "+ Create …" from a [[ completion: type picker → creation modal with
	 *  the short name prefilled; the finished entity links back in place. */
	const createLinkEntity = (entered: string, insert: (linkInsert: string) => void) => {
		const proj = record ? plugin.indexer.getProjectByRoot(record.project) ?? null : null;
		if (!proj) return;
		new EntityTypeSuggestModal(plugin, (type) =>
			new CreateEntityModal(plugin, type, proj, {
				initialName: entered,
				onCreated: (created) => {
					// Short name = managed basename minus its prefix (the index
					// may not have caught the new file yet).
					const prefix = `${proj.name} ${ENTITY_META[type].label} `;
					const label = created.basename.startsWith(prefix)
						? created.basename.slice(prefix.length)
						: entered;
					insert(created.basename === label ? label : `${created.basename}|${label}`);
				},
			}).open()
		).open();
	};

	if (!file || !record) {
		return (
			<div className="loom-entity loom-empty">
				<p>Loading… If this note is not a Loom Loom entity (no `loomType` frontmatter), it has no entity page.</p>
				<button onClick={() => view.navigateTo('markdown', { file: file?.path })}>Open as markdown</button>
			</div>
		);
	}

	const isSession = record.type === 'session';
	const vocab = ENTITY_TAGS[record.type];
	const allTags = [...new Set([...vocab, ...record.loomTags])];
	const sessions = project ? plugin.indexer.getAll('session', project.root) : [];
	const targetRecords = project ? plugin.indexer.getAll(undefined, project.root) : [];

	/**
	 * THE write path for a loom frontmatter list on any file: reads the raw
	 * array (legacy spellings included), hands it to `apply`, writes the loom
	 * key back. `apply` may mutate in place or return a replacement. All
	 * cross-file edits (members, other notes' session notes/relationships) go
	 * through here so unknown fields survive and legacy keys get cleaned up.
	 */
	const editFmList = (
		path: string,
		key: string,
		apply: (arr: unknown[]) => unknown[] | void
	) => {
		const f = plugin.app.vault.getFileByPath(path);
		if (!f) return;
		plugin.app.fileManager
			.processFrontMatter(f, (fm: Record<string, unknown>) => {
				const cur = fmLoomValue(fm, key);
				const arr = Array.isArray(cur) ? cur : [];
				setLoomKey(fm, key, apply(arr) ?? arr);
			})
			.catch((e) => {
				console.error(`Loom Loom: failed to update ${key}`, e);
				new Notice('Could not save the change.');
			});
	};

	/** Renames the file to its managed name and stores the entered display
	 *  name (`loomName` + a native alias so [[…]] autocomplete finds it). */
	const commitName = async () => {
		const entered = name.trim();
		if (entered === '' || entered === record.name || !project) {
			setName(record.name);
			return;
		}
		await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			setLoomKey(fm, FM.name, entered);
			const aliases: unknown[] = Array.isArray(fm.aliases)
				? (fm.aliases as unknown[]).filter((a) => a !== record.name && a !== entered)
				: [];
			fm.aliases = [entered, ...aliases];
		});
		const parentName =
			record.type === 'location' && record.parentLocation !== null
				? plugin.indexer.resolve(record.parentLocation, record.path)?.name
				: undefined;
		const base = entityFileName(project, record.type, entered, parentName);
		const parent = file.parent?.path ?? '';
		const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
		if (newPath === file.path) return;
		if (plugin.app.vault.getAbstractFileByPath(newPath)) {
			new Notice('A note with that name already exists.');
			return;
		}
		await plugin.app.fileManager.renameFile(file, newPath);
	};

	// Aliases live in Obsidian's native `aliases` frontmatter — that's what
	// link suggestions read — so edits here go straight to that key. The alias
	// equal to the display name is plugin-managed (kept in sync by renames)
	// and hidden from the chip list.
	const fileAliases = (() => {
		const raw = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.aliases as unknown;
		return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === 'string') : [];
	})();
	const extraAliases = fileAliases.filter((a) => a !== record.name);
	const addAlias = () => {
		const alias = aliasDraft.trim();
		setAliasDraft('');
		if (alias === '' || fileAliases.includes(alias)) return;
		writeFm((fm) => {
			const cur: unknown[] = Array.isArray(fm.aliases) ? (fm.aliases as unknown[]) : [];
			fm.aliases = [...cur, alias];
		});
	};
	const removeAlias = (alias: string) => {
		writeFm((fm) => {
			const cur: unknown[] = Array.isArray(fm.aliases) ? (fm.aliases as unknown[]) : [];
			fm.aliases = cur.filter((a) => a !== alias);
		});
	};

	const commitDate = async (raw: string = date) => {
		const value = raw.trim();
		writeFm((fm) => {
			setLoomKey(fm, FM.date, value);
		});
		if (isSession && project && value !== '') {
			const base = sessionFileName(project, value);
			const parent = file.parent?.path ?? '';
			const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
			if (newPath !== file.path && !plugin.app.vault.getAbstractFileByPath(newPath)) {
				await plugin.app.fileManager.renameFile(file, newPath);
			}
		}
	};

	/** Resolves a draft value — display name or link target — to its record. */
	const resolveDraftTarget = (value: string): EntityRecord | null => {
		const trimmed = value.trim();
		if (trimmed === '') return null;
		return (
			targetRecords.find((r) => draftLabel(r) === trimmed || r.name === trimmed) ??
			plugin.indexer.resolve(trimmed, record.path)
		);
	};
	/** Resolves a picker/draft value (display name or basename) to a link target. */
	const linkTargetFor = (value: string): string => {
		const rec = resolveDraftTarget(value);
		return rec ? linkTargetOf(rec) : value.trim();
	};

	const commitRelationships = (next: RelationshipDraft[]) => {
		setRelationships(next);
		writeFm((fm) => {
			setLoomKey(
				fm,
				FM.relationships,
				next
					.filter((r) => r.target.trim() !== '')
					.map((r) => ({
						type: r.type.trim() === '' ? 'related' : r.type.trim(),
						target: `[[${linkTargetFor(r.target)}]]`,
					}))
			);
		});
	};

	const commitSessionNotes = (next: SessionNoteDraft[]) => {
		setSessionNotes(next);
		const asLink = (v: string) => (v.startsWith('[[') ? v : `[[${v}]]`);
		editFmList(record.path, FM.sessionNotes, (arr) =>
			next
				.filter(
					(n) =>
						n.session.trim() !== '' ||
						n.text.trim() !== '' ||
						n.involved.length > 0 ||
						n.places.length > 0
				)
				.map((n) => {
					// Merge over the stored entry (matched by seeded index) so
					// fields this editor doesn't know about survive; every field
					// it does know is written — dropping one silently erases it.
					const prev =
						n.idx !== null && typeof arr[n.idx] === 'object' && arr[n.idx] !== null
							? { ...(arr[n.idx] as Record<string, unknown>) }
							: {};
					const out: Record<string, unknown> = {
						...prev,
						session: n.session.trim() === '' ? '' : `[[${n.session.trim()}]]`,
						text: n.text,
					};
					if (n.places.length > 0) out.places = n.places.map(asLink);
					else delete out.places;
					if (n.involved.length > 0) out.involved = n.involved.map(asLink);
					else delete out.involved;
					if (n.seq !== null) out.seq = n.seq;
					return out;
				})
		);
	};

	// Session attendance: PC characters offered as toggle chips. A PC who died
	// in an earlier session is no longer offered in sessions after it.
	const attendancePcs = isSession
		? plugin.indexer
				.getAll('character', record.project)
				.filter((c) => c.loomTags.includes(PC_TAG))
				.filter((c) => {
					if (c.alive || !c.deathSession || !record.date) return true;
					const death = plugin.indexer.resolve(c.deathSession, c.path);
					if (!death || death.type !== 'session' || !death.date) return true;
					return record.date.sortKey <= death.date.sortKey;
				})
				.sort((a, b) => a.name.localeCompare(b.name))
		: [];
	const attendingPaths = new Set(
		record.attendance
			.map((lp) => plugin.indexer.resolve(lp, record.path)?.path)
			.filter((p): p is string => p !== undefined)
	);
	const toggleAttendance = (c: EntityRecord) => {
		const next = attendingPaths.has(c.path)
			? record.attendance.filter((lp) => plugin.indexer.resolve(lp, record.path)?.path !== c.path)
			: [...record.attendance, linkTargetOf(c)];
		writeFm((fm) => {
			setLoomKey(fm, FM.attendance, next.map((n) => `[[${n}]]`));
		});
	};

	// Quest fields: giver characters (several), received/outcome sessions, reward.
	const isQuest = record.type === 'quest';
	const questGiverRecords = isQuest
		? record.questGivers
				.map((lp) => plugin.indexer.resolve(lp, record.path))
				.filter((r): r is EntityRecord => r !== null && r !== undefined)
		: [];
	const characters = isQuest && project ? plugin.indexer.getAll('character', project.root) : [];
	const writeQuestGivers = (targets: string[]) => {
		writeFm((fm) => {
			setLoomKey(fm, FM.questGiver, targets.map((n) => `[[${n}]]`));
		});
	};
	const questReceived =
		isQuest && record.questReceived !== null
			? plugin.indexer.resolve(record.questReceived, record.path)
			: null;
	const questOutcomeSession =
		isQuest && record.questOutcomeSession !== null
			? plugin.indexer.resolve(record.questOutcomeSession, record.path)
			: null;
	const setQuestSession = (key: 'questReceived' | 'questOutcomeSession', target: string | null) => {
		writeFm((fm) => {
			setLoomKey(fm, key === 'questReceived' ? FM.questReceived : FM.questOutcomeSession, target === null ? '' : `[[${target}]]`);
		});
	};
	const setQuestOutcome = (outcome: string) => {
		writeFm((fm) => {
			setLoomKey(fm, FM.questOutcome, outcome);
			if (outcome === '') setLoomKey(fm, FM.questOutcomeSession, '');
		});
	};
	const sessionsByDate = sessions
		.slice()
		.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0));
	const sessionChip = (s: EntityRecord, clear: () => void) => (
		<div className="loom-tag-row">
			<EntityChip
				plugin={plugin}
				record={s}
				label={recordLabel(s, project)}
				onOpen={() => view.openEntity(s.path)}
				onRemove={clear}
				removeLabel="Clear session"
			/>
		</div>
	);

	// Locations: `parentLocation` makes this a sublocation — dedicated logic,
	// deliberately not a relationship. Any location can hold sublocations of
	// its own (nesting); the parent picker excludes the location itself and
	// its descendants so a cycle can't be built.
	const isLocation = record.type === 'location';
	const projectLocations =
		isLocation && project ? plugin.indexer.getAll('location', project.root) : [];
	const resolveParentOf = (l: EntityRecord) =>
		l.parentLocation !== null ? plugin.indexer.resolve(l.parentLocation, l.path) : null;
	const parentLocation = isLocation ? resolveParentOf(record) : null;
	// Children follow the parent's drag-reordered `sublocationOrder`; entries
	// not (yet) in it append alphabetically.
	const sublocOrderIdx = new Map<string, number>(
		record.sublocationOrder
			.map((lp, i) => [plugin.indexer.resolve(lp, record.path)?.path, i] as const)
			.filter((e): e is [string, number] => e[0] !== undefined)
	);
	const sublocations = projectLocations
		.filter((l) => l.path !== record.path && resolveParentOf(l)?.path === record.path)
		.sort(
			(a, b) =>
				(sublocOrderIdx.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
					(sublocOrderIdx.get(b.path) ?? Number.MAX_SAFE_INTEGER) ||
				a.name.localeCompare(b.name)
		);
	const writeSublocationOrder = (ordered: EntityRecord[]) => {
		writeFm((fm) => {
			setLoomKey(fm, FM.sublocationOrder, ordered.map((s) => `[[${linkTargetOf(s)}]]`));
		});
	};
	const sublocSlotHeight = (): number => {
		const list = sublocListRef.current;
		if (!list || list.children.length < 2) return 28;
		const a = list.children[0] as HTMLElement;
		const b = list.children[1] as HTMLElement;
		return b.offsetTop - a.offsetTop || 28;
	};
	/** Slots a non-dragged row `i` slides to open/close the gap. The dragged
	 *  row itself rides the cursor (raw dy) instead — see the row style. */
	const sublocShift = (i: number): number => {
		if (!sublocDrag) return 0;
		const { from, over } = sublocDrag;
		if (i === from) return 0;
		if (from < i && i <= over) return -1;
		if (over <= i && i < from) return 1;
		return 0;
	};
	const endSublocDrag = (commit: boolean) => {
		sublocDragRef.current = null;
		const drag = sublocDrag;
		setSublocDrag(null);
		if (!commit || !drag || drag.from === drag.over) return;
		const next = [...sublocations];
		const [moved] = next.splice(drag.from, 1);
		next.splice(drag.over, 0, moved);
		writeSublocationOrder(next);
	};
	/** Detaching lives on the parent's page — the child's own page only shows
	 *  its parent as a link (no removal there). */
	const detachSublocation = (s: EntityRecord) => {
		const childFile = plugin.app.vault.getFileByPath(s.path);
		if (!childFile) return;
		void (async () => {
			try {
				await plugin.app.fileManager.processFrontMatter(childFile, (fm: Record<string, unknown>) => {
					for (const k of Object.keys(fm)) {
						const lower = k.toLowerCase();
						if (lower === 'loomparentlocation' || lower === 'parentlocation') delete fm[k];
					}
				});
				// Back to the top-level name (no parent).
				await renameLocationFile(s, undefined);
			} catch (e) {
				console.error('Loom Loom: failed to detach sublocation', e);
				new Notice('Could not detach the sublocation.');
			}
		})();
		writeSublocationOrder(sublocations.filter((o) => o.path !== s.path));
	};
	const descendsFromThis = (l: EntityRecord): boolean => {
		let cur: EntityRecord | null = l;
		for (let guard = 0; guard < 20 && cur !== null; guard++) {
			const parent: EntityRecord | null = resolveParentOf(cur);
			if (!parent) return false;
			if (parent.path === record.path) return true;
			cur = parent;
		}
		return false;
	};
	/** Renames a location's file to its managed name for `parentName` (undefined
	 *  = top-level). Obsidian updates the links. */
	const renameLocationFile = async (rec: EntityRecord, parentName: string | undefined) => {
		if (!project) return;
		const f = plugin.app.vault.getFileByPath(rec.path);
		if (!f) return;
		const base = entityFileName(project, 'location', rec.name, parentName);
		if (f.basename === base) return;
		const dir = f.parent?.path ?? '';
		let newPath = normalizePath(dir === '' ? `${base}.md` : `${dir}/${base}.md`);
		for (let i = 2; plugin.app.vault.getAbstractFileByPath(newPath) !== null; i++) {
			newPath = normalizePath(dir === '' ? `${base} ${i}.md` : `${dir}/${base} ${i}.md`);
		}
		try {
			await plugin.app.fileManager.renameFile(f, newPath);
		} catch (e) {
			console.error('Loom Loom: location rename failed', e);
		}
	};
	const setParentLocation = (target: string) => {
		const f = plugin.app.vault.getFileByPath(record.path);
		if (!f) return;
		void (async () => {
			await plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.parentLocation, `[[${target}]]`);
			});
			const parent = plugin.indexer.resolve(target, record.path);
			await renameLocationFile(record, parent?.type === 'location' ? parent.name : undefined);
		})();
	};
	/** "Turn to a sublocation": fuzzy-searchable picker over every other
	 *  location (including sublocations — the whole child hierarchy moves
	 *  along), minus this location's own descendants so a cycle can't be
	 *  built. A search, not a plain menu — projects can get huge. */
	const openTurnIntoPicker = () => {
		const candidates = projectLocations
			.filter((l) => l.path !== record.path && !descendsFromThis(l))
			.sort((a, b) => a.name.localeCompare(b.name));
		new RecordSuggestModal(
			plugin.app,
			candidates,
			(l) => setParentLocation(linkTargetOf(l)),
			'Pick the parent location…'
		).open();
	};

	// Faction members: dedicated character list, not relationships. The faction's
	// `members` frontmatter is the membership's only home — the character page's
	// "Member of" section edits the same entries, so both pages always agree.
	// Edits work on the raw list (plain links or { character, role } objects) so
	// roles survive adds/removes made from either side.
	const memberRecords =
		record.type === 'faction'
			? record.members
					.map((m) => plugin.indexer.resolve(m.linkpath, record.path))
					.filter((r): r is EntityRecord => r != null && r.type === 'character')
			: [];
	const projectCharacters =
		record.type === 'faction' && project ? plugin.indexer.getAll('character', project.root) : [];
	const editMembersOf = (faction: EntityRecord, apply: (arr: unknown[]) => unknown[]) =>
		editFmList(faction.path, FM.members, apply);
	/** Drops every raw entry that resolves to the given character. */
	const removeMemberEntry = (faction: EntityRecord, character: EntityRecord) =>
		editMembersOf(faction, (arr) =>
			arr.filter((item) => {
				const lp = memberEntryLinkpath(item);
				return !(lp !== null && plugin.indexer.resolve(lp, faction.path)?.path === character.path);
			})
		);

	// Character memberships, one row per faction whose members list holds this
	// character. Edits rewrite that faction's entry: a default "Member" with no
	// location stays a plain link; anything else becomes
	// { character, role?, location? } (only the non-default keys are written).
	const projectFactions =
		record.type === 'character' ? plugin.indexer.getAll('faction', record.project) : [];
	const membershipRows = projectFactions
		.flatMap((faction) =>
			faction.members
				.filter((m) => plugin.indexer.resolve(m.linkpath, faction.path)?.path === record.path)
				.map((m) => ({
					faction,
					role: m.role,
					location: m.location !== null ? plugin.indexer.resolve(m.location, faction.path) : null,
				}))
		)
		.sort((a, b) => a.faction.name.localeCompare(b.faction.name));
	const membershipLocations =
		record.type === 'character' ? plugin.indexer.getAll('location', record.project) : [];
	// Events shown on this page. For a location: every event placed here OR in
	// any descendant location (ancestor propagation) — via the note's `places`.
	// For other entities (character, item, faction): events whose `involved`
	// resolves to it. Newest session first, lore events last; hub-row rendered.
	const showsEvents =
		record.type === 'character' ||
		record.type === 'item' ||
		record.type === 'faction' ||
		record.type === 'location';
	const pageEventEntries: LocNoteEntry[] = showsEvents
		? plugin.indexer
				.getAll('event', record.project)
				.flatMap((owner) =>
					owner.sessionNotes
						.map((n, idx) => ({ owner, idx, session: n.session, text: n.text, seq: n.seq, involved: n.involved, places: n.places }))
						.filter((e) =>
							isLocation
								? e.places.some((lp) => {
										const p = plugin.indexer.resolve(lp, owner.path);
										return p?.type === 'location' && (p.path === record.path || descendsFromThis(p));
									})
								: e.involved.some((lp) => plugin.indexer.resolve(lp, owner.path)?.path === record.path)
						)
				)
			: [];
		// Grouped under one session chip per session; groups sort by session date
		// (newest/oldest first per the global setting, lore events always last),
		// and within a group events follow their loomSeq — the manual order shared
		// with the timeline and session page.
		const newestFirst = plugin.settings.notesNewestFirst;
		const pageEventGroups = (() => {
			const map = new Map<string, { session: EntityRecord | null; entries: LocNoteEntry[] }>();
			for (const e of pageEventEntries) {
				const ses = e.session !== null ? plugin.indexer.resolve(e.session, e.owner.path) : null;
				const session = ses?.type === 'session' ? ses : null;
				const key = session?.path ?? 'none';
				if (!map.has(key)) map.set(key, { session, entries: [] });
				map.get(key)?.entries.push(e);
			}
			for (const g of map.values())
				g.entries.sort((a, b) => (a.owner.seq ?? a.owner.created) - (b.owner.seq ?? b.owner.created));
			return [...map.values()].sort((a, b) => {
				const ka = a.session?.date?.sortKey;
				const kb = b.session?.date?.sortKey;
				if (ka === undefined && kb === undefined) return 0;
				if (ka === undefined) return 1; // lore last
				if (kb === undefined) return -1;
				return newestFirst ? kb - ka : ka - kb;
			});
		})();
		/** Flips the global newest/oldest-first order and refreshes open views. */
		const toggleNotesOrder = () => {
			plugin.settings.notesNewestFirst = !plugin.settings.notesNewestFirst;
			void plugin.saveSettings();
			plugin.indexer.refreshViews();
		};
		const orderToggle = (
			<button className="loom-rel-add loom-order-toggle" onClick={toggleNotesOrder}>
				<Icon name={newestFirst ? 'arrow-up-wide-narrow' : 'arrow-down-narrow-wide'} />
				{newestFirst ? 'New on top' : 'New on bottom'}
			</button>
		);
	const setMembershipField = (
		faction: EntityRecord,
		patch: { role?: string; location?: string | null }
	) => {
		editMembersOf(faction, (arr) =>
			arr.map((item) => {
				const lp = memberEntryLinkpath(item);
				if (lp === null || plugin.indexer.resolve(lp, faction.path)?.path !== record.path) return item;
				const obj = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
				const rawCharacter = typeof item === 'string' ? item : obj?.character;
				const character = typeof rawCharacter === 'string' ? rawCharacter : `[[${linkTargetOf(record)}]]`;
				const role = (
					patch.role ??
					(typeof obj?.role === 'string' ? obj.role : DEFAULT_MEMBER_ROLE)
				).trim();
				const location =
					patch.location !== undefined
						? patch.location === null
							? ''
							: `[[${patch.location}]]`
						: typeof obj?.location === 'string'
							? obj.location
							: '';
				const roleIsDefault = role === '' || role === DEFAULT_MEMBER_ROLE;
				if (roleIsDefault && location === '') return character;
				const next: Record<string, unknown> = { character };
				if (!roleIsDefault) next.role = role;
				if (location !== '') next.location = location;
				return next;
			})
		);
	};

	const writeOwnerNotes = (owner: EntityRecord, apply: (arr: unknown[]) => void) =>
		editFmList(owner.path, FM.sessionNotes, (arr) => {
			apply(arr);
		});


	// --- loomSeq drag-reorder (session-page events + quests) ------------------
	// Order lives in each entity's `loomSeq`, shared with the timeline, so a drop
	// re-stamps the whole list and re-indexing re-sorts every view that reads it.
	const writeRecordSeq = (path: string, seq: number) => {
		const f = plugin.app.vault.getFileByPath(path);
		if (!f) return;
		plugin.app.fileManager
			.processFrontMatter(f, (fm: Record<string, unknown>) => setLoomKey(fm, FM.seq, seq))
			.catch((e) => {
				console.error('Loom Loom: failed to save order', e);
				new Notice('Could not save the new order.');
			});
	};
	const seqShift = (group: string, i: number): number => {
		if (!seqDrag || seqDrag.group !== group) return 0;
		const { from, over } = seqDrag;
		if (i === from) return 0;
		if (from < i && i <= over) return -1;
		if (over <= i && i < from) return 1;
		return 0;
	};
	const seqRowStyle = (group: string, i: number): CSSProperties | undefined => {
		if (!seqDrag || seqDrag.group !== group) return undefined;
		const slot = seqDragRef.current?.slot ?? 40;
		if (seqDrag.from === i)
			return { transform: `translateY(${seqDrag.dy}px)`, position: 'relative', zIndex: 2 };
		const sh = seqShift(group, i);
		return sh !== 0 ? { transform: `translateY(${sh * slot}px)` } : undefined;
	};
	const endSeqDrag = (group: string, records: EntityRecord[], commit: boolean) => {
		seqDragRef.current = null;
		const drag = seqDrag;
		setSeqDrag(null);
		if (!commit || !drag || drag.group !== group || drag.from === drag.over) return;
		const next = [...records];
		const [moved] = next.splice(drag.from, 1);
		next.splice(drag.over, 0, moved);
		const base = Date.now();
		next.forEach((r, i) => writeRecordSeq(r.path, base + i));
	};
	/** The 6-dot grab handle placed before an entry's title. */
	const seqGrip = (group: string, i: number, records: EntityRecord[]) => (
		<span
			className="loom-subloc-grip"
			onPointerDown={(e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const rowEl = e.currentTarget.closest('[data-seq-row]');
				const row = rowEl instanceof HTMLElement ? rowEl : null;
				// Snapshot every row's center now, before anything slides; the target
				// index is then the count of centers the cursor has passed — the
				// sublocation trick, but per-row so it copes with varying heights.
				const rows = row?.parentElement
					? [...row.parentElement.querySelectorAll(':scope > [data-seq-row]')]
					: [];
				const mids = rows.map((r) => {
					const b = r.getBoundingClientRect();
					return b.top + b.height / 2;
				});
				// Slide distance = the grabbed block's own height + the inter-card gap
				// (--size-4-2), so neighbours open a gap that matches this row.
				seqDragRef.current = { startY: e.clientY, slot: (row?.offsetHeight ?? 40) + 8, mids };
				setSeqDrag({ group, from: i, over: i, dy: 0 });
			}}
			onPointerMove={(e) => {
				const start = seqDragRef.current;
				if (!start) return;
				const dy = e.clientY - start.startY;
				const over = Math.max(
					0,
					Math.min(records.length - 1, start.mids.filter((m) => m < e.clientY).length)
				);
				setSeqDrag((cur) => (cur && (cur.over !== over || cur.dy !== dy) ? { ...cur, over, dy } : cur));
			}}
			onPointerUp={() => endSeqDrag(group, records, true)}
			onPointerCancel={() => endSeqDrag(group, records, false)}
		>
			<Icon name="grip-vertical" />
		</span>
	);
	/** Grip for the quest-card grid (timeline-style). The grabbed card rides the
	 *  cursor; the drop slot is the reading-order index (grid read as one
	 *  continuous row) counted from a static rect snapshot. */
	const questGrip = (gkey: string, path: string, records: EntityRecord[]) => (
		<span
			className="loom-subloc-grip"
			onPointerDown={(e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const card = e.currentTarget.closest('[data-quest-card]');
				const cards = card?.parentElement
					? [...card.parentElement.querySelectorAll(':scope > [data-quest-card]')]
					: [];
				const rects: QuestRect[] = cards.map((c) => {
					const b = c.getBoundingClientRect();
					return { path: c.getAttribute('data-quest-path') ?? '', left: b.left, top: b.top, width: b.width, height: b.height };
				});
				const activeIdx = rects.findIndex((r) => r.path === path);
				const over = Math.max(0, activeIdx);
				questDragRef.current = { startX: e.clientX, startY: e.clientY, rects, over };
				setQuestDrag({ gkey, active: path, over, dx: 0, dy: 0 });
			}}
			onPointerMove={(e) => {
				const start = questDragRef.current;
				if (!start) return;
				const dx = e.clientX - start.startX;
				const dy = e.clientY - start.startY;
				const self = start.rects.find((r) => r.path === path);
				const rowH = self?.height ?? 120;
				// Grid read as one continuous row: count the other cards (row-major)
				// whose center the cursor has passed → linear insertion index.
				let over = 0;
				for (const r of start.rects) {
					if (r.path === path) continue;
					const cx = r.left + r.width / 2;
					const cy = r.top + r.height / 2;
					const sameRow = Math.abs(cy - e.clientY) <= rowH * 0.5;
					if (cy < e.clientY - rowH * 0.5 || (sameRow && cx < e.clientX)) over++;
				}
				start.over = over;
				setQuestDrag((cur) =>
					cur && cur.gkey === gkey && (cur.over !== over || cur.dx !== dx || cur.dy !== dy)
						? { ...cur, over, dx, dy }
						: cur
				);
			}}
			onPointerUp={() => {
				const ref = questDragRef.current;
				questDragRef.current = null;
				setQuestDrag(null);
				if (!ref) return;
				const rest = records.map((r) => r.path).filter((p) => p !== path);
				rest.splice(Math.max(0, Math.min(rest.length, ref.over)), 0, path);
				const base = Date.now();
				rest.forEach((p, i) => writeRecordSeq(p, base + i));
			}}
			onPointerCancel={() => {
				questDragRef.current = null;
				setQuestDrag(null);
			}}
		>
			<Icon name="grip-vertical" />
		</span>
	);

	// Session pages are hubs: every note in the project pinned to this session,
	// editable here (writes go to the owning note's file), plus quest states
	// AS OF this session's date.
	const hubEntries: LocNoteEntry[] = isSession
		? plugin.indexer
				.getAll(undefined, record.project)
				.flatMap((owner) =>
					owner.sessionNotes
						.map((n, idx) => ({ owner, idx, session: n.session, text: n.text, seq: n.seq, involved: n.involved, places: n.places }))
						.filter(
							(e) =>
								e.session !== null &&
								plugin.indexer.resolve(e.session, owner.path)?.path === record.path
						)
				)
				.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
		: [];
	// Involve targets for the hub event rows — populated for every page that
	// renders them (session hub + the Events section on character/item/faction/
	// location pages), not just sessions/characters.
	const hubTargets =
		(isSession || showsEvents) && project
			? plugin.indexer
					.getAll(undefined, project.root)
					.filter((r) => r.type !== 'session' && r.type !== 'event')
					.sort((a, b) => a.name.localeCompare(b.name))
			: [];
	/** The note's involved entities, resolved and grouped by type then name. */
	const involvedOfEntry = (en: LocNoteEntry) =>
		en.involved
			.map((lp) => ({ lp, target: plugin.indexer.resolve(lp, en.owner.path) }))
			.sort(
				(a, b) =>
					(a.target ? ENTITY_TYPES.indexOf(a.target.type) : 99) -
						(b.target ? ENTITY_TYPES.indexOf(b.target.type) : 99) ||
					(a.target?.name ?? a.lp).localeCompare(b.target?.name ?? b.lp)
			);
	const writeEntryInvolved = (en: LocNoteEntry, apply: (list: unknown[]) => unknown[]) => {
		writeOwnerNotes(en.owner, (arr) => {
			const item = arr[en.idx];
			if (typeof item === 'object' && item !== null) {
				const cur = (item as { involved?: unknown }).involved;
				(item as { involved?: unknown }).involved = apply(Array.isArray(cur) ? cur : []);
			}
		});
	};
	const writeEntryPlaces = (en: LocNoteEntry, apply: (list: unknown[]) => unknown[]) => {
		writeOwnerNotes(en.owner, (arr) => {
			const item = arr[en.idx];
			if (typeof item === 'object' && item !== null) {
				const cur = (item as { places?: unknown }).places;
				(item as { places?: unknown }).places = apply(Array.isArray(cur) ? cur : []);
			}
		});
	};
	const involveTargets = project
		? plugin.indexer
				.getAll(undefined, project.root)
				.filter((r) => r.type !== 'session' && r.type !== 'event' && r.type !== 'location' && r.path !== record.path)
				.sort((a, b) => a.name.localeCompare(b.name))
		: [];
	const writeOwnerRels = (owner: EntityRecord, apply: (rels: unknown[]) => unknown[]) =>
		editFmList(owner.path, FM.relationships, apply);
	/** Renames another entity in place (hub rows): stores the entered name as
	 *  its loomName + alias and moves the file to its managed name. */
	const renameEntity = (owner: EntityRecord, raw: string) => {
		const entered = raw.trim();
		if (entered === '' || entered === owner.name || !project) return;
		const f = plugin.app.vault.getFileByPath(owner.path);
		if (!f) return;
		const base = entityFileName(project, owner.type, entered);
		const parent = f.parent?.path ?? '';
		const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
		if (newPath !== f.path && plugin.app.vault.getAbstractFileByPath(newPath)) {
			new Notice('A note with that name already exists.');
			return;
		}
		void plugin.app.fileManager
			.processFrontMatter(f, (fm: Record<string, unknown>) => {
				setLoomKey(fm, FM.name, entered);
				const aliases: unknown[] = Array.isArray(fm.aliases)
					? (fm.aliases as unknown[]).filter((a) => a !== owner.name && a !== entered)
					: [];
				fm.aliases = [entered, ...aliases];
			})
			.then(() => (newPath !== f.path ? plugin.app.fileManager.renameFile(f, newPath) : undefined))
			.catch((e) => {
				console.error('Loom Loom: failed to rename entity', e);
				new Notice('Could not rename the entity.');
			});
	};
	const asOf = record.date?.sortKey ?? Number.MAX_SAFE_INTEGER;
	const sessionQuests = (isSession && project ? plugin.indexer.getAll('quest', project.root) : [])
		.map((q) => {
			const rec = q.questReceived !== null ? plugin.indexer.resolve(q.questReceived, q.path) : null;
			if (rec?.date && rec.date.sortKey > asOf) return null; // not yet received then
			const out =
				q.questOutcomeSession !== null
					? plugin.indexer.resolve(q.questOutcomeSession, q.path)
					: null;
			const finished = q.questOutcome !== '' && out?.date !== undefined && out.date !== null && out.date.sortKey <= asOf;
			return { quest: q, state: finished ? 'finished' : 'active' };
		})
		.filter((e): e is { quest: EntityRecord; state: string } => e !== null)
		// Manual order (drag-reorderable), then chronological for the unstamped.
		.sort((a, b) => (a.quest.seq ?? a.quest.created) - (b.quest.seq ?? b.quest.created));

	// PC life state: unticking Alive reveals the death-session picker.
	const isPc = record.type === 'character' && record.loomTags.includes(PC_TAG);
	const deathSession =
		record.deathSession !== null ? plugin.indexer.resolve(record.deathSession, record.path) : null;
	const clearDeathKey = (fm: Record<string, unknown>) => {
		for (const k of Object.keys(fm)) {
			const lower = k.toLowerCase();
			if (lower === 'loomdeathsession' || lower === 'deathsession') delete fm[k];
		}
	};
	const setAlive = (alive: boolean) => {
		writeFm((fm) => {
			setLoomKey(fm, FM.alive, alive);
			if (alive) clearDeathKey(fm);
		});
	};
	const setDeathSession = (target: string | null) => {
		writeFm((fm) => {
			if (target === null) clearDeathKey(fm);
			else setLoomKey(fm, FM.deathSession, `[[${target}]]`);
		});
	};

	const toggleTag = (tag: string) => {
		const next = record.loomTags.includes(tag)
			? record.loomTags.filter((t) => t !== tag)
			: [...record.loomTags, tag];
		writeFm((fm) => {
			// Also migrates notes still carrying the key's pre-rename spelling.
			setLoomKey(fm, FM.tags, next);
		});
	};

	// Relationship rows group under a subheader per target entity type; targets
	// that don't resolve to a project entity (including still-empty new rows)
	// stay at the bottom, ungrouped. A subheader only exists once it has rows.
	const relEntries = relationships.map((rel, i) => ({
		rel,
		i,
		entityType: resolveDraftTarget(rel.target)?.type ?? null,
	}));

	const setRowFilter = (i: number, filter: EntityType | null) => {
		const next = [...relationships];
		next[i] = { ...next[i], filter };
		setRelationships(next);
	};

	const openRelFilterMenu = (e: ReactMouseEvent<HTMLButtonElement>, i: number) => {
		const current = relationships[i]?.filter ?? null;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('All entities')
				.setIcon('filter')
				.setChecked(current === null)
				.onClick(() => setRowFilter(i, null))
		);
		for (const t of ENTITY_TYPES) {
			menu.addItem((item) =>
				item
					.setTitle(ENTITY_META[t].plural)
					.setIcon(ENTITY_META[t].icon)
					.setChecked(current === t)
					.onClick(() => setRowFilter(i, t))
			);
		}
		menu.showAtMouseEvent(e.nativeEvent);
	};

	const relRow = (rel: RelationshipDraft, i: number) => (
		<div key={i} className="loom-rel-row">
			<input
				type="text"
				className="loom-rel-type"
				placeholder="Identifier"
				value={rel.type}
				onChange={(e) => {
					const next = [...relationships];
					next[i] = { ...rel, type: e.target.value };
					setRelationships(next);
				}}
				onBlur={() => commitRelationships(relationships)}
			/>
			<div className="loom-rel-targetbox">
				<SuggestInput
				className="loom-rel-target"
				placeholder={rel.filter ? `${ENTITY_META[rel.filter].label} note` : 'Target note'}
				value={rel.target}
				options={targetRecords
					.filter((r) => !rel.filter || r.type === rel.filter)
					.map((r) => draftLabel(r))
					.sort((a, b) => a.localeCompare(b))}
				onChange={(v) => {
					const next = [...relationships];
					next[i] = { ...rel, target: v };
					setRelationships(next);
				}}
				onPick={(v) => {
					const next = [...relationships];
					next[i] = { ...rel, target: v };
					commitRelationships(next);
				}}
				onBlur={() => commitRelationships(relationships)}
				action={
					project
						? {
								label: '+ Create entity…',
								onPick: () =>
									new EntityTypeSuggestModal(plugin, (type) =>
										new CreateEntityModal(plugin, type, project, {
											onCreated: (created) => {
												const next = [...relationships];
												next[i] = { ...rel, target: created.basename };
												commitRelationships(next);
											},
										}).open()
									).open(),
							}
						: undefined
				}
			/>
				<button
				className="loom-rel-filter"
				aria-label="Filter suggestions by entity type"
				onClick={(e) => openRelFilterMenu(e, i)}
			>
				<Icon name={rel.filter ? ENTITY_META[rel.filter].icon : 'filter'} />
			</button>
			</div>
			<button
				className="loom-nav-btn"
				aria-label="Remove relationship"
				onClick={() => {
					const remove = () => commitRelationships(relationships.filter((_, j) => j !== i));
					// A still-empty new row goes silently; a filled one asks first.
					if (rel.target.trim() === '') remove();
					else {
						new ConfirmModal(
							plugin.app,
							'Remove relationship?',
							`Removes "${rel.type.trim() === '' ? 'related' : rel.type.trim()}" → ${rel.target.trim()}.`,
							remove,
							'Remove'
						).open();
					}
				}}
			>
				✕
			</button>
		</div>
	);

	// One session-scoped note: session picker on the left (chip once picked),
	// note text on the right. Picking the session commits immediately, which is
	// what connects the entity to it; the text commits on blur like other fields.
	// The picker column is narrow, so dates always use the compact form here.
	const shortSessionLabel = (s: EntityRecord) =>
		s.date && project ? formatLoomDateShort(s.date, project.config) : s.name;
	const sessionNoteRow = (note: SessionNoteDraft, i: number) => {
		const picked =
			note.session.trim() !== '' ? plugin.indexer.resolve(note.session.trim(), record.path) : null;
		// Quests and events carry a per-note location in the note's own `places`
		// (picked right of Involve). Legacy event-level `location` relationships
		// are still shown (and removable) so older notes don't lose their place.
		const hasNoteLocation = record.type === 'quest' || record.type === 'event';
		const noteLocs: { key: string; target: EntityRecord | null; remove: () => void }[] = hasNoteLocation
			? [
					...note.places
						.map((lp) => ({
							key: 'p:' + lp,
							target: plugin.indexer.resolve(lp, record.path),
							remove: () => setNote({ places: note.places.filter((v) => v !== lp) }, true),
						}))
						.filter((e) => e.target?.type === 'location'),
					...relationships
						.map((rel, ri) => ({ rel, ri, target: resolveDraftTarget(rel.target) }))
						.filter((e) => e.rel.type.trim().toLowerCase() === 'location' && e.target?.type === 'location')
						.map(({ rel, ri, target }) => ({
							key: 'r:' + rel.target + String(ri),
							target,
							remove: () => commitRelationships(relationships.filter((_, j) => j !== ri)),
						})),
				]
			: [];
		// A session already carrying a note isn't offered again.
		const takenSessions = new Set(
			sessionNotes
				.filter((_, j) => j !== i)
				.map((n) =>
					n.session.trim() !== '' ? plugin.indexer.resolve(n.session.trim(), record.path)?.path : undefined
				)
				.filter((p): p is string => p !== undefined)
		);
		const setNote = (patch: Partial<SessionNoteDraft>, commit: boolean) => {
			const next = [...sessionNotes];
			next[i] = { ...note, ...patch };
			if (commit) commitSessionNotes(next);
			else setSessionNotes(next);
		};
		return (
			<div key={i} className="loom-note-row" onBlur={() => commitSessionNotes(sessionNotes)}>
				<div className="loom-note-head">
				<div className="loom-note-session">
					{picked && picked.type === 'session' ? (
						<div className="loom-tag-row">
							<EntityChip
								plugin={plugin}
								record={picked}
								label={shortSessionLabel(picked)}
								onOpen={() => view.openEntity(picked.path)}
								onRemove={() => setNote({ session: '' }, true)}
								removeLabel="Clear session"
							/>
						</div>
					) : (
						<SearchableSelect
							placeholder="Pick a session…"
							options={sessionsByDate
								.filter((s) => s.path !== record.path && !takenSessions.has(s.path))
								.map((s) => ({ value: linkTargetOf(s), label: shortSessionLabel(s) }))}
							onPick={(name) => setNote({ session: name }, true)}
							action={
								project
									? {
											label: '+ New session…',
											onPick: () =>
												new CreateEntityModal(plugin, 'session', project, {
													onCreated: (created) => setNote({ session: created.basename }, true),
												}).open(),
										}
									: undefined
							}
						/>
					)}
				</div>
			<div className="loom-hub-col">
					<div className="loom-hub-involve">
						<SearchableSelect
							placeholder="Involve…"
							options={involveTargets
								.filter((t) => !note.involved.includes(linkTargetOf(t)))
								.filter((t) => !hubFilter['row:' + String(i)] || t.type === hubFilter['row:' + String(i)])
								.map((t) => ({ value: linkTargetOf(t), label: t.name }))}
							onPick={(name) => setNote({ involved: [...note.involved, name] }, true)}
							action={
								project
									? {
											label: '+ Create new entity',
											onPick: () =>
												new EntityTypeSuggestModal(plugin, (type) =>
													new CreateEntityModal(plugin, type, project, {
														onCreated: (created) =>
															setNote({ involved: [...note.involved, created.basename] }, true),
													}).open()
												).open(),
										}
									: undefined
							}
						/>
						<button
							className="loom-rel-filter"
							aria-label="Filter suggestions by entity type"
							onClick={(e) => {
								const menu = new Menu();
								const fkey = 'row:' + String(i);
								const current = hubFilter[fkey] ?? null;
								menu.addItem((item) =>
									item
										.setTitle('All entities')
										.setIcon('filter')
										.setChecked(current === null)
										.onClick(() => setHubFilter({ ...hubFilter, [fkey]: null }))
								);
								for (const t of ENTITY_TYPES.filter((t) => t !== 'session' && t !== 'event' && t !== 'location')) {
									menu.addItem((item) =>
										item
											.setTitle(ENTITY_META[t].plural)
											.setIcon(ENTITY_META[t].icon)
											.setChecked(current === t)
											.onClick(() => setHubFilter({ ...hubFilter, [fkey]: t }))
									);
								}
								menu.showAtMouseEvent(e.nativeEvent);
							}}
						>
							<Icon
								name={hubFilter['row:' + String(i)] ? ENTITY_META[hubFilter['row:' + String(i)] as EntityType].icon : 'filter'}
							/>
						</button>
					</div>
					{note.involved.length > 0 ? (
						<div className="loom-tag-row">
							{note.involved
								.map((lp) => ({ lp, target: plugin.indexer.resolve(lp, record.path) }))
								.sort(
									(a, b) =>
										(a.target ? ENTITY_TYPES.indexOf(a.target.type) : 99) -
											(b.target ? ENTITY_TYPES.indexOf(b.target.type) : 99) ||
										(a.target?.name ?? a.lp).localeCompare(b.target?.name ?? b.lp)
								)
								.map(({ lp, target }, ii) => (
									<EntityChip
										key={lp + String(ii)}
										plugin={plugin}
										record={target}
										label={target?.name ?? lp}
										onOpen={target ? () => view.openEntity(target.path) : undefined}
										onRemove={() => setNote({ involved: note.involved.filter((v) => v !== lp) }, true)}
										removeLabel="Remove involved entity"
									/>
								))}
						</div>
					) : null}
					</div>
					{hasNoteLocation ? (
						<div className="loom-hub-col">
						<div className="loom-hub-location">
							<SearchableSelect
								placeholder="Location…"
								options={(project ? plugin.indexer.getAll('location', project.root) : [])
									.filter((l) => !noteLocs.some((q) => q.target?.path === l.path))
									.sort((a, b) => a.name.localeCompare(b.name))
									.map((l) => ({ value: linkTargetOf(l), label: locationLabel(l, plugin) }))}
								onPick={(name) => setNote({ places: [...note.places, name] }, true)}
								action={
									project
										? {
												label: '+ Create new location',
												onPick: () =>
													new CreateEntityModal(plugin, 'location', project, {
														onCreated: (created) =>
															setNote({ places: [...note.places, created.basename] }, true),
													}).open(),
											}
										: undefined
								}
							/>
						</div>
						{noteLocs.length > 0 ? (
							<div className="loom-tag-row">
								{noteLocs.map(({ key, target, remove }) => (
									<EntityChip
										key={key}
										plugin={plugin}
										record={target}
										label={target?.name ?? key}
										onOpen={target ? () => view.openEntity(target.path) : undefined}
										onRemove={remove}
										removeLabel="Remove location"
									/>
								))}
							</div>
						) : null}
						</div>
					) : null}
								<button
					className="loom-nav-btn loom-note-remove loom-entity-delete"
					aria-label="Delete session note"
					onClick={() => {
						const remove = () => commitSessionNotes(sessionNotes.filter((_, j) => j !== i));
						// Only a note that actually holds text needs a confirmation.
						if (note.text.trim() === '') remove();
						else {
							new ConfirmModal(
								plugin.app,
								'Delete this session note?',
								'The note text will be lost.',
								remove,
								'Delete'
							).open();
						}
					}}
				>
					<Icon name="trash-2" />
				</button>
				</div>
			{isLocation ? (
					<div className="loom-tag-row">
						{note.places.map((pl, pi) => (
							<EntityChip
								key={pl}
								plugin={plugin}
								record={plugin.indexer.resolve(pl, record.path)}
								label={pl}
								onRemove={() => setNote({ places: note.places.filter((_, j) => j !== pi) }, true)}
								removeLabel="Remove place"
							/>
						))}
						<SearchableSelect
							placeholder="Add a place…"
							options={projectLocations
								.filter((l) => l.path !== record.path && !note.places.includes(linkTargetOf(l)))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((l) => ({ value: linkTargetOf(l), label: locationLabel(l, plugin) }))}
							onPick={(name) => setNote({ places: [...note.places, name] }, true)}
						/>
					</div>
				
				) : null}
				<div className="loom-note-text">
					<MarkdownField
						app={plugin.app}
						value={note.text}
						names={linkNames}
						onOpenLink={openLinkTarget}
						onCreateEntity={createLinkEntity}
						onChange={(v) => setNote({ text: v }, false)}
					/>
				</div>
			</div>
		);
	};

	// One hub-style row for an entity's session note: editable name + actions,
	// then an Involve column and a Location column (each picker with its chips
	// right below), then the note text. Shared by session pages (every note
	// pinned to the session) and character pages (events involving the
	// character, nested under per-session group chips). Removing the page's
	// own character from involved warns first: the event disappears from the
	// page with it.
	const hubEntryRow = (
		en: LocNoteEntry,
		grip?: ReactNode,
		style?: CSSProperties,
		dragging?: boolean,
		index?: number
	) => {
		const menuKey = en.owner.path + String(en.idx);
		const involved = involvedOfEntry(en);
		// A note's location(s) live per-note in `places`; legacy event-level
		// `location` relationships are still shown/removable for older notes.
		const locs: { key: string; target: EntityRecord | null; remove: () => void }[] = [
			...en.places
				.map((lp) => ({
					key: 'p:' + lp,
					target: plugin.indexer.resolve(lp, en.owner.path),
					remove: () =>
						writeEntryPlaces(en, (list) =>
							list.filter((x) => !(typeof x === 'string' && extractLinkpath(x) === lp))
						),
				}))
				.filter((e) => e.target?.type === 'location'),
			...en.owner.relationships
				.map((rel) => ({ rel, target: plugin.indexer.resolve(rel.linkpath, en.owner.path) }))
				.filter((e) => e.rel.type.trim().toLowerCase() === 'location' && e.target?.type === 'location')
				.map(({ rel, target }) => ({
					key: 'r:' + rel.linkpath,
					target,
					remove: () =>
						writeOwnerRels(en.owner, (rels) => {
							const i = rels.findIndex(
								(r) =>
									typeof r === 'object' &&
									r !== null &&
									(r as { target?: unknown }).target === rel.targetRaw &&
									(r as { type?: unknown }).type === rel.type
							);
							if (i >= 0) rels.splice(i, 1);
							return rels;
						}),
				})),
		];
		return (
			<div
				key={menuKey}
				className={dragging ? 'loom-locnote loom-locnote-dragging' : 'loom-locnote'}
				style={style}
				{...(grip ? { 'data-seq-row': '', 'data-seq-index': index } : {})}
			>
				{grip}
				<div className="loom-locnote-body">
				<div className="loom-locnote-head">
					<input
						type="text"
						className="loom-hub-name"
						defaultValue={en.owner.name}
						onBlur={(e) => renameEntity(en.owner, e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') renameEntity(en.owner, e.currentTarget.value);
						}}
					/>
					<button
						className="loom-nav-btn"
						aria-label="Open page"
						onClick={() => view.openEntity(en.owner.path)}
					>
					→
					</button>
					<div className="loom-shell-spacer" />
					<div
						className={
							hubMenu === menuKey ? 'loom-hub-actions loom-hub-actions-open' : 'loom-hub-actions'
						}
					>
						<button
							className="loom-nav-btn loom-entity-delete"
							aria-label="Delete this entity"
							onClick={() =>
								new ConfirmModal(
									plugin.app,
									`Delete "${en.owner.name}"?`,
									'The note is moved to the trash.',
									() => {
										const f = plugin.app.vault.getFileByPath(en.owner.path);
										if (f) void plugin.app.fileManager.trashFile(f);
									},
									'Delete'
								).open()
							}
						>
							<Icon name="trash-2" />
						</button>
						{isSession ? (
							// Session page: unpin the note from THIS session (clears its
							// session link) — the note itself stays, just dateless.
							<button
								className="loom-nav-btn"
								aria-label="Remove from this note"
								onClick={() =>
									new ConfirmModal(
										plugin.app,
										'Remove this note from the session?',
										"It will clear the current session date in the note and it won't be displayed here anymore.",
										() =>
											writeOwnerNotes(en.owner, (arr) => {
												const item = arr[en.idx];
												if (typeof item === 'object' && item !== null)
													(item as { session?: unknown }).session = '';
											}),
										'Remove'
									).open()
								}
							>
								✕
							</button>
						) : (
							// Entity page: drop this page's entity from the note — from the
							// note's `involved`, or its `places` for a location page — so the
							// event stops showing here while the note itself survives.
							<button
								className="loom-nav-btn"
								aria-label="Remove from this note"
								onClick={() =>
									new ConfirmModal(
										plugin.app,
										'Remove from this note?',
										`If you remove ${record.name} from ${en.owner.name}, this event won't be displayed here anymore.`,
										() => {
											if (isLocation) {
												writeEntryPlaces(en, (list) =>
													list.filter((x) => {
														if (typeof x !== 'string') return true;
														const loc = plugin.indexer.resolve(extractLinkpath(x) ?? '', en.owner.path);
														return !(loc && (loc.path === record.path || descendsFromThis(loc)));
													})
												);
											} else {
												writeEntryInvolved(en, (list) =>
													list.filter(
														(x) =>
															!(
																typeof x === 'string' &&
																plugin.indexer.resolve(extractLinkpath(x) ?? '', en.owner.path)?.path ===
																	record.path
															)
													)
												);
											}
										},
										'Remove'
									).open()
								}
							>
								✕
							</button>
						)}
					</div>
					<button
						className="loom-nav-btn"
						aria-label={hubMenu === menuKey ? 'Close actions' : 'Show actions'}
						onClick={() => setHubMenu(hubMenu === menuKey ? null : menuKey)}
					>
						{hubMenu === menuKey ? '>' : '<'}
					</button>
				</div>
				<div className="loom-hub-involve-row loom-hub-location-row">
					<div className="loom-hub-col">
						<div className="loom-hub-involve">
							<SearchableSelect
							placeholder="Involve…"
					options={hubTargets
								.filter((t) => t.type !== 'location')
								.filter((t) => !involved.some((iv) => iv.target?.path === t.path))
								.filter((t) => !hubFilter[menuKey] || t.type === hubFilter[menuKey])
								.map((t) => ({ value: linkTargetOf(t), label: t.name }))}
							onPick={(name) =>
								writeEntryInvolved(en, (list) => {
									list.push(`[[${name}]]`);
									return list;
								})
							}
							action={
								project
									? {
											label: '+ Create new entity',
											onPick: () =>
												new EntityTypeSuggestModal(plugin, (type) =>
													new CreateEntityModal(plugin, type, project, {
														onCreated: (created) =>
															writeEntryInvolved(en, (list) => [...list, `[[${created.basename}]]`]),
													}).open()
												).open(),
										}
									: undefined
							}
						/>
							<button
							className="loom-rel-filter"
							aria-label="Filter suggestions by entity type"
							onClick={(e) => {
								const menu = new Menu();
								const current = hubFilter[menuKey] ?? null;
								menu.addItem((item) =>
									item
										.setTitle('All entities')
										.setIcon('filter')
										.setChecked(current === null)
										.onClick(() => setHubFilter({ ...hubFilter, [menuKey]: null }))
								);
								for (const t of ENTITY_TYPES.filter((t) => t !== 'session' && t !== 'event' && t !== 'location')) {
									menu.addItem((item) =>
										item
											.setTitle(ENTITY_META[t].plural)
											.setIcon(ENTITY_META[t].icon)
											.setChecked(current === t)
											.onClick(() => setHubFilter({ ...hubFilter, [menuKey]: t }))
									);
								}
								menu.showAtMouseEvent(e.nativeEvent);
							}}
						>
							<Icon
								name={hubFilter[menuKey] ? ENTITY_META[hubFilter[menuKey]].icon : 'filter'}
							/>
						</button>
						</div>
						{involved.length > 0 ? (
							<div className="loom-tag-row">
								{involved.map(({ lp, target }, ii) => (
									<EntityChip
										key={lp + String(ii)}
										plugin={plugin}
										record={target}
										label={target?.name ?? lp}
										onOpen={target ? () => view.openEntity(target.path) : undefined}
										onRemove={() => {
											const doRemove = () =>
												writeEntryInvolved(en, (list) => {
													const ri = list.findIndex(
														(r) => typeof r === 'string' && extractLinkpath(r) === lp
													);
													if (ri >= 0) list.splice(ri, 1);
													return list;
												});
											// Removing the page's own character unlists the
											// event from this page — warn before it vanishes.
											if (target && target.path === record.path) {
												new ConfirmModal(
													plugin.app,
													'Remove from involved?',
													`If you remove ${target.name} from ${en.owner.name}, this event won't be displayed here anymore.`,
													doRemove,
													'Remove'
												).open();
											} else doRemove();
										}}
										removeLabel="Remove involved entity"
									/>
								))}
							</div>
						) : null}
					</div>
					<div className="loom-hub-col">
						<div className="loom-hub-location">
						<SearchableSelect
							placeholder="Location…"
							options={(project ? plugin.indexer.getAll('location', project.root) : [])
								.filter((t) => !locs.some((l) => l.target?.path === t.path))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((t) => ({ value: linkTargetOf(t), label: locationLabel(t, plugin) }))}
							onPick={(name) => writeEntryPlaces(en, (list) => [...list, `[[${name}]]`])}
							action={
								project
									? {
											label: '+ Create new location',
											onPick: () =>
												new CreateEntityModal(plugin, 'location', project, {
													onCreated: (created) =>
														writeEntryPlaces(en, (list) => [...list, `[[${created.basename}]]`]),
												}).open(),
										}
									: undefined
							}
					/>
						</div>
						{locs.length > 0 ? (
							<div className="loom-tag-row">
								{locs.map(({ key, target, remove }) => (
									<EntityChip
										key={key}
										plugin={plugin}
										record={target}
										label={target?.name ?? key}
										onOpen={target ? () => view.openEntity(target.path) : undefined}
										onRemove={() => {
											// Removing the place that surfaces this event here — this
											// location OR a descendant shown by ancestor propagation —
											// unlists the event from this page. Warn either way.
											if (
												isLocation &&
												target &&
												(target.path === record.path || descendsFromThis(target))
											) {
												new ConfirmModal(
													plugin.app,
													'Remove from this location?',
													`If you remove ${target.name} from ${en.owner.name}, this event won't be displayed here anymore.`,
													remove,
													'Remove'
												).open();
											} else remove();
										}}
										removeLabel="Remove location"
									/>
								))}
							</div>
						) : null}
					</div>
				</div>
				<div className="loom-note-text">
					<HubNoteText
						app={plugin.app}
						initial={en.text}
						names={linkNames}
						onOpenLink={openLinkTarget}
						onCreateEntity={createLinkEntity}
						onCommit={(v) =>
							writeOwnerNotes(en.owner, (arr) => {
								const item = arr[en.idx];
								if (typeof item === 'object' && item !== null) {
									(item as { text?: unknown }).text = v;
								}
							})
						}
					/>
				</div>
				</div>
			</div>
		);
	};

	return (
		<div className="loom-entity-row">
			{project ? <NavRail navigator={view} project={project} /> : null}
			<div className="loom-entity">
			<div className="loom-entity-header">
				{/* Greyed out when there is nowhere to return (e.g. the page
				    was opened right after creating the entity). */}
				<button
					className="loom-nav-btn"
					disabled={!view.origin}
					onClick={() => {
						const origin = view.origin;
						if (origin) view.navigateTo(origin.type, origin.state);
					}}
				>
					← Back
				</button>
			<span
					className="loom-chip"
					style={{
						background: plugin.settings.nodeColors[record.type] + '40',
						border: `1px solid ${plugin.settings.nodeColors[record.type]}`,
					}}
				>
					{ENTITY_META[record.type].label}
				</span>
				<div className="loom-shell-spacer" />
				{isLocation && record.parentLocation === null && project ? (
					<button className="loom-nav-btn" onClick={openTurnIntoPicker}>
						Turn to a sublocation
					</button>
				) : null}
			<button
					className="loom-rel-filter"
					aria-label="Open as markdown"
					onClick={() => view.navigateTo('markdown', { file: file.path })}
				>
					<Icon name="file-type" />
				</button>
			<button
					className="loom-rel-filter loom-entity-delete"
					aria-label="Delete"
					onClick={() =>
						new ConfirmModal(
							plugin.app,
							`Delete "${recordLabel(record, project)}"?`,
							'The note is moved to the trash.',
							() => {
								// Leave the page first so the view never sits on a
								// trashed file, then delete.
								const origin = view.origin;
								if (origin) view.navigateTo(origin.type, origin.state);
								else if (project) {
									view.navigateTo(VIEW_LIST, { project: project.root, entityType: record.type });
								}
								void plugin.app.fileManager.trashFile(file);
							},
							'Delete'
						).open()
					}
				>
					<Icon name="trash-2" />
				</button>
			</div>

			{!isSession ? (
				<div className="loom-field">
					<div className="loom-name-alias-row">
						<label className="loom-name-col">
							<span className="loom-field-label">Name</span>
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								onBlur={() => void commitName()}
								onKeyDown={(e) => {
									if (e.key === 'Enter') void commitName();
								}}
							/>
						</label>
						<div className="loom-alias-col">
							<span className="loom-field-label">Aliases</span>
							<div className="loom-alias-box">
								<input
									type="text"
									placeholder="Add alias"
									value={aliasDraft}
									onChange={(e) => setAliasDraft(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') addAlias();
									}}
								/>
								<button className="loom-rel-filter loom-alias-add" aria-label="Add alias" onClick={addAlias}>
									<Icon name="plus" />
								</button>
							</div>
						</div>
					</div>
					{extraAliases.length > 0 ? (
						<div className="loom-tag-row">
							{extraAliases.map((alias) => (
								<EntityChip
									key={alias}
									plugin={plugin}
									record={null}
									label={alias}
									onRemove={() => removeAlias(alias)}
									removeLabel="Remove alias"
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{/* Plain link, no detach here — a sublocation is released from its
			    parent's page, not its own. */}
			{isLocation && record.parentLocation !== null ? (
				<div className="loom-field">
					<span className="loom-field-label">Sublocation of</span>
					{parentLocation ? (
						<button className="loom-subloc-link" onClick={() => view.openEntity(parentLocation.path)}>
							{parentLocation.name}
						</button>
					) : (
						<span>{record.parentLocation}</span>
					)}
				</div>
			) : null}

			{isSession ? (
				<label className="loom-field">
					<span className="loom-field-label">Date</span>
					<input
						type="date"
						value={date}
						onChange={(e) => {
							setDate(e.target.value);
							void commitDate(e.target.value);
						}}
					/>
				</label>
			) : null}

			{record.type === 'event' ? (
				<label className="loom-field">
					<span className="loom-field-label">Date</span>
					<input
						type="text"
						placeholder="Not specified"
						value={date}
						onChange={(e) => setDate(e.target.value)}
						onBlur={() => void commitDate()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void commitDate();
						}}
					/>
					<span
						className="loom-today-link"
						role="button"
						tabIndex={0}
						onClick={() => {
							const today = todayRaw();
							setDate(today);
							void commitDate(today);
						}}
						onKeyDown={(e) => {
							if (e.key !== 'Enter' && e.key !== ' ') return;
							e.preventDefault();
							const today = todayRaw();
							setDate(today);
							void commitDate(today);
						}}
					>
						@today
					</span>
				</label>
			) : null}

			{isSession ? (
				<div className="loom-field">
					<span className="loom-field-label">Attendance</span>
					{attendancePcs.length > 0 ? (
						<div className="loom-tag-row">
							{attendancePcs.map((c) => (
								<button
									key={c.path}
									className={attendingPaths.has(c.path) ? 'loom-chip loom-chip-on' : 'loom-chip'}
									onClick={() => toggleAttendance(c)}
								>
									{c.name}
								</button>
							))}
						</div>
					) : (
						<div className="loom-attendance-empty">No PC characters in this project yet.</div>
					)}
				</div>
			) : null}


			{isSession && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Quests</span>
					{(['active', 'finished'] as const).map((state) => {
						const outcomeKey = (q: EntityRecord) =>
							q.questOutcomeSession
								? plugin.indexer.resolve(q.questOutcomeSession, q.path)?.date?.sortKey ?? 0
								: 0;
						// Active: manual loomSeq order (from sessionQuests). Finished: most
						// recently finished on top (by outcome session date) — no reorder.
						const list =
							state === 'finished'
								? sessionQuests
										.filter((q) => q.state === state)
										.slice()
										.sort((a, b) => outcomeKey(b.quest) - outcomeKey(a.quest))
								: sessionQuests.filter((q) => q.state === state);
						const open = questsOpen[state];
						const gkey = 'quest-' + state;
						const reorderable = state === 'active';
						const questRecords = list.map((x) => x.quest);
						return (
							<div key={state} className="loom-section">
								<button
									className="loom-section-header"
									onClick={() => setQuestsOpen({ ...questsOpen, [state]: !open })}
								>
									<span className={open ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
									{state === 'active' ? 'Active' : 'Finished'}
									<span className="loom-section-count">{list.length}</span>
								</button>
								{open
									? (
									<div className="loom-quest-cards">
									{list.map(({ quest }) => {
											const givers = quest.questGivers
												.map((lp) => plugin.indexer.resolve(lp, quest.path))
												.filter((r): r is EntityRecord => r != null && r.type === 'character');
											const received =
												quest.questReceived !== null
													? plugin.indexer.resolve(quest.questReceived, quest.path)
													: null;
											const outcomeSes =
												quest.questOutcomeSession !== null
													? plugin.indexer.resolve(quest.questOutcomeSession, quest.path)
													: null;
											const grabbed = questDrag?.gkey === gkey && questDrag.active === quest.path;
											return (
												<div
													key={quest.path}
													className={grabbed ? 'loom-quest-card loom-quest-card-grabbed' : 'loom-quest-card'}
													style={
														grabbed
															? { transform: `translate(${questDrag.dx}px, ${questDrag.dy}px)` }
															: undefined
													}
													data-quest-card=""
													data-quest-path={quest.path}
												>
													<div className="loom-quest-card-titlerow">
														{reorderable ? questGrip(gkey, quest.path, questRecords) : null}
														<button
															className="loom-subloc-link loom-quest-card-title"
															onClick={() => view.openEntity(quest.path)}
														>
															<Truncated className="loom-clip" text={quest.name} />
														</button>
													</div>
													<div className="loom-quest-card-row">
														<span className="loom-quest-card-label">
															{givers.length > 1 ? 'Quest givers:' : 'Quest giver:'}
														</span>
<span className="loom-quest-card-value">														{givers.length > 0 ? (
															givers.map((g) => (
																<button
																	key={g.path}
																	className="loom-subloc-link"
																onClick={() => view.openEntity(g.path)}
																>
																	<Truncated className="loom-clip" text={g.name} />
																</button>
															))
														) : (
															<span>—</span>
														)}</span>
													</div>
													<div className="loom-quest-card-row">
													<span className="loom-quest-card-label">Received on:</span>
<span className="loom-quest-card-value">														{received && received.type === 'session' ? (
															received.path === record.path ? (
																<span>This session</span>
															) : (
																<button
																	className="loom-subloc-link"
																	onClick={() => view.openEntity(received.path)}
																>
																	{shortSessionLabel(received)}
																</button>
															)
														) : (
															<span>—</span>
														)}</span>
													</div>
													{quest.loomTags.length > 0 ? (
														<div className="loom-quest-card-row">
															<span className="loom-quest-card-label">
																{quest.loomTags.length > 1 ? 'Tags:' : 'Tag:'}
															</span>
															<span className="loom-quest-card-value">
																{quest.loomTags.map((t) => {
																	const key = (QUEST_TAG_KEYS as readonly string[]).includes(t)
																		? (t as (typeof QUEST_TAG_KEYS)[number])
																		: null;
																	const bg = key ? plugin.settings.questTagColors[key] : null;
																	return (
																		<span
																			key={t}
																			className="loom-chip loom-quest-tag"
																			style={bg ? { background: bg, borderColor: bg, color: readableOn(bg) } : undefined}
																		>
																			{QUEST_TAG_ICONS[t] ? <Icon name={QUEST_TAG_ICONS[t]} /> : null}
																			{t}
																		</span>
																	);
																})}
															</span>
														</div>
													) : null}

													{state === 'finished' ? (
														<>
															<div className="loom-quest-card-row">
															<span className="loom-quest-card-label">Completed on:</span>
<span className="loom-quest-card-value">																{outcomeSes && outcomeSes.type === 'session' ? (
																	outcomeSes.path === record.path ? (
																		<span>This session</span>
																	) : (
																		<button
																			className="loom-subloc-link"
																			onClick={() => view.openEntity(outcomeSes.path)}
																		>
																			{shortSessionLabel(outcomeSes)}
																		</button>
																	)
																) : (
																	<span>—</span>
																)}</span>
															</div>
															<div className="loom-quest-card-row">
																<span className="loom-quest-card-label">Outcome:</span>
<span className="loom-quest-card-value">																<span>
																	{quest.questOutcome !== ''
																		? quest.questOutcome[0].toUpperCase() + quest.questOutcome.slice(1)
																		: '—'}
																</span></span>
															</div>
														</>
													) : null}
													<div className="loom-quest-card-row">
													<span className="loom-quest-card-label">Reward:</span>
<span className="loom-quest-card-value">														<Truncated
															className="loom-clip"
															text={quest.reward !== '' ? quest.reward : 'Not specified'}
														/></span>
													</div>
												</div>
											);
										})}
									</div>
								) : null}
							</div>
						);
					})}
					{/* Drop-slot preview: a bar at the insertion point (grid read as one
					    continuous row), portalled so it's never clipped. */}
					{questDrag && questDragRef.current
						? (() => {
								const rects = questDragRef.current.rects.filter((r) => r.path !== questDrag.active);
								if (rects.length === 0) return null;
								const over = Math.max(0, Math.min(rects.length, questDrag.over));
								const bar =
									over < rects.length
										? { left: rects[over].left - 4, top: rects[over].top, height: rects[over].height }
										: {
												left: rects[rects.length - 1].left + rects[rects.length - 1].width + 4,
												top: rects[rects.length - 1].top,
												height: rects[rects.length - 1].height,
											};
								return createPortal(
									<div
										className="loom-quest-drop"
										style={{ left: bar.left, top: bar.top, height: bar.height }}
									/>,
									document.body
								);
							})()
						: null}
				</div>
			) : null}

			{/* Quest fields: givers left of a full-height separator; session/outcome
			    row + reward right of it. The separator stretches with whichever
			    side grows (wrapping giver chips, multi-line reward). */}
			{isQuest ? (
				<div className="loom-quest-grid">
					<div className="loom-field loom-quest-givers">
						<span className="loom-field-label">Quest givers</span>
						<SearchableSelect
							placeholder="Add a quest giver…"
							options={characters
								.filter((c) => !questGiverRecords.some((g) => g.path === c.path))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((c) => ({ value: linkTargetOf(c), label: c.name }))}
							onPick={(target) => writeQuestGivers([...questGiverRecords.map((g) => linkTargetOf(g)), target])}
						/>
						{questGiverRecords.length > 0 ? (
							<div className="loom-tag-row">
								{questGiverRecords.map((c) => (
									<EntityChip
										key={c.path}
										plugin={plugin}
										record={c}
										onOpen={() => view.openEntity(c.path)}
										onRemove={() =>
											writeQuestGivers(
												questGiverRecords.filter((o) => o.path !== c.path).map((o) => o.name)
											)
										}
										removeLabel="Remove quest giver"
									/>
								))}
							</div>
						) : null}
					</div>
					<div className="loom-quest-right">
						<div className="loom-quest-sessions">
							<div className="loom-field">
								<span className="loom-field-label">Received in session</span>
								{questReceived && questReceived.type === 'session' ? (
									sessionChip(questReceived, () => setQuestSession('questReceived', null))
								) : (
									<SearchableSelect
										placeholder="Pick the session…"
										options={sessionsByDate.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
										onPick={(name) => setQuestSession('questReceived', name)}
									/>
								)}
							</div>
							{record.questOutcome !== '' ? (
								<div className="loom-field">
									<span className="loom-field-label">
										{record.questOutcome[0].toUpperCase() + record.questOutcome.slice(1)} in session
									</span>
									{questOutcomeSession && questOutcomeSession.type === 'session' ? (
										sessionChip(questOutcomeSession, () => setQuestSession('questOutcomeSession', null))
									) : (
										<SearchableSelect
											placeholder="Pick the session…"
											options={sessionsByDate.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
											onPick={(name) => setQuestSession('questOutcomeSession', name)}
										/>
									)}
								</div>
							) : null}
							<label className="loom-field">
								<span className="loom-field-label">Outcome</span>
								<select value={record.questOutcome} onChange={(e) => setQuestOutcome(e.target.value)}>
									<option value="">Active</option>
									{QUEST_OUTCOMES.map((o) => (
										<option key={o} value={o}>
											{o[0].toUpperCase() + o.slice(1)}
										</option>
									))}
								</select>
							</label>
						</div>
						<label className="loom-field">
							<span className="loom-field-label">Reward</span>
							<input
								type="text"
								placeholder="Not specified"
								value={reward}
								onChange={(e) => setReward(e.target.value)}
								onBlur={() =>
									writeFm((fm) => {
										setLoomKey(fm, FM.reward, reward);
									})
								}
							/>
						</label>
					</div>
				</div>
			) : null}

		<div className={isSession ? 'loom-field loom-field-sep' : 'loom-field'}>
				<span className="loom-field-label">Description</span>
				{isPc ? (
					<label className="loom-check">
						<input type="checkbox" checked={record.alive} onChange={(e) => setAlive(e.target.checked)} />
						Alive
					</label>
				) : null}
				{isPc && !record.alive ? (
					<div className="loom-death-row">
						<span className="loom-field-label">Death session</span>
						{deathSession && deathSession.type === 'session' ? (
							<div className="loom-tag-row">
								<EntityChip
									plugin={plugin}
									record={deathSession}
									label={recordLabel(deathSession, project)}
									onOpen={() => view.openEntity(deathSession.path)}
									onRemove={() => setDeathSession(null)}
									removeLabel="Clear death session"
								/>
							</div>
						) : (
							<SearchableSelect
								placeholder="Pick the session…"
								options={sessions
									.slice()
									.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0))
									.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
								onPick={(name) => setDeathSession(name)}
							/>
						)}
					</div>
				) : null}
				<MarkdownField
					app={plugin.app}
					value={description}
					names={linkNames}
					onOpenLink={openLinkTarget}
					onCreateEntity={createLinkEntity}
					onChange={(v) => {
						setDescription(v);
						saveDescription(v);
					}}
				/>
			</div>

		{isSession && project ? (
				<div className="loom-field loom-graph-under">
					<button className="loom-section-header" onClick={() => setGraphOpen(!graphOpen)}>
						<span className={graphOpen ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
						Session graph
					</button>
					{graphOpen ? (
						<MiniGraph
							plugin={plugin}
							project={project}
							focusId={record.path}
							version={version}
						onOpen={(path) => view.openEntity(path)}
							onCollapse={() => setGraphOpen(false)}
						/>
					) : null}
				</div>
			) : null}

			{isSession && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Session notes</span>
					{/* Creation first, as always. The modal's Name field searches
					    existing events/quests — picking one pins it here instead of
					    creating a duplicate. */}
					<div className="loom-hub-add-row">
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, 'event', project, {
									noteSession: record,
									onCreated: () => {},
								}).open()
							}
						>
							+ Add an event
						</button>
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, 'quest', project, {
									noteSession: record,
									onCreated: () => {},
								}).open()
							}
						>
							+ Add a quest
						</button>
					</div>
					{ENTITY_TYPES.filter((t) => hubEntries.some((e) => e.owner.type === t)).map((t) => {
						const entries = hubEntries.filter((e) => e.owner.type === t);
						// Event and quest notes are drag-reorderable by loomSeq (events
						// share it with the timeline); other hub groups keep note order.
						if (t !== 'event' && t !== 'quest') {
							return (
								<div key={t} className="loom-hub-section">
									<span className="loom-rel-group-label">{ENTITY_META[t].plural}</span>
									{entries.map((en) => hubEntryRow(en))}
								</div>
							);
						}
						const ordered = entries
							.slice()
							.sort((a, b) => (a.owner.seq ?? a.owner.created) - (b.owner.seq ?? b.owner.created));
						const owners = ordered.map((e) => e.owner);
						return (
							<div
								key={t}
								className={
									seqDrag?.group === t ? 'loom-hub-section loom-subloc-dragging' : 'loom-hub-section'
								}
							>
								<span className="loom-rel-group-label">{ENTITY_META[t].plural}</span>
								{ordered.map((en, i) =>
									hubEntryRow(
										en,
										seqGrip(t, i, owners),
										seqRowStyle(t, i),
										seqDrag?.group === t && seqDrag.from === i,
										i
									)
								)}
							</div>
						);
					})}
				</div>
			) : null}


			{allTags.length > 0 ? (
				<div className="loom-field">
					<span className="loom-field-label">Tags</span>
					<div className="loom-tag-row">
						{allTags.map((tag) => (
							<button
								key={tag}
								className={record.loomTags.includes(tag) ? 'loom-chip loom-chip-on' : 'loom-chip'}
								onClick={() => toggleTag(tag)}
							>
								{tag}
							</button>
						))}
					</div>
				</div>
			) : null}

			{record.type === 'faction' ? (
				<div className="loom-field">
					<span className="loom-field-label">Members</span>
					<SearchableSelect
						placeholder="Add a member…"
						options={projectCharacters
							.filter((c) => !memberRecords.some((m) => m.path === c.path))
							.sort((a, b) => a.name.localeCompare(b.name))
							.map((c) => ({ value: linkTargetOf(c), label: c.name }))}
						onPick={(name) => editMembersOf(record, (arr) => [...arr, `[[${name}]]`])}
					/>
					{memberRecords.length > 0 ? (
						<div className="loom-tag-row">
							{memberRecords.map((c) => (
								<EntityChip
									key={c.path}
									plugin={plugin}
									record={c}
									onOpen={() => view.openEntity(c.path)}
									onRemove={() => removeMemberEntry(record, c)}
									removeLabel="Remove member"
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{record.type === 'character' ? (
				<div className="loom-field loom-field-sep loom-field-sep-after">
					<span className="loom-field-label">{membershipRows.length > 1 ? 'Factions' : 'Faction'}</span>
					{factionDraft ? (
						<div className="loom-rel-row loom-member-row">
							<SearchableSelect
								placeholder="Pick a faction…"
								options={projectFactions
									.filter((f) => !membershipRows.some((m) => m.faction.path === f.path))
									.sort((a, b) => a.name.localeCompare(b.name))
									.map((f) => ({ value: linkTargetOf(f), label: f.name }))}
								onPick={(name) => {
									const faction = projectFactions.find((f) => f.name === name);
									if (faction) editMembersOf(faction, (arr) => [...arr, `[[${linkTargetOf(record)}]]`]);
									setFactionDraft(false);
								}}
							/>
							<button
								className="loom-nav-btn"
								aria-label="Cancel adding faction"
								onClick={() => setFactionDraft(false)}
							>
								✕
							</button>
						</div>
					) : (
						<button className="loom-rel-add loom-faction-add" onClick={() => setFactionDraft(true)}>
							+ Add faction
						</button>
					)}
					{membershipRows.map((m) => (
						<div key={m.faction.path + ':' + m.role} className="loom-rel-row loom-member-row">
							<input
								type="text"
								className="loom-rel-type"
								placeholder={DEFAULT_MEMBER_ROLE}
								defaultValue={m.role}
								onBlur={(e) => {
									if (e.target.value.trim() !== m.role)
										setMembershipField(m.faction, { role: e.target.value });
								}}
							/>
							<span className="loom-member-sep">of faction</span>
							<EntityChip
								plugin={plugin}
								record={m.faction}
								onOpen={() => view.openEntity(m.faction.path)}
							/>
							<span className="loom-member-sep">at</span>
							<div className="loom-member-loc">
								{m.location ? (
									<EntityChip
										plugin={plugin}
										record={m.location}
										onOpen={() => m.location && view.openEntity(m.location.path)}
										onRemove={() => setMembershipField(m.faction, { location: null })}
										removeLabel="Clear location"
									/>
								) : (
									<SearchableSelect
										placeholder="Not specified"
										options={membershipLocations
											.slice()
											.sort((a, b) => a.name.localeCompare(b.name))
											.map((l) => ({ value: linkTargetOf(l), label: locationLabel(l, plugin) }))}
										onPick={(name) => setMembershipField(m.faction, { location: name })}
									/>
								)}
							</div>
							<button
								className="loom-nav-btn"
								aria-label="Remove membership"
								onClick={() =>
									new ConfirmModal(
										plugin.app,
										'Remove membership?',
										`Removes ${record.name} from ${m.faction.name}'s members — on both pages.`,
										() => removeMemberEntry(m.faction, record),
										'Remove'
									).open()
								}
							>
								✕
							</button>
						</div>
					))}
				</div>
			) : null}

			{!isSession ? (
<div className="loom-field loom-field-body">
				<span className="loom-field-label">Notes</span>
				<MarkdownField
					app={plugin.app}
					value={body ?? ''}
					names={linkNames}
					onOpenLink={openLinkTarget}
					onCreateEntity={createLinkEntity}
					onChange={(v) => {
						setBody(v);
						saveBody(v);
					}}
				/>
			</div>
			) : null}


			{record.type === 'event' || record.type === 'quest' ? (
				<div className="loom-field loom-field-sep">
					{sessionNotes.length > 0 ? <span className="loom-field-label">Session notes</span> : null}
					<div className="loom-hub-add-row">
						<button
							className="loom-rel-add"
							onClick={() => setSessionNotes([...sessionNotes, { session: '', text: '', places: [], involved: [], seq: Date.now(), idx: null }])}
						>
							+ Add a session note
						</button>
						{sessionNotes.length > 0 ? orderToggle : null}
					</div>
					{sessionNotes.length > 0 ? (
						<div className="loom-note-list">
							{sessionNotes
								.map((note, i) => ({ note, i }))
								.sort((a, b) => {
									const da = a.note.session
										? plugin.indexer.resolve(a.note.session, record.path)?.date?.sortKey
										: undefined;
									const db = b.note.session
										? plugin.indexer.resolve(b.note.session, record.path)?.date?.sortKey
										: undefined;
									if (da === undefined && db === undefined) return 0;
									if (da === undefined) return 1;
									if (db === undefined) return -1;
									return newestFirst ? db - da : da - db;
								})
								.map(({ note, i }) => sessionNoteRow(note, i))}
						</div>
					) : null}
				</div>
			) : null}

			{/* Events instead of session notes (characters/items/factions via the
			    note's "involved"; locations via its "places", including any
			    sublocation's events). The modal pre-links this page's entity. */}
			{showsEvents && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Events</span>
					<div className="loom-hub-add-row">
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, 'event', project, {
									...(isLocation
										? { defaultPlace: linkTargetOf(record) }
										: { defaultInvolved: [linkTargetOf(record)] }),
									onCreated: () => {},
								}).open()
							}
						>
							+ Add an event
						</button>
						{orderToggle}
					</div>
					{pageEventGroups.map((g) => {
						// Events within a session group are drag-reorderable (loomSeq,
						// shared with the session page); the slide is scoped to the group,
						// so it never crosses sessions.
						const gkey = 'pgevents-' + (g.session?.path ?? 'none');
						const owners = g.entries.map((e) => e.owner);
						return (
							<div key={g.session?.path ?? 'none'} className="loom-locnote-group loom-char-event-group">
								<div className="loom-tag-row loom-event-group-session">
									{g.session ? (
										<EntityChip
											plugin={plugin}
											record={g.session}
											label={shortSessionLabel(g.session)}
											onOpen={() => g.session && view.openEntity(g.session.path)}
										/>
									) : (
										<EntityChip plugin={plugin} record={null} label="No session" />
									)}
								</div>
								<div
									className={
										seqDrag?.group === gkey ? 'loom-event-nest loom-subloc-dragging' : 'loom-event-nest'
									}
								>
									{g.entries.map((en, i) =>
										hubEntryRow(
											en,
											seqGrip(gkey, i, owners),
											seqRowStyle(gkey, i),
											seqDrag?.group === gkey && seqDrag.from === i,
											i
										)
									)}
								</div>
							</div>
						);
					})}
				</div>
			) : null}


			{/* Sublocations live outside the relationships model: the list of
			    children, creating one, and demoting this location under another
			    all work through the dedicated parentLocation key. */}
			{isLocation && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Sublocations</span>
					<div className="loom-subloc-actions">
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, 'location', project, {
									parentLocation: record,
									// Append at the END of the order and stay on this page.
									onCreated: (created) =>
										writeFm((fm) => {
											setLoomKey(fm, FM.sublocationOrder, [
												...sublocations.map((s) => `[[${linkTargetOf(s)}]]`),
												`[[${created.basename}]]`,
											]);
										}),
								}).open()
							}
						>
							+ New sublocation
						</button>
					</div>
{sublocations.length > 0 ? (
						<div
							className={sublocDrag ? 'loom-subloc-list loom-subloc-dragging' : 'loom-subloc-list'}
							ref={sublocListRef}
						>
							{sublocations.map((s, i) => {
								const isDragged = sublocDrag?.from === i;
								const slot = sublocDragRef.current?.slot ?? 28;
								// The grabbed row follows the cursor (raw dy); the rest slide
								// by whole slots to open the gap where it will land.
								const style = isDragged
									? { transform: `translateY(${sublocDrag?.dy ?? 0}px)` }
									: sublocShift(i) !== 0
										? { transform: `translateY(${sublocShift(i) * slot}px)` }
										: undefined;
								return (
								<div
									key={s.path}
									className={
										isDragged
											? 'loom-subloc-row loom-subloc-row-dragging'
											: sublocDrag
												? 'loom-subloc-row loom-subloc-row-slide'
												: 'loom-subloc-row'
									}
									style={style}
								>
									<span
										className="loom-subloc-grip"
										onPointerDown={(e) => {
											e.preventDefault();
											e.currentTarget.setPointerCapture(e.pointerId);
											sublocDragRef.current = { startY: e.clientY, slot: sublocSlotHeight() };
											setSublocDrag({ from: i, over: i, dy: 0 });
										}}
										onPointerMove={(e) => {
											const start = sublocDragRef.current;
											if (!start) return;
											const dy = e.clientY - start.startY;
											const over = Math.max(
												0,
												Math.min(sublocations.length - 1, i + Math.round(dy / start.slot))
											);
											setSublocDrag((cur) =>
												cur && (cur.over !== over || cur.dy !== dy) ? { ...cur, over, dy } : cur
											);
										}}
										onPointerUp={() => endSublocDrag(true)}
										onPointerCancel={() => endSublocDrag(false)}
									>
										<Icon name="grip-vertical" />
									</span>
									<button className="loom-subloc-link" onClick={() => view.openEntity(s.path)}>
										{s.name}
									</button>
									<button
										className="loom-chip-remove"
										aria-label="Detach sublocation"
										onClick={() => detachSublocation(s)}
									>
										✕
									</button>
								</div>
								);
							})}
						</div>
					) : null}
				</div>
			) : null}

			<div className="loom-field loom-field-sep">
				<span className="loom-field-label">Relationships</span>
				<button
					className="loom-rel-add"
					onClick={() => setRelationships([...relationships, { type: '', target: '' }])}
				>
					Add relationship
				</button>
{ENTITY_TYPES.filter((t) => relEntries.some((e) => e.entityType === t)).map((t) => (
					<div key={t} className="loom-rel-group">
						<span className="loom-rel-group-label">{ENTITY_META[t].plural}</span>
						{relEntries.filter((e) => e.entityType === t).map((e) => relRow(e.rel, e.i))}
					</div>
				))}
				{relEntries.some((e) => e.entityType === null) ? (
					<div className="loom-rel-ungrouped">
						{relEntries.filter((e) => e.entityType === null).map((e) => relRow(e.rel, e.i))}
					</div>
				) : null}
				
			</div>

			<ConnectedEntities navigator={view} record={record} project={project} />
			</div>
		</div>
	);
}										
