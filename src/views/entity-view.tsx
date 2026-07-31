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
	PC_GROUP_NAME,
	PC_GROUP_VALUE,
	PC_TAG,
	QUEST_OUTCOMES,
	VIEW_ENTITY,
	VIEW_GROUP,
	VIEW_LIST,
	pcGroupStub,
} from '../types';
import {
	ConfirmModal,
	CreateEntityModal,
	EntityTypeSuggestModal,
	RecordSuggestModal,
	createEntity,
	createItemCopy,
	entityFileName,
	purgeEntityReferences,
	renameEntityRecord,
	sessionFileName,
} from '../project';
import { formatLoomDateShort, groupNameOf, todayRaw } from '../calendar';
import { LoomFileReactView } from './react-view';
import {
	EntityChip,
	FRONTMATTER_RE,
	Icon,
	NavRail,
	SearchableSelect,
	SuggestInput,
	QuestTagChip,
	Truncated,
	locationLabel,
	mainLocationFirst,
	recordLabel,
} from './common';
import { ConnectedEntities } from './connected-entities';
import { LinkOption } from './link-textarea';
import { MarkdownField } from './markdown-field';
import { FountainField, FountainFieldHandle } from './fountain-field';
import { extractLinkpath, linkTargetOf, memberEntryLinkpath } from '../indexer';
import { fmLoomValue, setLoomKey } from '../fm';
import { MiniGraph } from './mini-graph';
import { findMapsFile } from './map-view';
import { useIndexVersion } from './hooks';
import {
	buildNavTree,
	chapterScriptText,
	editScript,
	editScriptAndSync,
	highlight,
	pushChapterTitles,
	renderNavTreeItem,
	sceneScriptText,
	useScriptText,
} from './script-view';
import {
	moveSceneToSection,
	moveSceneBefore,
	reorderScenesInSection,
	renameSectionTitle,
	replaceChapterBody,
	replaceSceneBody,
	removeScene,
	joinLocationSub,
	setSceneHeadingParts,
	elementText,
	nextTopSectionLine,
	parseFountain,
	parseSceneHeading,
	preventOrphans,
	renderInline,
	stripEntityLinksForDisplay,
	type ParsedScript,
} from '../fountain';
import { pdfPages } from '../pdf';
import { features, projectRoleType, projectTypes, roleOf } from '../project-kind';
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

interface ObjectiveDraft {
	name: string;
	/** Linkpath of the session it was finished in; '' while still active. */
	finishedOn: string;
}

interface SessionNoteDraft {
	/** Session linkpath; '' while no session is picked yet. */
	session: string;
	text: string;
	/** Locations only: linkpaths of places this note is about. */
	places: string[];
	/** Linkpaths of involved entities (the note is their home). */
	involved: string[];
	/** Virtual-Group snapshot (PCs at pick time) — one "Group" chip, individual
	 *  connections. */
	group: string[];
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

interface LocNoteEntry {
	owner: EntityRecord;
	idx: number;
	session: string | null;
	text: string;
	seq: number | null;
	involved: string[];
	/** Virtual-Group snapshot on the note — see SessionNoteDecl.group. */
	group: string[];
	places: string[];
}

function EntityPage({ view }: { view: EntityView }) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const file = view.file;
	const record = file ? plugin.indexer.get(file.path) : undefined;
	const project = record ? plugin.indexer.getProjectByRoot(record.project) ?? null : null;
	// The project's script, for a Scene page's read-only excerpt. Read here (a
	// hook, so it can't sit behind the early returns below) and unused by every
	// other entity type.
	const scriptText = useScriptText(plugin, project);
	/** Feeds the scene excerpt's live-preview autocomplete the same known
	 *  names as the main Script view — parsed from the WHOLE script, not
	 *  just this scene's own slice, so it offers every character/location
	 *  in the project, not only ones already mentioned in this scene. */
	const scriptParsed = useMemo(() => (scriptText === null ? null : parseFountain(scriptText)), [scriptText]);
	/** What the `@[` inline entity-link autocomplete offers in the Scene page's
	 *  Script section — never auto-created, so only what already exists. */
	const entityOptions = project
		? (['character', 'faction', 'location', 'item'] as const).flatMap((t) =>
				plugin.indexer.getAll(t, project.root).map((r) => ({ name: r.name, type: r.type, path: r.path }))
			)
		: [];
	/** Draft of the scene's script body (everything under its heading). */
	const [sceneBody, setSceneBody] = useState<string | null>(null);
	/** Scene page's Script section: same Script/Pages preview + search pattern
	 *  as the main Script view, scoped to just this scene's own excerpt. */
	const [sceneScriptMode, setSceneScriptMode] = useState<'script' | 'pages'>('script');
	const [sceneScriptQuery, setSceneScriptQuery] = useState('');
	const [sceneScriptMatchIndex, setSceneScriptMatchIndex] = useState(0);
	const sceneScriptEditorRef = useRef<FountainFieldHandle | null>(null);
	const sceneScriptPagesRef = useRef<HTMLDivElement | null>(null);
	/** A body line to land on once the scene's Script pane is back — same
	 *  "stash it, apply once FountainField remounts" pattern as the main
	 *  Script view's `pendingScrollLineRef`. */
	const pendingSceneScrollLineRef = useRef<number | null>(null);
	/** Draft of the chapter's script body (its `#` line through every scene
	 *  under it) — same shape as `sceneBody`, for the Chapter page's own
	 *  Script section. */
	const [chapterBody, setChapterBody] = useState<string | null>(null);
	const [chapterScriptMode, setChapterScriptMode] = useState<'script' | 'pages'>('script');
	const [chapterScriptQuery, setChapterScriptQuery] = useState('');
	const [chapterScriptMatchIndex, setChapterScriptMatchIndex] = useState(0);
	const chapterScriptEditorRef = useRef<FountainFieldHandle | null>(null);
	const chapterScriptPagesRef = useRef<HTMLDivElement | null>(null);
	const pendingChapterScrollLineRef = useRef<number | null>(null);
	/** Same collapsible nav panel as the main Script view, scoped to just this
	 *  scene's/chapter's own bounded tree — rendered INSIDE the editor box
	 *  (`.loom-script-nav-sticky-inset` in styles.css), not stacked above it,
	 *  so it lives in the box's own spare left margin instead of colliding
	 *  with the scene-heading caption. */
	const [sceneNavOpen, setSceneNavOpen] = useState(false);
	const [chapterNavOpen, setChapterNavOpen] = useState(false);
	const writeFm = useFrontmatterWriter(plugin, file);

	useEffect(() => {
		if (!sceneNavOpen) return;
		const onDown = (e: MouseEvent) => {
			const el = e.target as HTMLElement | null;
			if (el?.closest('.loom-script-nav, .loom-script-nav-toggle')) return;
			setSceneNavOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [sceneNavOpen]);

	useEffect(() => {
		if (!chapterNavOpen) return;
		const onDown = (e: MouseEvent) => {
			const el = e.target as HTMLElement | null;
			if (el?.closest('.loom-script-nav, .loom-script-nav-toggle')) return;
			setChapterNavOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [chapterNavOpen]);

	useEffect(() => {
		if (sceneScriptMode !== 'script') return;
		const line = pendingSceneScrollLineRef.current;
		if (line === null) return;
		pendingSceneScrollLineRef.current = null;
		sceneScriptEditorRef.current?.scrollToLine(line);
	}, [sceneScriptMode]);

	useEffect(() => {
		if (chapterScriptMode !== 'script') return;
		const line = pendingChapterScrollLineRef.current;
		if (line === null) return;
		pendingChapterScrollLineRef.current = null;
		chapterScriptEditorRef.current?.scrollToLine(line);
	}, [chapterScriptMode]);

	/** Label a record is searched/shown by in free-text draft inputs: the
	 *  display name — for sessions, their formatted date (their file name is
	 *  managed and never user-facing). */
	const draftLabel = (r: EntityRecord) =>
		roleOf(r.type) === 'anchor'
			? recordLabel(r, plugin.indexer.getProjectByRoot(r.project) ?? null)
			: r.name;

	// Drafts are seeded once per file (component is keyed by path) so index
	// updates triggered by our own saves never clobber what's being typed.
	const [name, setName] = useState(record?.name ?? '');
	const [description, setDescription] = useState(record?.description ?? '');
	const [reward, setReward] = useState(record?.reward ?? '');
	const [date, setDate] = useState(record?.date?.raw ?? '');
	/** Chapters: the title emitted into the exported script. */
	const [displayTitle, setDisplayTitle] = useState(record?.displayTitle ?? '');
	/** Scenes: step 2 of "move to another chapter" — the chapter picked in step
	 *  1, whose scene list is then shown for drag placement. Null = step 1
	 *  (just the chapter picker). */
	const [moveTargetChapter, setMoveTargetChapter] = useState<EntityRecord | null>(null);
	/** Step 2's pending drop position among the target chapter's scenes (index
	 *  into its sibling list, 0 = the very top) — dragging only updates this;
	 *  nothing actually moves until "Move the scene" commits it. */
	const [movePlaceAt, setMovePlaceAt] = useState(0);
	/** Scenes: the modular heading editor's four parts, seeded from the
	 *  resolved `sceneLocation` entity (not the raw heading text) — that's what
	 *  lets Location/Sublocation reuse the app's normal rename-in-place
	 *  semantics instead of re-parsing a hyphen-joined string every render. */
	const initialSceneLocation =
		record?.type === 'scene' && record.sceneLocation !== ''
			? plugin.indexer.resolve(record.sceneLocation, record.path)
			: null;
	const initialSceneLocationParent =
		initialSceneLocation?.parentLocation != null
			? plugin.indexer.resolve(initialSceneLocation.parentLocation, initialSceneLocation.path)
			: null;
	const [sceneIntExt, setSceneIntExt] = useState(record?.sceneIntExt ?? '');
	const [sceneMain, setSceneMain] = useState(
		initialSceneLocationParent?.name ?? initialSceneLocation?.name ?? ''
	);
	const [sceneSub, setSceneSub] = useState(
		initialSceneLocationParent ? (initialSceneLocation?.name ?? '') : ''
	);
	const [sceneTime, setSceneTime] = useState(record?.sceneTime ?? '');
	const [relationships, setRelationships] = useState<RelationshipDraft[]>(
		record?.relationships.map((r) => {
			const target = plugin.indexer.resolve(r.linkpath, record.path);
			return { type: r.type, target: target ? draftLabel(target) : r.linkpath };
		}) ?? []
	);
	const [sessionNotes, setSessionNotes] = useState<SessionNoteDraft[]>(
		record?.sessionNotes.map((n, idx) => ({ session: n.session ?? '', text: n.text, places: n.places, involved: n.involved, group: n.group, seq: n.seq, idx })) ?? []
	);
	const [objectives, setObjectives] = useState<ObjectiveDraft[]>(
		record?.objectives.map((o) => ({ name: o.name, finishedOn: o.finishedSession ?? '' })) ?? []
	);
	const [body, setBody] = useState<string | null>(null);
	/** Live sublocation reorder: rows slide in real time while the grip is
	 *  held; the row itself is never carried by the cursor. */
	const [sublocDrag, setSublocDrag] = useState<{ from: number; over: number; dy: number } | null>(
		null
	);
	const sublocDragRef = useRef<{ startY: number; slot: number } | null>(null);
	const sublocListRef = useRef<HTMLDivElement | null>(null);
	/** Location page: whether the "Part of region" field is showing its picker. */
	const [editingRegion, setEditingRegion] = useState(false);
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
	const [questsOpen, setQuestsOpen] = useState<{
		active: boolean;
		resolvedThis: boolean;
		resolvedPrev: boolean;
	}>({
		active: true,
		resolvedThis: true,
		resolvedPrev: false,
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
	/** Live reorder of the active objectives list (indices within that sublist). */
	const [objDrag, setObjDrag] = useState<{ from: number; over: number; dy: number } | null>(null);
	const objDragRef = useRef<{ startY: number; slot: number; mids: number[] } | null>(null);

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
		setSessionNotes(record.sessionNotes.map((n, idx) => ({ session: n.session ?? '', text: n.text, places: n.places, involved: n.involved, group: n.group, seq: n.seq, idx })));
		setObjectives(record.objectives.map((o) => ({ name: o.name, finishedOn: o.finishedSession ?? '' })));
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
			.flatMap((r) => {
				const target = linkTargetOf(r);
				const label = draftLabel(r);
				const opts: LinkOption[] = [
					{ label, insert: target === label ? label : `${target}|${label}` },
				];
				// Also offer each alias (native `aliases` frontmatter); inserting the
				// real target keeps the link resolvable while showing the alias.
				const f = plugin.app.vault.getFileByPath(r.path);
				const aliases = f
					? (plugin.app.metadataCache.getFileCache(f)?.frontmatter?.aliases as unknown)
					: undefined;
				if (Array.isArray(aliases)) {
					for (const a of aliases) {
						if (typeof a === 'string' && a.trim() !== '' && a !== label) {
							opts.push({ label: a, insert: `${target}|${a}` });
						}
					}
				}
				return opts;
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

	// Reward supports markdown (links, multiple lines); commits on idle like the
	// description field.
	const saveReward = useMemo(() => {
		let timer = 0;
		return (value: string) => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				if (!file) return;
				plugin.app.fileManager
					.processFrontMatter(file, (fm: Record<string, unknown>) => {
						setLoomKey(fm, FM.reward, value);
					})
					.catch((e) => {
						console.error('Loom Loom: failed to save reward', e);
					});
			}, 600);
		};
	}, [plugin, file]);

	/** Opens a wikilink target from the markdown fields: loom entities get
	 *  their entity page, anything else Obsidian's normal link opening. */
	const openLinkTarget = (target: string, newTab = false) => {
		if (!record) return;
		const resolved = plugin.indexer.resolve(target, record.path);
		if (resolved) view.openEntity(resolved.path, newTab);
		else void plugin.app.workspace.openLinkText(target, record.path, newTab ? 'tab' : false);
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
			}).open(),
			proj
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

	// The page shell is role-based: `isSession` means "this is the project's
	// chronological anchor" (a Session, or a Chapter in a writer project), and
	// the parts that really are session-only (dates, attendance) gate on the
	// kind's features instead.
	const anchorType = projectRoleType(project?.config, 'anchor');
	const beatType = projectRoleType(project?.config, 'beat');
	const anchorLabel = ENTITY_META[anchorType].label.toLowerCase();
	const beatLabel = ENTITY_META[beatType].label.toLowerCase();
	const kindFeatures = features(project?.config);
	/** Writer projects: the writing lives in the script, not in note fields. */
	const scriptMode = kindFeatures.script;
	/** Named by the script rather than here — see the Name field. */
	const scriptNamed =
		scriptMode && (record.type === 'chapter' ? record.chapterId !== '' : record.sceneId !== '');
	const sceneChapterRecord =
		record.sceneChapter !== '' ? plugin.indexer.resolve(record.sceneChapter, record.path) : null;
	/** Script-recognized cast — `loomSceneCast`, derived from the script's own
	 *  character cues by `syncScenes`, shown read-only (editing a scene's cast
	 *  means writing the dialogue that names them, not this list). */
	const sceneCastRecords = record.sceneCast
		.map((lp) => plugin.indexer.resolve(lp, record.path))
		.filter((r): r is EntityRecord => r != null);
	/** Factions/Items/other-Locations named via `@[...]` in this scene's
	 *  text — same read-only, script-derived shape as `sceneCastRecords`. */
	const sceneFactionRecords = record.sceneFactions
		.map((lp) => plugin.indexer.resolve(lp, record.path))
		.filter((r): r is EntityRecord => r != null);
	const sceneItemRecords = record.sceneItems
		.map((lp) => plugin.indexer.resolve(lp, record.path))
		.filter((r): r is EntityRecord => r != null);
	const sceneMentionedLocationRecords = record.sceneMentionedLocations
		.map((lp) => plugin.indexer.resolve(lp, record.path))
		.filter((r): r is EntityRecord => r != null);
	const sceneExcerpt = sceneScriptText(scriptText, record.sceneId);
	/** This scene's own mini nav panel: whatever `##`+ (branch or ordinary)
	 *  sections exist inside its own line span, using the exact same
	 *  algorithm as the main Script view's nav tree (`buildNavTree`), just
	 *  bounded to this one scene instead of the whole document. */
	const sceneNavScene = scriptParsed?.scenes.find((s) => s.loomId === record.sceneId) ?? null;
	// `+ 1` excludes the scene's own heading line — only its own content
	// (branch sections, ordinary sub-headings) should show up here, not the
	// scene repeating itself as a top-level entry.
	const sceneNavTree =
		scriptParsed && sceneNavScene
			? buildNavTree(scriptParsed, sceneNavScene.line + 1, sceneNavScene.endLine)
			: null;
	// The heading line is the script's, not the note's — only what follows it is
	// editable here, so the title and its hidden id can't be typed over.
	const sceneBodyOf = (excerpt: string) => excerpt.split('\n').slice(1).join('\n').trim();
	const sceneDraft = sceneBody ?? (sceneExcerpt === null ? '' : sceneBodyOf(sceneExcerpt));
	/** Same Script/Pages scroll sync as the main Script view, scoped to this
	 *  scene's own pagination (`pdfPages` run on just the excerpt, not the
	 *  whole document — a scene's own "page 1" isn't its real position in the
	 *  script). The editor edits `sceneDraft` (body only, heading stripped),
	 *  but `sceneBodyPages` is paginated against the full `sceneExcerpt`
	 *  (heading included, since that's what's actually rendered) — the two
	 *  don't share a line-numbering origin, so `sceneBodyLineOffset` is
	 *  computed once to translate between them. `sceneBodyOf`'s `.trim()`
	 *  means that offset isn't a fixed constant (it eats however many blank
	 *  lines separate the heading from the body), hence computing it instead
	 *  of assuming "heading line + 1". */
	const sceneBodyPages = sceneExcerpt !== null ? pdfPages(parseFountain(sceneExcerpt)) : [];
	const sceneBodyLineOffset = (() => {
		if (sceneExcerpt === null) return 0;
		const afterHeading = sceneExcerpt.split('\n').slice(1);
		let blanks = 0;
		while (blanks < afterHeading.length && afterHeading[blanks].trim() === '') blanks++;
		return 1 + blanks;
	})();
	const sceneElementSpan = (el: ParsedScript['elements'][number]) =>
		el.type === 'dialogue' ? el.text.split('\n').length : 1;
	/** `bodyLine` is 0-based against `sceneDraft` (what `FountainField.getTopLine`
	 *  returns); translated to the excerpt's own line numbering before matching
	 *  against `sceneBodyPages`. */
	const scenePageOfLine = (bodyLine: number) => {
		const line = bodyLine + sceneBodyLineOffset;
		for (let i = 0; i < sceneBodyPages.length; i++) {
			if (sceneBodyPages[i].some((el) => line >= el.line && line < el.line + sceneElementSpan(el))) return i + 1;
		}
		for (let i = 0; i < sceneBodyPages.length; i++) {
			if (sceneBodyPages[i].some((el) => el.line > line)) return i + 1;
		}
		return Math.max(1, sceneBodyPages.length);
	};
	const sceneLineOfPage = (page: number) => {
		const idx = page - 1;
		if (idx < 0 || idx >= sceneBodyPages.length) return 0;
		const first = sceneBodyPages[idx][0];
		return first ? first.line - sceneBodyLineOffset : 0;
	};
	/** Chapter page's own Script section — same shape as the Scene page's
	 *  `sceneExcerpt`/`sceneDraft`/`sceneBodyPages`, but spanning every scene
	 *  under this chapter rather than one heading's worth. The `#` section
	 *  line is stripped from the editable body the same way a scene's heading
	 *  is — the Chapter page's own Title field is where that line's text is
	 *  actually edited, so the Script section doesn't show a rival copy. */
	const chapterExcerpt = record.type === 'chapter' ? chapterScriptText(scriptText, record.chapterId) : null;
	/** This chapter's own nav panel — every scene/branch/sub-section between
	 *  its `#` line and the next top-level one, same `buildNavTree` bounded
	 *  call the Scene page's mini nav uses. */
	const chapterNavSection =
		record.type === 'chapter' && scriptParsed
			? (scriptParsed.sections.find((s) => s.level === 1 && s.loomId === record.chapterId) ?? null)
			: null;
	const chapterNavTree =
		scriptParsed && chapterNavSection
			? buildNavTree(
					scriptParsed,
					chapterNavSection.line + 1,
					nextTopSectionLine(scriptParsed, chapterNavSection.line) ?? Infinity
				)
			: null;
	const chapterBodyOf = (excerpt: string) => excerpt.split('\n').slice(1).join('\n').trim();
	const chapterDraft = chapterBody ?? (chapterExcerpt === null ? '' : chapterBodyOf(chapterExcerpt));
	const chapterBodyPages = chapterExcerpt !== null ? pdfPages(parseFountain(chapterExcerpt)) : [];
	const chapterBodyLineOffset = (() => {
		if (chapterExcerpt === null) return 0;
		const afterHeading = chapterExcerpt.split('\n').slice(1);
		let blanks = 0;
		while (blanks < afterHeading.length && afterHeading[blanks].trim() === '') blanks++;
		return 1 + blanks;
	})();
	const chapterPageOfLine = (bodyLine: number) => {
		const line = bodyLine + chapterBodyLineOffset;
		for (let i = 0; i < chapterBodyPages.length; i++) {
			if (chapterBodyPages[i].some((el) => line >= el.line && line < el.line + sceneElementSpan(el))) return i + 1;
		}
		for (let i = 0; i < chapterBodyPages.length; i++) {
			if (chapterBodyPages[i].some((el) => el.line > line)) return i + 1;
		}
		return Math.max(1, chapterBodyPages.length);
	};
	const chapterLineOfPage = (page: number) => {
		const idx = page - 1;
		if (idx < 0 || idx >= chapterBodyPages.length) return 0;
		const first = chapterBodyPages[idx][0];
		return first ? first.line - chapterBodyLineOffset : 0;
	};
	/** Chapter pages: the scenes pointing at this chapter, in script order. */
	const chapterScenes = plugin.indexer
		.getAll('scene', record.project)
		.filter((sc) => sc.sceneChapter !== '' && plugin.indexer.resolve(sc.sceneChapter, sc.path)?.path === record.path)
		.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));
	const isSession = roleOf(record.type) === 'anchor';
	const isBeat = roleOf(record.type) === 'beat';
	const vocab = ENTITY_TAGS[record.type];
	const allTags = [...new Set([...vocab, ...record.loomTags])];
	const sessions = project ? plugin.indexer.getAll(anchorType, project.root) : [];
	const targetRecords = project ? plugin.indexer.getAll(undefined, project.root) : [];

	// This anchor's chronological number: its 1-based position among all the
	// project's anchors — sessions ordered by date, chapters by their manual
	// sequence. Computed live (never stored), so it self-corrects when one is
	// deleted or reordered. Ties fall back to creation time, then path.
	const anchorKey = (r: EntityRecord) =>
		kindFeatures.anchorOrder === 'sequence' ? r.seq ?? r.created : r.date?.sortKey ?? 0;
	const sessionNumber = isSession
		? [...sessions]
				.sort(
					(a, b) =>
						anchorKey(a) - anchorKey(b) || a.created - b.created || a.path.localeCompare(b.path)
				)
				.findIndex((s) => s.path === record.path) + 1
		: 0;

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

	/** Chapter page's Title field: writes straight into the script's `#`
	 *  section line — the note itself is updated by the sync that follows,
	 *  not directly here, so the script stays the one place that authors it. */
	const commitChapterTitle = async () => {
		const entered = name.trim();
		if (entered === '' || entered === record.name || !project || record.type !== 'chapter') {
			setName(record.name);
			return;
		}
		await editScriptAndSync(plugin, project, (raw) => renameSectionTitle(raw, record.chapterId, entered));
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
		if (record.type === 'session' && project && value !== '') {
			const base = sessionFileName(project, value);
			const parent = file.parent?.path ?? '';
			const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
			if (newPath !== file.path && !plugin.app.vault.getAbstractFileByPath(newPath)) {
				await plugin.app.fileManager.renameFile(file, newPath);
			}
		}
	};

	const commitDisplayTitle = (raw: string = displayTitle) => {
		const value = raw.trim();
		if (value === record.displayTitle) return;
		writeFm((fm) => {
			setLoomKey(fm, FM.displayTitle, value);
		});
		// A section never exports, so the title has to reach the script as its
		// own centered-bold line — otherwise editing this field changed nothing
		// anyone would ever see in the output.
		if (project) void pushChapterTitles(plugin, project);
	};

	/** Scene page: INT./EXT. and time-of-day are plain script-heading text —
	 *  no entity behind them, so a commit is just a heading rewrite. */
	const commitSceneIntExt = (raw: string = sceneIntExt) => {
		if (!project || record.type !== 'scene') return;
		const value = raw.trim();
		if (value === record.sceneIntExt) return;
		void editScriptAndSync(plugin, project, (r) => setSceneHeadingParts(r, record.sceneId, { intExt: value }));
	};
	const commitSceneTime = (raw: string = sceneTime) => {
		if (!project || record.type !== 'scene') return;
		const value = raw.trim();
		if (value === record.sceneTime) return;
		void editScriptAndSync(plugin, project, (r) => setSceneHeadingParts(r, record.sceneId, { timeOfDay: value }));
	};

	/** A confirm dialog that resolves to whether the user actually confirmed —
	 *  `ConfirmModal` only takes an onConfirm callback, so this wraps its
	 *  close in a Promise for call sites that need to branch on the answer
	 *  (aborting an in-flight commit on Cancel) rather than fire-and-forget. */
	const confirmDialog = (heading: string, detail: string, confirmText: string): Promise<boolean> =>
		new Promise((resolve) => {
			let confirmed = false;
			const modal = new ConfirmModal(
				plugin.app,
				heading,
				detail,
				() => {
					confirmed = true;
				},
				confirmText
			);
			const close = modal.onClose.bind(modal);
			modal.onClose = () => {
				close();
				resolve(confirmed);
			};
			modal.open();
		});

	/**
	 * Scene page: commits the Location + Sublocation fields together (they're
	 * interdependent — changing one can mean reparenting the other).
	 *
	 * Location/Sublocation ARE the linked entity's Name field, same as
	 * everywhere else in the app: if a location/sublocation is already linked
	 * to this scene, editing the text renames THAT entity rather than
	 * creating a differently-named duplicate and silently detaching the old
	 * one. Only when nothing is linked yet does it fall back to matching an
	 * existing location by name, or creating a new one.
	 *
	 * A rename that would land on an ALREADY-linked entity's own name asks
	 * first (`resolveOrRename`'s confirm step, below) — that entity may be
	 * referenced by other scenes too, so silently renaming it everywhere off
	 * one scene's heading edit was a trap. Cancelling reverts the field(s)
	 * that would have been renamed and aborts the whole commit rather than
	 * leaving Location and Sublocation half-applied against each other.
	 */
	const commitSceneLocation = async () => {
		if (!project || record.type !== 'scene') return;
		const mainName = sceneMain.trim();
		if (mainName === '') return;
		const subName = sceneSub.trim();
		const mainKey = mainName.toLowerCase();
		const topLevel = plugin.indexer.getAll('location', record.project).filter((r) => r.parentLocation === null);

		/** Null return means the user cancelled a rename confirmation — the
		 *  caller aborts rather than proceeding with a half-decided commit. */
		const resolveOrRename = async (
			name: string,
			key: string,
			current: EntityRecord | null,
			candidates: EntityRecord[],
			onCreate: () => Promise<EntityRecord>,
			kind: string
		): Promise<EntityRecord | null> => {
			if (current) {
				if (current.name.trim().toLowerCase() === key) return current;
				const other = candidates.find((r) => r.name.trim().toLowerCase() === key && r.path !== current.path);
				if (other) return other;
				const ok = await confirmDialog(
					`Rename "${current.name}" to "${name}"?`,
					`This ${kind} is renamed everywhere it's referenced, not just on this scene's heading.`,
					'Rename'
				);
				if (!ok) return null;
				await renameEntityRecord(plugin, project, current, name);
				return { ...current, name };
			}
			const existing = candidates.find((r) => r.name.trim().toLowerCase() === key);
			return existing ?? (await onCreate());
		};

		const currentSub = initialSceneLocationParent ? initialSceneLocation : null;
		const currentMain = initialSceneLocationParent ?? initialSceneLocation;
		const mainRecord = await resolveOrRename(
			mainName,
			mainKey,
			currentMain,
			topLevel,
			async () => {
				const created = await createEntity(plugin, project, 'location', {
					name: mainName,
					tag: '',
					date: '',
					description: '',
				});
				return { ...pcGroupStub(record.project), path: created.path, name: mainName, type: 'location' };
			},
			'location'
		);
		if (!mainRecord) {
			setSceneMain(currentMain?.name ?? '');
			return;
		}

		let target = mainRecord;
		if (subName !== '') {
			const subKey = subName.toLowerCase();
			const siblings = plugin.indexer
				.getAll('location', record.project)
				.filter(
					(r) =>
						r.parentLocation !== null &&
						plugin.indexer.resolve(r.parentLocation, r.path)?.path === mainRecord.path
				);
			const subUnderSameParent =
				currentSub &&
				currentSub.parentLocation != null &&
				plugin.indexer.resolve(currentSub.parentLocation, currentSub.path)?.path === mainRecord.path;
			if (subUnderSameParent) {
				const resolved = await resolveOrRename(
					subName,
					subKey,
					currentSub,
					siblings,
					async () => {
						const created = await createEntity(plugin, project, 'location', {
							name: subName,
							tag: '',
							date: '',
							description: '',
							parentLocation: linkTargetOf(mainRecord),
						});
						return {
							...pcGroupStub(record.project),
							path: created.path,
							name: subName,
							type: 'location',
							parentLocation: linkTargetOf(mainRecord),
						};
					},
					'sublocation'
				);
				if (!resolved) {
					setSceneSub(currentSub?.name ?? '');
					return;
				}
				target = resolved;
			} else if (currentSub) {
				// The main location changed while a sublocation was already
				// linked — follow it onto the new parent instead of spawning a
				// second sublocation with the same name.
				const other = siblings.find((r) => r.name.trim().toLowerCase() === subKey);
				if (other) target = other;
				else {
					if (currentSub.name.trim().toLowerCase() !== subKey) {
						const ok = await confirmDialog(
							`Rename "${currentSub.name}" to "${subName}"?`,
							"This sublocation is renamed everywhere it's referenced, not just on this scene's heading.",
							'Rename'
						);
						if (!ok) {
							setSceneSub(currentSub.name);
							return;
						}
					}
					await reparentLocation(currentSub, mainRecord);
					target = { ...currentSub, name: subName, parentLocation: linkTargetOf(mainRecord) };
					if (currentSub.name.trim().toLowerCase() !== subKey) {
						await renameEntityRecord(plugin, project, target, subName);
					}
				}
			} else {
				const existing = siblings.find((r) => r.name.trim().toLowerCase() === subKey);
				target =
					existing ??
					(await (async () => {
						const created = await createEntity(plugin, project, 'location', {
							name: subName,
							tag: '',
							date: '',
							description: '',
							parentLocation: linkTargetOf(mainRecord),
						});
						return {
							...pcGroupStub(record.project),
							path: created.path,
							name: subName,
							type: 'location',
							parentLocation: linkTargetOf(mainRecord),
						};
					})());
			}
		}

		writeFm((fm) => setLoomKey(fm, FM.sceneLocation, `[[${linkTargetOf(target)}]]`));
		void editScriptAndSync(plugin, project, (raw) =>
			setSceneHeadingParts(raw, record.sceneId, { location: joinLocationSub(mainRecord.name, subName) })
		);
	};

	/**
	 * The Sublocation field's own blur handler — clearing it (while one was
	 * actually linked) used to just detach it from this scene's heading and
	 * leave the sublocation's own note behind, orphaned but still sitting in
	 * the vault. Now it asks first, since "clear the field" reads as "I don't
	 * want this sublocation" rather than "keep the note around unreferenced".
	 * Reverts the field immediately (so it doesn't sit visually empty while
	 * the vault still points at the old sublocation) and only actually clears
	 * it — deleting the note — if the user confirms.
	 */
	const commitSceneSubBlur = () => {
		const currentSub = initialSceneLocationParent ? initialSceneLocation : null;
		if (sceneSub.trim() === '' && currentSub) {
			const subName = currentSub.name;
			setSceneSub(subName);
			void confirmDialog(
				`Delete "${subName}" sublocation?`,
				"Clearing this field removes the sublocation's own note, not just this scene's heading. The note is moved to the trash.",
				'Delete'
			).then((ok) => {
				if (!ok) return;
				setSceneSub('');
				void commitSceneLocation().then(() => {
					const f = plugin.app.vault.getFileByPath(currentSub.path);
					if (!f) return;
					void purgeEntityReferences(plugin, currentSub.path, currentSub.project).finally(() =>
						plugin.app.fileManager.trashFile(f)
					);
				});
			});
			return;
		}
		void commitSceneLocation();
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
						n.group.length > 0 ||
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
					if (n.group.length > 0) out.group = n.group.map(asLink);
					else delete out.group;
					if (n.seq !== null) out.seq = n.seq;
					return out;
				})
		);
	};

	// Quest objectives: written to `loomObjectives` as `{ name, finishedOn? }`.
	// Empty rows (no name, no session) are dropped on commit.
	const commitObjectives = (next: ObjectiveDraft[]) => {
		setObjectives(next);
		editFmList(record.path, FM.objectives, () =>
			next
				.filter((o) => o.name.trim() !== '' || o.finishedOn !== '')
				.map((o) => {
					const out: Record<string, unknown> = { name: o.name };
					if (o.finishedOn !== '') out.finishedOn = `[[${o.finishedOn}]]`;
					return out;
				})
		);
	};

	// Objective reorder (active sublist): live sliding modeled on the sublocation
	// grip. `active`/`resolved` are the two draft partitions; a drop rewrites the
	// stored list as reordered-actives followed by the resolved ones.
	const objRowStyle = (i: number, count: number): CSSProperties | undefined => {
		if (!objDrag) return undefined;
		const slot = objDragRef.current?.slot ?? 40;
		if (objDrag.from === i)
			return { transform: `translateY(${objDrag.dy}px)`, position: 'relative', zIndex: 2 };
		const { from, over } = objDrag;
		let sh = 0;
		if (from < i && i <= over) sh = -1;
		else if (over <= i && i < from) sh = 1;
		void count;
		return sh !== 0 ? { transform: `translateY(${sh * slot}px)` } : undefined;
	};
	const objGrip = (i: number, active: ObjectiveDraft[], resolved: ObjectiveDraft[]) => (
		<span
			className="loom-subloc-grip"
			onPointerDown={(e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const rowEl = e.currentTarget.closest('[data-obj-row]');
				const row = rowEl instanceof HTMLElement ? rowEl : null;
				const rows = row?.parentElement
					? [...row.parentElement.querySelectorAll(':scope > [data-obj-row]')]
					: [];
				const mids = rows.map((r) => {
					const b = r.getBoundingClientRect();
					return b.top + b.height / 2;
				});
				objDragRef.current = { startY: e.clientY, slot: (row?.offsetHeight ?? 40) + 8, mids };
				setObjDrag({ from: i, over: i, dy: 0 });
			}}
			onPointerMove={(e) => {
				const start = objDragRef.current;
				if (!start) return;
				const dy = e.clientY - start.startY;
				const over = Math.max(
					0,
					Math.min(active.length - 1, start.mids.filter((m) => m < e.clientY).length)
				);
				setObjDrag((cur) => (cur && (cur.over !== over || cur.dy !== dy) ? { ...cur, over, dy } : cur));
			}}
			onPointerUp={() => {
				const drag = objDrag;
				objDragRef.current = null;
				setObjDrag(null);
				if (!drag || drag.from === drag.over) return;
				const nextActive = [...active];
				const [moved] = nextActive.splice(drag.from, 1);
				nextActive.splice(drag.over, 0, moved);
				commitObjectives([...nextActive, ...resolved]);
			}}
			onPointerCancel={() => {
				objDragRef.current = null;
				setObjDrag(null);
			}}
		>
			<Icon name="grip-vertical" />
		</span>
	);

	// Session attendance: PC characters offered as toggle chips. A PC who died
	// in an earlier session is no longer offered in sessions after it.
	const attendancePcs = isSession
		? plugin.indexer
				.getAll('character', record.project)
				.filter((c) => c.loomTags.includes(PC_TAG))
				.filter((c) => {
					if (c.alive || !c.deathSession || !record.date) return true;
					const death = plugin.indexer.resolve(c.deathSession, c.path);
					if (!death || roleOf(death.type) !== 'anchor' || !death.date) return true;
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
	// A quest resolves against whatever unit play/writing actually happens in:
	// Sessions in a Player/GM project, Scenes in a Writer one (chapters have no
	// date or single sitting of their own — the scene is where a quest is
	// actually received or completed). `questAnchorRole` is what a resolved
	// link must be to count as valid.
	const questAnchorType = scriptMode ? beatType : anchorType;
	const questAnchorRole = scriptMode ? 'beat' : 'anchor';
	const questAnchorsSorted = (project ? plugin.indexer.getAll(questAnchorType, project.root) : [])
		.slice()
		.sort((a, b) =>
			scriptMode ? (a.seq ?? a.created) - (b.seq ?? b.created) : (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0)
		);
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

	// --- Regions: a grouping layer above locations (item "Part of region"). -----
	const isRegion = record.type === 'region';
	// Regions available to pick as a location's "Part of region".
	const regions = (isLocation || isRegion) && project ? plugin.indexer.getAll('region', project.root) : [];
	const currentRegion = isLocation && record.region ? plugin.indexer.resolve(record.region, record.path) : null;
	const setLocationRegion = (target: string) => {
		const f = plugin.app.vault.getFileByPath(record.path);
		if (!f) return;
		void plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) =>
			setLoomKey(fm, FM.region, `[[${target}]]`)
		);
	};
	const clearLocationRegion = () => {
		const f = plugin.app.vault.getFileByPath(record.path);
		if (!f) return;
		void plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
			for (const k of Object.keys(fm)) {
				const lower = k.toLowerCase();
				if (lower === 'loomregion' || lower === 'region') delete fm[k];
			}
		});
	};
	// Region page: its member locations, ordered by the region's `regionOrder`.
	const regionLocations = (() => {
		if (!isRegion || !project) return [];
		const orderIdx = new Map<string, number>(
			record.regionOrder
				.map((lp, i) => [plugin.indexer.resolve(lp, record.path)?.path, i] as const)
				.filter((e): e is [string, number] => e[0] !== undefined)
		);
		return plugin.indexer
			.getAll('location', project.root)
			.filter((l) => l.region !== null && plugin.indexer.resolve(l.region, l.path)?.path === record.path)
			.sort(
				(a, b) =>
					(orderIdx.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
						(orderIdx.get(b.path) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)
			);
	})();
	const writeRegionOrder = (ordered: EntityRecord[]) => {
		writeFm((fm) => setLoomKey(fm, FM.regionOrder, ordered.map((s) => `[[${linkTargetOf(s)}]]`)));
	};
	/** Sets a location's region to this region (region page "Add location"). */
	const addRegionLocation = (target: string) => {
		const rec = plugin.indexer.resolve(target, record.path);
		if (!rec) return;
		const f = plugin.app.vault.getFileByPath(rec.path);
		if (!f) return;
		void (async () => {
			await plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) =>
				setLoomKey(fm, FM.region, `[[${linkTargetOf(record)}]]`)
			);
			writeRegionOrder([...regionLocations, rec]);
		})();
	};
	/** Removes a location from this region (clears its `region`). */
	const removeRegionLocation = (l: EntityRecord) => {
		const f = plugin.app.vault.getFileByPath(l.path);
		if (!f) return;
		void plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
			for (const k of Object.keys(fm)) {
				const lower = k.toLowerCase();
				if (lower === 'loomregion' || lower === 'region') delete fm[k];
			}
		});
		writeRegionOrder(regionLocations.filter((o) => o.path !== l.path));
	};
	/** Whether a place location falls under this region (it or an ancestor is a
	 *  member) — mirrors the location `places` ancestor-propagation, one layer up. */
	const placeInThisRegion = (place: EntityRecord): boolean => {
		let cur: EntityRecord | null = place;
		for (let guard = 0; guard < 25 && cur !== null; guard++) {
			if (
				cur.type === 'location' &&
				cur.region !== null &&
				plugin.indexer.resolve(cur.region, cur.path)?.path === record.path
			) {
				return true;
			}
			cur = cur.parentLocation ? plugin.indexer.resolve(cur.parentLocation, cur.path) : null;
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
	/** Reparents an ARBITRARY location entity onto a new parent (unlike
	 *  `setParentLocation`, which always acts on this page's own `record`) —
	 *  used by the Scene page's modular location editor when a scene's main
	 *  location changes while a sublocation stays linked, so that same
	 *  sublocation note follows rather than a second one being created. */
	const reparentLocation = async (rec: EntityRecord, parent: EntityRecord) => {
		const f = plugin.app.vault.getFileByPath(rec.path);
		if (!f) return;
		await plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
			setLoomKey(fm, FM.parentLocation, `[[${linkTargetOf(parent)}]]`);
		});
		await renameLocationFile(rec, parent.name);
	};
	/** "Turn to a sublocation": fuzzy-searchable picker over every other
	 *  location (including sublocations — the whole child hierarchy moves
	 *  along), minus this location's own descendants so a cycle can't be
	 *  built. A search, not a plain menu — projects can get huge. */
	/** The project's Maps store (`Entities/Maps/<Project> Maps.json`), or null. */
	const mapFileFor = (): TFile | null => (project ? findMapsFile(plugin.app, project) : null);
	const zoneIsThisLocation = (z: unknown): boolean => {
		const loc = (z as { location?: unknown })?.location;
		if (typeof loc !== 'string' || loc === '') return false;
		return plugin.indexer.resolve(loc, record.path)?.path === record.path;
	};
	const zonesOf = (m: unknown): unknown[] => {
		const zs = (m as { zones?: unknown })?.zones;
		return Array.isArray(zs) ? zs : [];
	};
	const readMapData = async (): Promise<{ file: TFile; data: { maps?: unknown[]; zones?: unknown[] } } | null> => {
		const file = mapFileFor();
		if (!file) return null;
		try {
			const data = JSON.parse(await plugin.app.vault.read(file)) as { maps?: unknown[]; zones?: unknown[] };
			return { file, data };
		} catch {
			return null;
		}
	};
	/** Whether this location has a zone on any of the project's maps. */
	const locationHasZone = async (): Promise<boolean> => {
		const r = await readMapData();
		if (!r) return false;
		const all = Array.isArray(r.data.maps)
			? r.data.maps.flatMap(zonesOf)
			: Array.isArray(r.data.zones)
				? r.data.zones
				: [];
		return all.some(zoneIsThisLocation);
	};
	/** Removes this location's zones from every map, returning whether any existed.
	 *  A location becoming a sublocation can't own a map zone (zones associate a
	 *  main location only). */
	const dropMapZonesForThisLocation = async (): Promise<boolean> => {
		const r = await readMapData();
		if (!r) return false;
		const { file, data } = r;
		if (Array.isArray(data.maps)) {
			let changed = false;
			const maps = data.maps.map((m) => {
				const zs = zonesOf(m);
				const kept = zs.filter((z) => !zoneIsThisLocation(z));
				if (kept.length !== zs.length) changed = true;
				return { ...(m as Record<string, unknown>), zones: kept };
			});
			if (!changed) return false;
			await plugin.app.vault.modify(file, JSON.stringify({ ...data, maps }, null, '\t'));
			return true;
		}
		if (Array.isArray(data.zones)) {
			const kept = data.zones.filter((z) => !zoneIsThisLocation(z));
			if (kept.length === data.zones.length) return false;
			await plugin.app.vault.modify(file, JSON.stringify({ ...data, zones: kept }, null, '\t'));
			return true;
		}
		return false;
	};
	const openTurnIntoPicker = () => {
		const candidates = projectLocations
			.filter((l) => l.path !== record.path && !descendsFromThis(l))
			.sort((a, b) => a.name.localeCompare(b.name));
		new RecordSuggestModal(
			plugin.app,
			candidates,
			(l) => {
				const target = linkTargetOf(l);
				// Warn first if this location has a zone on the map — it gets deleted.
				void (async () => {
					const zoneExists = await locationHasZone();
					if (zoneExists) {
						new ConfirmModal(
							plugin.app,
							'Turn into a sublocation?',
							'This location has a zone on the map. Turning it into a sublocation will ' +
								'delete that zone from the map.',
							() => {
								void (async () => {
									await dropMapZonesForThisLocation();
									setParentLocation(target);
								})();
							},
							'Turn into sublocation'
						).open();
					} else {
						setParentLocation(target);
					}
				})();
			},
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
	// Location page: the characters serving a faction AT this location — read
	// from every faction's `members` whose per-membership `location` is this one.
	const locationFactionRows =
		record.type === 'location'
			? plugin.indexer
					.getAll('faction', record.project)
					.flatMap((faction) =>
						faction.members
							.filter(
								(m) =>
									m.location !== null &&
									plugin.indexer.resolve(m.location, faction.path)?.path === record.path
							)
							.map((m) => ({
								faction,
								role: m.role,
								character: plugin.indexer.resolve(m.linkpath, faction.path),
							}))
					)
					.filter((r): r is { faction: EntityRecord; role: string; character: EntityRecord } =>
						r.character != null && r.character.type === 'character'
					)
					.sort(
						(a, b) =>
							a.faction.name.localeCompare(b.faction.name) ||
							a.character.name.localeCompare(b.character.name)
					)
			: [];
	// Events shown on this page. For a location: every event placed here OR in
	// any descendant location (ancestor propagation) — via the note's `places`.
	// For other entities (character, item, faction): events whose `involved`
	// resolves to it. Newest session first, lore events last; hub-row rendered.
	const showsEvents =
		record.type === 'character' ||
		record.type === 'item' ||
		record.type === 'faction' ||
		record.type === 'location' ||
		record.type === 'region' ||
		record.type === 'quest';
	const pageEventEntries: LocNoteEntry[] = showsEvents
		? plugin.indexer
				.getAll(beatType, record.project)
				.flatMap((owner) =>
					owner.sessionNotes
						.map((n, idx) => ({ owner, idx, session: n.session, text: n.text, seq: n.seq, involved: n.involved, group: n.group, places: n.places }))
						.filter((e) =>
							isLocation
								? e.places.some((lp) => {
										const p = plugin.indexer.resolve(lp, owner.path);
										return p?.type === 'location' && (p.path === record.path || descendsFromThis(p));
									})
								: isRegion
									? e.places.some((lp) => {
											const p = plugin.indexer.resolve(lp, owner.path);
											return p?.type === 'location' && placeInThisRegion(p);
										})
									: [...e.involved, ...e.group].some(
											(lp) => plugin.indexer.resolve(lp, owner.path)?.path === record.path
										)
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
				const session = ses && roleOf(ses.type) === 'anchor' ? ses : null;
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

		// Items section (character/location): an ordered `loomItems` list of item
		// links, each editable inline (name renames the item, description writes
		// its own file) and drag-reorderable here.
		const showsItems = record.type === 'character' || record.type === 'location';
		const itemRecords = showsItems
			? record.items
					.map((lp) => plugin.indexer.resolve(lp, record.path))
					.filter((r): r is EntityRecord => r != null && r.type === 'item')
			: [];
		// "Items in sublocations": every descendant sublocation's items, grouped by
		// the holding sublocation (persistent — shown even if the same item is also
		// on this location directly), like events propagate up via `places`.
		const inheritedGroups: { holder: EntityRecord; items: EntityRecord[] }[] = isLocation
			? projectLocations
					.filter((l) => descendsFromThis(l))
					.map((subloc) => ({
						holder: subloc,
						items: subloc.items
							.map((lp) => plugin.indexer.resolve(lp, subloc.path))
							.filter((it): it is EntityRecord => it != null && it.type === 'item')
							.sort((a, b) => a.name.localeCompare(b.name)),
					}))
					.filter((g) => g.items.length > 0)
					.sort((a, b) => recordLabel(a.holder, project).localeCompare(recordLabel(b.holder, project)))
			: [];
		// A writer project's Scenes section: this location page never authored
		// these — they're read-only, following straight from `sceneLocation`
		// (the scene's own most-specific place) the same way Items-in-
		// sublocations follows `loomItems`.
		const locationScenes: EntityRecord[] = isLocation
			? plugin.indexer
					.getAll('scene', record.project)
					.filter((sc) => sc.sceneLocation !== '' && plugin.indexer.resolve(sc.sceneLocation, sc.path)?.path === record.path)
					.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created))
			: [];
		const inheritedSceneGroups: { holder: EntityRecord; scenes: EntityRecord[] }[] = isLocation
			? projectLocations
					.filter((l) => descendsFromThis(l))
					.map((subloc) => ({
						holder: subloc,
						scenes: plugin.indexer
							.getAll('scene', record.project)
							.filter(
								(sc) =>
									sc.sceneLocation !== '' &&
									plugin.indexer.resolve(sc.sceneLocation, sc.path)?.path === subloc.path
							)
							.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created)),
					}))
					.filter((g) => g.scenes.length > 0)
					.sort((a, b) => recordLabel(a.holder, project).localeCompare(recordLabel(b.holder, project)))
			: [];
		const currentItemLinks = () => itemRecords.map((r) => `[[${linkTargetOf(r)}]]`);
		const setItemLinks = (links: string[]) => writeFm((fm) => setLoomKey(fm, FM.items, links));
		const addItemLink = (linkTarget: string) => {
			if (currentItemLinks().includes(`[[${linkTarget}]]`)) return;
			setItemLinks([...currentItemLinks(), `[[${linkTarget}]]`]);
		};
		const removeItem = (item: EntityRecord) =>
			setItemLinks(itemRecords.filter((r) => r.path !== item.path).map((r) => `[[${linkTargetOf(r)}]]`));
		const commitItemsOrder = (next: EntityRecord[]) =>
			setItemLinks(next.map((r) => `[[${linkTargetOf(r)}]]`));
		const writeItemDescription = (item: EntityRecord, value: string) => {
			const f = plugin.app.vault.getFileByPath(item.path);
			if (!f) return;
			plugin.app.fileManager
				.processFrontMatter(f, (fm: Record<string, unknown>) => setLoomKey(fm, FM.description, value))
				.catch((e) => {
					console.error('Loom Loom: failed to save item description', e);
					new Notice('Could not save the item description.');
				});
		};
		// A character-specific copy of the row's item: a new item note owned by
		// this character (`record`). It replaces the original in this page's list
		// and opens for editing its alternative description.
		const makeItemCopy = async (item: EntityRecord) => {
			if (!project) return;
			const original = item.itemOrigin
				? plugin.indexer.resolve(item.itemOrigin, item.path) ?? item
				: item;
			try {
				const copy = await createItemCopy(plugin, project, original, record);
				setItemLinks(
					itemRecords.map((r) => (r.path === item.path ? `[[${copy.basename}]]` : `[[${linkTargetOf(r)}]]`))
				);
				view.openEntity(copy.path);
			} catch (e) {
				console.error('Loom Loom: failed to create character-specific item', e);
				new Notice('Could not create the item copy.');
			}
		};
		// Reverse of the Items section: on an item page, the characters and
		// locations that carry this item (via their `loomItems`). Chips + an
		// "Add to …" search; adding/removing rewrites the holder's `loomItems`.
		const showsItemHolders = record.type === 'item';
		const holderCharacters =
			showsItemHolders && project
				? plugin.indexer
						.getAll('character', project.root)
						.filter((c) => c.items.some((lp) => plugin.indexer.resolve(lp, c.path)?.path === record.path))
				: [];
		const holderLocations =
			showsItemHolders && project
				? plugin.indexer
						.getAll('location', project.root)
						.filter((l) => l.items.some((lp) => plugin.indexer.resolve(lp, l.path)?.path === record.path))
				: [];
		const addItemToHolder = (holder: EntityRecord) => {
			const f = plugin.app.vault.getFileByPath(holder.path);
			if (!f) return;
			void plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				const cur = fmLoomValue(fm, FM.items);
				const arr = Array.isArray(cur) ? [...(cur as unknown[])] : [];
				const present = arr.some(
					(x) =>
						typeof x === 'string' &&
						plugin.indexer.resolve(extractLinkpath(x) ?? '', holder.path)?.path === record.path
				);
				if (!present) arr.push(`[[${linkTargetOf(record)}]]`);
				setLoomKey(fm, FM.items, arr);
			});
		};
		const removeItemFromHolder = (holder: EntityRecord) => {
			const f = plugin.app.vault.getFileByPath(holder.path);
			if (!f) return;
			void plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				const cur = fmLoomValue(fm, FM.items);
				const arr = Array.isArray(cur) ? (cur as unknown[]) : [];
				setLoomKey(
					fm,
					FM.items,
					arr.filter(
						(x) =>
							!(
								typeof x === 'string' &&
								plugin.indexer.resolve(extractLinkpath(x) ?? '', holder.path)?.path === record.path
							)
					)
				);
			});
		};
		// A character-specific item copy: original + owning-character links.
		const isItemCopy =
			record.type === 'item' && record.itemOrigin !== null && record.itemOwner !== null;
		const copyOriginal =
			isItemCopy && record.itemOrigin ? plugin.indexer.resolve(record.itemOrigin, record.path) : null;
		const copyOwner =
			isItemCopy && record.itemOwner ? plugin.indexer.resolve(record.itemOwner, record.path) : null;
		// Add an existing event to this page: involve this entity in the event's
		// first note (or, for a location page, add it to that note's places),
		// creating a session-less note if the event has none yet.
		const addExistingEventToPage = (event: EntityRecord) => {
			const f = plugin.app.vault.getFileByPath(event.path);
			if (!f) return;
			const key = isLocation ? 'places' : 'involved';
			const link = `[[${linkTargetOf(record)}]]`;
			plugin.app.fileManager
				.processFrontMatter(f, (fm: Record<string, unknown>) => {
					const cur = fmLoomValue(fm, FM.sessionNotes);
					const arr = Array.isArray(cur) ? [...(cur as unknown[])] : [];
					if (arr.length === 0) {
						arr.push({ session: '', text: '', seq: Date.now(), [key]: [link] });
					} else {
						const first = arr[0];
						const note: Record<string, unknown> =
							typeof first === 'object' && first !== null
								? { ...(first as Record<string, unknown>) }
								: { session: '', text: typeof first === 'string' ? first : '' };
						const list = Array.isArray(note[key]) ? [...(note[key] as unknown[])] : [];
						list.push(link);
						note[key] = list;
						arr[0] = note;
					}
					setLoomKey(fm, FM.sessionNotes, arr);
				})
				.catch((e) => {
					console.error('Loom Loom: failed to add event to page', e);
					new Notice('Could not add the event.');
				});
		};
		const itemRow = (item: EntityRecord, i: number) => {
			const grabbed = seqDrag?.group === 'items' && seqDrag.from === i;
			const menuKey = 'item:' + item.path;
			// A character-specific copy's name is derived (original + owner), so it
			// is shown read-only here and can't be re-copied.
			const rowIsCopy = item.itemOrigin !== null;
			return (
				<div
					key={item.path}
					className={grabbed ? 'loom-locnote loom-locnote-dragging' : 'loom-locnote'}
					style={seqRowStyle('items', i)}
					data-seq-row=""
				>
					{seqGrip('items', i, itemRecords, commitItemsOrder)}
					<div className="loom-locnote-body">
						<div className="loom-locnote-head">
							{rowIsCopy ? (
								<span className="loom-hub-name loom-hub-name-static">{item.name}</span>
							) : (
								<input
									type="text"
									className="loom-hub-name"
									defaultValue={item.name}
									onBlur={(e) => renameEntity(item, e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') renameEntity(item, e.currentTarget.value);
									}}
								/>
							)}
							<button
								className="loom-nav-btn"
								aria-label="Open page"
								onClick={() => view.openEntity(item.path)}
							>
								→
							</button>
							<div className="loom-shell-spacer" />
							<div
								className={
									hubMenu === menuKey ? 'loom-hub-actions loom-hub-actions-open' : 'loom-hub-actions'
								}
							>
								{record.type === 'character' && !rowIsCopy ? (
									<button
										className="loom-nav-btn loom-item-copy-btn"
										aria-label="Replace with a character specific copy of this item"
										onClick={() => void makeItemCopy(item)}
									>
										<Icon name="layers-2" />
									</button>
								) : null}
								<button
									className="loom-nav-btn loom-entity-delete"
									aria-label="Delete this item"
									onClick={() =>
										new ConfirmModal(
											plugin.app,
											`Delete "${item.name}"?`,
											'The note is moved to the trash.',
											() => {
												const f = plugin.app.vault.getFileByPath(item.path);
												if (!f) return;
												void purgeEntityReferences(plugin, item.path, item.project).finally(() =>
													plugin.app.fileManager.trashFile(f)
												);
											},
											'Delete'
										).open()
									}
								>
									<Icon name="trash-2" />
								</button>
								<button
									className="loom-nav-btn"
									aria-label="Remove from this page"
									onClick={() => removeItem(item)}
								>
									✕
								</button>
							</div>
							<button
								className="loom-nav-btn"
								aria-label={hubMenu === menuKey ? 'Close actions' : 'Show actions'}
								onClick={() => setHubMenu(hubMenu === menuKey ? null : menuKey)}
							>
								{hubMenu === menuKey ? '>' : '<'}
							</button>
						</div>
						<div className="loom-note-text">
							<HubNoteText
								app={plugin.app}
								initial={item.description}
								names={linkNames}
								onOpenLink={openLinkTarget}
								onCreateEntity={createLinkEntity}
								onCommit={(v) => writeItemDescription(item, v)}
							/>
						</div>
					</div>
				</div>
			);
		};
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
	const endSeqDrag = (
		group: string,
		records: EntityRecord[],
		commit: boolean,
		onCommit?: (reordered: EntityRecord[], moved: EntityRecord) => void
	) => {
		seqDragRef.current = null;
		const drag = seqDrag;
		setSeqDrag(null);
		if (!commit || !drag || drag.group !== group || drag.from === drag.over) return;
		const next = [...records];
		const [moved] = next.splice(drag.from, 1);
		next.splice(drag.over, 0, moved);
		// Default order home is each record's loomSeq; callers with their own
		// stored order (e.g. a page's item list, or a script to rewrite) pass
		// onCommit instead — it also gets the single record that moved, since a
		// script rewrite only needs to relocate that one block.
		if (onCommit) onCommit(next, moved);
		else {
			const base = Date.now();
			next.forEach((r, i) => writeRecordSeq(r.path, base + i));
		}
	};
	/** The 6-dot grab handle placed before an entry's title. */
	const seqGrip = (
		group: string,
		i: number,
		records: EntityRecord[],
		onCommit?: (reordered: EntityRecord[], moved: EntityRecord) => void
	) => (
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
			onPointerUp={() => endSeqDrag(group, records, true, onCommit)}
			onPointerCancel={() => endSeqDrag(group, records, false, onCommit)}
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
				// Quests no longer author their own session notes — they take part in
				// events (their own Events section) and get their own Quests section
				// below, so they never appear in the session-note hub.
				.filter((owner) => owner.type !== 'quest')
				.flatMap((owner) =>
					owner.sessionNotes
						.map((n, idx) => ({ owner, idx, session: n.session, text: n.text, seq: n.seq, involved: n.involved, group: n.group, places: n.places }))
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
					.filter((r) => roleOf(r.type) === null)
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
	const writeEntryGroup = (en: LocNoteEntry, apply: (list: unknown[]) => unknown[]) => {
		writeOwnerNotes(en.owner, (arr) => {
			const item = arr[en.idx];
			if (typeof item === 'object' && item !== null) {
				const cur = (item as { group?: unknown }).group;
				const next = apply(Array.isArray(cur) ? cur : []);
				if (next.length > 0) (item as { group?: unknown }).group = next;
				else delete (item as { group?: unknown }).group;
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
				// Locations can be involved (a place discussed/featured in the event)
				// as well as a `places` entry (where it happened) — both are allowed.
				.filter((r) => roleOf(r.type) === null && r.path !== record.path)
				.sort((a, b) => a.name.localeCompare(b.name))
		: [];
	/** The current party (alive + active PCs, minus this page's own entity) —
	 *  what the virtual "Group" picker entry snapshots in one pick. */
	const groupPcs = project
		? plugin.indexer.getGroupMembers(project.root).filter((c) => c.path !== record.path)
		: [];
	/** The project's (possibly custom) display name of the virtual Group. */
	const groupName = project ? groupNameOf(project.config) : PC_GROUP_NAME;
	/** The virtual "Group" option row, hidden when it wouldn't add anyone or
	 *  the active type filter excludes characters. */
	const groupOption = (missing: number, filter: EntityType | null | undefined) =>
		missing > 0 && (filter == null || filter === 'character' || filter === 'faction')
			? [{ value: PC_GROUP_VALUE, label: groupName }]
			: [];
	/** Group chips link to the Group page, like entity chips link to theirs
	 *  (recording this page as the origin for the Group page's Back button). */
	const openGroupPage = project
		? () =>
				view.navigateTo(VIEW_GROUP, {
					project: project.root,
					origin: { type: view.getViewType(), state: view.getState() },
				})
		: undefined;
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
	// Writer projects: quests resolve against Scenes (script order, `seq`),
	// same as Sessions resolve against dates elsewhere. A quest's own
	// `questReceived`/`questOutcomeSession` is always a leaf (Scene or
	// Session, never a Chapter), so `anchorPositionKey` only needs the two
	// leaf cases; a Chapter page's OWN position is the special case, since
	// "as of this chapter" means "as of its last scene" (`chapterScenes` is
	// already sorted ascending by `seq`).
	const anchorPositionKey = (r: EntityRecord): number | null =>
		scriptMode ? r.seq ?? r.created : (r.date?.sortKey ?? null);
	const showsQuestSection = (isSession || record.type === 'scene') && project;
	const lastChapterScene = chapterScenes.length > 0 ? chapterScenes[chapterScenes.length - 1] : null;
	const asOf = scriptMode
		? record.type === 'chapter'
			? (lastChapterScene?.seq ?? lastChapterScene?.created ?? record.seq ?? record.created)
			: (record.seq ?? record.created)
		: (record.date?.sortKey ?? Number.MAX_SAFE_INTEGER);
	const sessionQuests = (showsQuestSection ? plugin.indexer.getAll('quest', project.root) : [])
		.map((q) => {
			const rec = q.questReceived !== null ? plugin.indexer.resolve(q.questReceived, q.path) : null;
			const recKey = rec ? anchorPositionKey(rec) : null;
			if (recKey !== null && recKey > asOf) return null; // not yet received then
			const out =
				q.questOutcomeSession !== null
					? plugin.indexer.resolve(q.questOutcomeSession, q.path)
					: null;
			const outKey = out ? anchorPositionKey(out) : null;
			const finished = q.questOutcome !== '' && outKey !== null && outKey <= asOf;
			// Three buckets: still active as of this session/scene, resolved on
			// THIS page (a Chapter counts any of its own scenes too), or resolved
			// on an earlier one ("Resolved previously").
			const resolvedHere =
				record.type === 'chapter'
					? out !== null && chapterScenes.some((sc) => sc.path === out.path)
					: out?.path === record.path;
			const state = !finished ? 'active' : resolvedHere ? 'resolvedThis' : 'resolvedPrev';
			return { quest: q, state };
		})
		.filter((e): e is { quest: EntityRecord; state: string } => e !== null)
		// Manual order (drag-reorderable), then chronological for the unstamped.
		.sort((a, b) => (a.quest.seq ?? a.quest.created) - (b.quest.seq ?? b.quest.created));

	// PC life state: unticking Alive reveals the death-session picker.
	// Gated on the kind: a writer project's cast has no party to be away from,
	// and a character's death is a scene rather than a flag.
	const isPc =
		record.type === 'character' && record.loomTags.includes(PC_TAG) && kindFeatures.pcLifecycle;
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
	/** Away from the party: inactive PCs are skipped by new virtual-Group picks
	 *  (existing group snapshots keep them — history stays as it was). */
	const setActive = (active: boolean) => {
		writeFm((fm) => {
			setLoomKey(fm, FM.active, active);
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
				options={[
					...(groupPcs.length > 0 && (!rel.filter || rel.filter === 'character' || rel.filter === 'faction')
						? [groupName]
						: []),
					...targetRecords
						.filter((r) => !rel.filter || r.type === rel.filter)
						.map((r) => draftLabel(r))
						.sort((a, b) => a.localeCompare(b)),
				]}
				onChange={(v) => {
					const next = [...relationships];
					next[i] = { ...rel, target: v };
					setRelationships(next);
				}}
				onPick={(v) => {
					const next = [...relationships];
					if (v === groupName) {
						// The virtual Group: this draft row becomes one relationship
						// of the same type per PC not already targeted by another row.
						const taken = new Set(relationships.filter((_, j) => j !== i).map((r) => r.target.trim()));
						const rows = groupPcs
							.filter((c) => !taken.has(draftLabel(c)))
							.map((c) => ({ ...rel, target: draftLabel(c) }));
						if (rows.length === 0) return;
						next.splice(i, 1, ...rows);
					} else {
						next[i] = { ...rel, target: v };
					}
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
												// Show the entity's display NAME in the field (not
												// its managed file name), while writing the link at
												// the correct basename — the index may not have the
												// new file yet, so display-name resolution would fail.
												const prefix = `${project.name} ${ENTITY_META[type].label} `;
												const display = created.basename.startsWith(prefix)
													? created.basename.slice(prefix.length)
													: created.basename;
												const next = relationships.map((r, j) =>
													j === i ? { ...rel, target: display } : r
												);
												setRelationships(next);
												writeFm((fm) => {
													setLoomKey(
														fm,
														FM.relationships,
														next
															.filter((r) => r.target.trim() !== '')
															.map((r) => ({
																type: r.type.trim() === '' ? 'related' : r.type.trim(),
																target: `[[${
																	r === next[i] ? created.basename : linkTargetFor(r.target)
																}]]`,
															}))
													);
												});
											},
										}).open(),
										project
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
		const hasNoteLocation = record.type === 'quest' || isBeat;
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
					{picked && roleOf(picked.type) === 'anchor' ? (
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
												new CreateEntityModal(plugin, anchorType, project, {
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
							options={[
								...groupOption(
									groupPcs.filter(
										(c) =>
											!note.involved.includes(linkTargetOf(c)) && !note.group.includes(linkTargetOf(c))
									).length,
									hubFilter['row:' + String(i)]
								),
								...involveTargets
									.filter(
										(t) =>
											!note.involved.includes(linkTargetOf(t)) && !note.group.includes(linkTargetOf(t))
									)
									.filter((t) => !hubFilter['row:' + String(i)] || t.type === hubFilter['row:' + String(i)])
									.map((t) => ({ value: linkTargetOf(t), label: t.name })),
							]}
							onPick={(name) => {
								if (name === PC_GROUP_VALUE) {
									// Snapshot the current party into the note's group list.
									const adds = groupPcs
										.map(linkTargetOf)
										.filter((n) => !note.involved.includes(n) && !note.group.includes(n));
									setNote({ group: [...note.group, ...adds] }, true);
								} else {
									setNote({ involved: [...note.involved, name] }, true);
								}
							}}
							action={
								project
									? {
											label: '+ Create new entity',
											onPick: () =>
												new EntityTypeSuggestModal(plugin, (type) =>
													new CreateEntityModal(plugin, type, project, {
														// A quest involved via a session-pinned note defaults its
														// "Received in session" to that session.
														...(picked && roleOf(picked.type) === 'anchor'
															? { receivedSession: picked }
															: {}),
														onCreated: (created) =>
															setNote({ involved: [...note.involved, created.basename] }, true),
													}).open(),
													project
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
								for (const t of projectTypes(project?.config).filter((t) => roleOf(t) === null)) {
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
					{note.involved.length > 0 || note.group.length > 0 ? (
						<div className="loom-tag-row">
							{note.group.length > 0 ? (
								<EntityChip
									plugin={plugin}
									record={project ? pcGroupStub(project.root, groupName) : null}
									label={groupName}
									onOpen={openGroupPage}
									onRemove={() => setNote({ group: [] }, true)}
									removeLabel="Remove the group"
								/>
							) : null}
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
									.sort(mainLocationFirst)
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
										label={target ? locationLabel(target, plugin) : key}
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
						{note.places.map((pl, pi) => {
							const placeRec = plugin.indexer.resolve(pl, record.path);
							return (
								<EntityChip
									key={pl}
									plugin={plugin}
									record={placeRec}
									label={placeRec ? locationLabel(placeRec, plugin) : pl}
									onRemove={() => setNote({ places: note.places.filter((_, j) => j !== pi) }, true)}
									removeLabel="Remove place"
								/>
							);
						})}
						<SearchableSelect
							placeholder="Add a place…"
							options={projectLocations
								.filter((l) => l.path !== record.path && !note.places.includes(linkTargetOf(l)))
								.sort(mainLocationFirst)
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
		/** Resolved paths of the note's group-snapshot members (chip is collapsed,
		 *  but they count as involved for picker dedupe/removal). */
		const groupPaths = new Set(
			en.group
				.map((lp) => plugin.indexer.resolve(lp, en.owner.path)?.path)
				.filter((p): p is string => p !== undefined)
		);
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
										if (!f) return;
										void purgeEntityReferences(plugin, en.owner.path, en.owner.project).finally(() =>
											plugin.app.fileManager.trashFile(f)
										);
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
												// One write covering both lists — the entity may be in the
												// note directly or via the group snapshot.
												const strip = (list: unknown[]) =>
													list.filter(
														(x) =>
															!(
																typeof x === 'string' &&
																plugin.indexer.resolve(extractLinkpath(x) ?? '', en.owner.path)?.path ===
																	record.path
															)
													);
												writeOwnerNotes(en.owner, (arr) => {
													const item = arr[en.idx];
													if (typeof item !== 'object' || item === null) return;
													const it = item as { involved?: unknown; group?: unknown };
													if (Array.isArray(it.involved)) it.involved = strip(it.involved);
													if (Array.isArray(it.group)) {
														const g = strip(it.group);
														if (g.length > 0) it.group = g;
														else delete it.group;
													}
												});
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
					options={[
								...groupOption(
									groupPcs.filter(
										(c) => !involved.some((iv) => iv.target?.path === c.path) && !groupPaths.has(c.path)
									).length,
									hubFilter[menuKey]
								),
								...hubTargets
									.filter(
										(t) => !involved.some((iv) => iv.target?.path === t.path) && !groupPaths.has(t.path)
									)
									.filter((t) => !hubFilter[menuKey] || t.type === hubFilter[menuKey])
									.map((t) => ({ value: linkTargetOf(t), label: t.name })),
							]}
							onPick={(name) => {
								if (name === PC_GROUP_VALUE) {
									// Snapshot the current party into the note's group list.
									const adds = groupPcs
										.filter(
											(c) => !involved.some((iv) => iv.target?.path === c.path) && !groupPaths.has(c.path)
										)
										.map(linkTargetOf);
									writeEntryGroup(en, (list) => [...list, ...adds.map((n) => `[[${n}]]`)]);
								} else {
									writeEntryInvolved(en, (list) => [...list, `[[${name}]]`]);
								}
							}}
							action={
								project
									? {
											label: '+ Create new entity',
											onPick: () => {
												// A quest created here inherits the note's session as its
												// "Received in session".
												const entrySession = en.session
													? plugin.indexer.resolve(en.session, en.owner.path)
													: null;
												new EntityTypeSuggestModal(plugin, (type) =>
													new CreateEntityModal(plugin, type, project, {
														...(entrySession && roleOf(entrySession.type) === 'anchor'
															? { receivedSession: entrySession }
															: {}),
														onCreated: (created) =>
															writeEntryInvolved(en, (list) => [...list, `[[${created.basename}]]`]),
													}).open(),
													project
												).open();
											},
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
								for (const t of projectTypes(project?.config).filter((t) => roleOf(t) === null)) {
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
						{involved.length > 0 || en.group.length > 0 ? (
							<div className="loom-tag-row">
								{en.group.length > 0 ? (
									<EntityChip
										plugin={plugin}
										record={project ? pcGroupStub(project.root, groupName) : null}
										label={groupName}
										onOpen={openGroupPage}
										onRemove={() => writeEntryGroup(en, () => [])}
										removeLabel="Remove the group"
									/>
								) : null}
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
								.sort(mainLocationFirst)
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
										label={target ? locationLabel(target, plugin) : key}
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

	// Events hub — rendered near the top on most entity pages, but pushed below
	// the location-only sections (Factions/Items/Sublocations) on a location page.
	const eventsSection =
		showsEvents && project ? (
			<div className="loom-field loom-field-sep">
				<span className="loom-field-label">{ENTITY_META[beatType].plural}</span>
				<div className="loom-hub-add-row">
					<SearchableSelect
						placeholder={`Add ${/^[aeiou]/.test(beatLabel) ? 'an' : 'a'} ${beatLabel}…`}
						options={plugin.indexer
							.getAll(beatType, record.project)
							.filter((ev) => !pageEventEntries.some((e) => e.owner.path === ev.path))
							.sort((a, b) => a.name.localeCompare(b.name))
							.map((ev) => ({ value: linkTargetOf(ev), label: ev.name }))}
						onPick={(linkTarget) => {
							const ev = plugin.indexer.resolve(linkTarget, record.path);
							if (ev) addExistingEventToPage(ev);
						}}
						action={{
							label: `+ Create new ${beatLabel}`,
							onPick: () =>
								new CreateEntityModal(plugin, beatType, project, {
									...(isLocation
										? { defaultPlace: linkTargetOf(record) }
										: { defaultInvolved: [linkTargetOf(record)] }),
									onCreated: () => {},
								}).open(),
						}}
					/>
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
		) : null;

	// Items hub — on a character page it sits right after the Faction(s) section;
	// on a location page it stays in the Factions → Items → Sublocations chain.
	const itemsSection =
		showsItems && project ? (
			<div className="loom-field loom-field-sep">
				<span className="loom-field-label">Items</span>
				<div className="loom-hub-add-row">
					<SearchableSelect
						placeholder="Add an item…"
						options={plugin.indexer
							.getAll('item', project.root)
							.filter((it) => !itemRecords.some((r) => r.path === it.path))
							.sort((a, b) => a.name.localeCompare(b.name))
							.map((it) => ({ value: linkTargetOf(it), label: it.name }))}
						onPick={(linkTarget) => addItemLink(linkTarget)}
						action={{
							label: '+ Create new item',
							onPick: () =>
								new CreateEntityModal(plugin, 'item', project, {
									onCreated: (created) => addItemLink(created.basename),
								}).open(),
						}}
					/>
				</div>
				{itemRecords.length > 0 ? (
					<div
						className={
							seqDrag?.group === 'items' ? 'loom-note-list loom-subloc-dragging' : 'loom-note-list'
						}
					>
						{itemRecords.map((item, i) => itemRow(item, i))}
					</div>
				) : null}
				{inheritedGroups.length > 0 ? (
					<div className="loom-inherited-items">
						<span className="loom-field-sublabel">Items in sublocations</span>
						{inheritedGroups.map((g) => (
							<div key={g.holder.path} className="loom-locnote-group loom-char-event-group">
								<div className="loom-tag-row loom-event-group-session">
									<EntityChip
										plugin={plugin}
										record={g.holder}
										label={recordLabel(g.holder, project)}
										onOpen={() => view.openEntity(g.holder.path)}
									/>
								</div>
								<div className="loom-event-nest loom-locfac-nest">
									{g.items.map((item) => (
										<span key={item.path} className="loom-locfac-member">
											<EntityChip plugin={plugin} record={item} onOpen={() => view.openEntity(item.path)} />
										</span>
									))}
								</div>
							</div>
						))}
					</div>
				) : null}
			</div>
		) : null;

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
							// A scene IS its stretch of the script — deleting the note
							// while leaving the writing behind would just resurrect the
							// note on the next parse, so the two go together.
							record.sceneId !== '' && scriptMode
								? 'The note is moved to the trash, and this scene is removed from the script.'
								: 'The note is moved to the trash.',
							() => {
								// Leave the page first so the view never sits on a
								// trashed file, then delete.
								const origin = view.origin;
								if (origin) view.navigateTo(origin.type, origin.state);
								else if (project) {
									view.navigateTo(VIEW_LIST, { project: project.root, entityType: record.type });
								}
								if (record.sceneId !== '' && scriptMode && project) {
									const sceneId = record.sceneId;
									void editScript(plugin, project, (raw) => removeScene(raw, sceneId));
								}
								void purgeEntityReferences(plugin, record.path, record.project).finally(() =>
									plugin.app.fileManager.trashFile(file)
								);
							},
							'Delete'
						).open()
					}
				>
					<Icon name="trash-2" />
				</button>
			</div>

			{/* A character-specific item copy has no editable name — it shows the
			    original item and the owning character as chips instead. */}
			{isItemCopy ? (
				<div className="loom-field">
					<span className="loom-field-label">Item</span>
					<div className="loom-tag-row">
						{copyOriginal ? (
							<EntityChip
								plugin={plugin}
								record={copyOriginal}
								onOpen={() => view.openEntity(copyOriginal.path)}
							/>
						) : (
							<span>{record.itemOrigin}</span>
						)}
						{copyOwner ? (
							<EntityChip
								plugin={plugin}
								record={copyOwner}
								onOpen={() => view.openEntity(copyOwner.path)}
							/>
						) : null}
					</div>
				</div>
			) : null}

			{!isSession && !isItemCopy && record.type !== 'scene' ? (
				<div className="loom-field">
					<div className="loom-name-alias-row">
						<label className="loom-name-col">
							{/* Chapters (and scenes, on their own modular heading editor)
							    are named by the script — their `#` section / scene
							    heading is the source of truth. That's about not
							    authoring a RIVAL copy of the text, not about the field
							    being read-only: a Chapter page edit here writes straight
							    into the script's `#` line (`renameSectionTitle`), and the
							    sync round-trips it back into this same field — modularly
							    editable everywhere, same as the rest of the plugin.
							    Labeled "Title" rather than "Name" when it's script-owned,
							    since that's what pairs with the chapter's editable
							    "Display title" below. */}
							<span className="loom-field-label">{scriptNamed ? 'Title' : 'Name'}</span>
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								onBlur={() => void (record.type === 'chapter' ? commitChapterTitle() : commitName())}
								onKeyDown={(e) => {
									if (e.key === 'Enter') void (record.type === 'chapter' ? commitChapterTitle() : commitName());
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

			{/* A scene's heading, broken into its modular parts instead of one
			    freeform line: INT./EXT. (a small autocomplete — INT./EXT./
			    INT./EXT. — arrow keys cycle, Enter picks), Location and
			    Sublocation (free text with existing-location suggestions;
			    editing an ALREADY-linked one renames that entity everywhere,
			    same as any other Name field, rather than creating a duplicate;
			    a name matching nothing creates a fresh location/sublocation),
			    and Time (plain free text). All four write straight back into
			    the script heading — this field group IS the heading. */}
			{record.type === 'scene' ? (
				<div className="loom-field">
					<span className="loom-field-label">Scene heading</span>
					<div className="loom-scene-heading-fields">
						<SuggestInput
							className="loom-scene-heading-intext"
							placeholder="INT./EXT."
							value={sceneIntExt}
							options={['INT.', 'EXT.', 'INT./EXT.', 'EST.']}
							onChange={setSceneIntExt}
							onPick={(v) => {
								setSceneIntExt(v);
								commitSceneIntExt(v);
							}}
							onBlur={() => commitSceneIntExt()}
						/>
						<SuggestInput
							className="loom-scene-heading-location"
							placeholder="Location"
							value={sceneMain}
							options={plugin.indexer
								.getAll('location', record.project)
								.filter((r) => r.parentLocation === null)
								.map((r) => r.name)}
							onChange={setSceneMain}
							onPick={(v) => {
								setSceneMain(v);
								void commitSceneLocation();
							}}
							onBlur={() => void commitSceneLocation()}
						/>
						<SuggestInput
							className="loom-scene-heading-location"
							placeholder="Sublocation (optional)"
							value={sceneSub}
							options={(() => {
								const mainRecord = plugin.indexer
									.getAll('location', record.project)
									.find((r) => r.parentLocation === null && r.name.trim().toLowerCase() === sceneMain.trim().toLowerCase());
								if (!mainRecord) return [];
								return plugin.indexer
									.getAll('location', record.project)
									.filter(
										(r) =>
											r.parentLocation !== null &&
											plugin.indexer.resolve(r.parentLocation, r.path)?.path === mainRecord.path
									)
									.map((r) => r.name);
							})()}
							onChange={setSceneSub}
							onPick={(v) => {
								setSceneSub(v);
								void commitSceneLocation();
							}}
							onBlur={commitSceneSubBlur}
						/>
						<input
							type="text"
							className="loom-scene-heading-time"
							placeholder="Time"
							value={sceneTime}
							onChange={(e) => setSceneTime(e.target.value)}
							onBlur={() => commitSceneTime()}
							onKeyDown={(e) => {
								if (e.key === 'Enter') commitSceneTime();
							}}
						/>
					</div>
					<span className="loom-field-hint">
						{(sceneIntExt.trim() !== '' ? `${sceneIntExt.trim()} ` : '') +
							joinLocationSub(sceneMain || '…', sceneSub) +
							(sceneTime.trim() !== '' ? ` - ${sceneTime.trim()}` : '')}
					</span>
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

			{/* Part of region — a grouping layer above locations (every location,
			    sublocations included; shown right after "Sublocation of"). */}
			{isLocation ? (
				<div className="loom-field">
					<span className="loom-field-label">Part of region</span>
					{!record.region || editingRegion ? (
						<div className="loom-region-pick">
							<SearchableSelect
								key={`${record.region ?? ''}:${editingRegion}`}
								placeholder="Not specified"
								options={regions
									.map((r) => ({ value: linkTargetOf(r), label: r.name }))
									.sort((a, b) => a.label.localeCompare(b.label))}
								initialQuery={editingRegion ? currentRegion?.name ?? '' : ''}
								action={
									project
										? {
												label: '+ Create region…',
												onPick: () =>
													new CreateEntityModal(plugin, 'region', project, {
														onCreated: (created) => {
															setLocationRegion(created.basename);
															setEditingRegion(false);
														},
													}).open(),
											}
										: undefined
								}
								onPick={(target) => {
									setLocationRegion(target);
									setEditingRegion(false);
								}}
							/>
							{editingRegion ? (
								<button
									className="loom-rel-filter"
									aria-label="Clear region"
									onClick={() => {
										clearLocationRegion();
										setEditingRegion(false);
									}}
								>
									<Icon name="eraser" />
								</button>
							) : null}
						</div>
					) : (
						<div className="loom-region-pick">
							<EntityChip
								plugin={plugin}
								record={currentRegion}
								label={currentRegion?.name ?? record.region}
								onOpen={() => currentRegion && view.openEntity(currentRegion.path)}
							/>
							<button
								className="loom-rel-filter"
								aria-label="Change region"
								onClick={() => setEditingRegion(true)}
							>
								<Icon name="square-pen" fallback="pencil" />
							</button>
						</div>
					)}
				</div>
			) : null}

			{record.type === 'session' ? (
				<label className="loom-field">
					<span className="loom-field-label loom-field-label-row">
						Date
						{sessionNumber > 0 ? (
							<span className="loom-session-number">Session {sessionNumber}</span>
						) : null}
					</span>
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

			{isBeat ? (
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

			{record.type === 'chapter' ? (
				<label className="loom-field">
					<span className="loom-field-label loom-field-label-row">
						Title
						{sessionNumber > 0 ? (
							<span className="loom-session-number">Chapter {sessionNumber}</span>
						) : null}
					</span>
					{/* The script's `# section` line — editing it writes straight into
					    the script (`renameSectionTitle`); the note's own name/file are
					    then reflected back by the sync that follows. Chapters don't
					    render the generic Name field above (they take the `isSession`
					    branch of the page shell), so this is the ONLY place the title
					    is exposed and edited. */}
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onBlur={() => void commitChapterTitle()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void commitChapterTitle();
						}}
					/>
				</label>
			) : null}

			{record.type === 'chapter' ? (
				<label className="loom-field">
					<span className="loom-field-label">Display title</span>
					<input
						type="text"
						placeholder={record.name}
						value={displayTitle}
						onChange={(e) => setDisplayTitle(e.target.value)}
						onBlur={() => void commitDisplayTitle()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void commitDisplayTitle();
						}}
					/>
				</label>
			) : null}

			{isSession && kindFeatures.attendance ? (
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


			{showsQuestSection ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Quests</span>
					{(['active', 'resolvedThis', 'resolvedPrev'] as const).map((state) => {
						const outcomeKey = (q: EntityRecord) => {
							const out = q.questOutcomeSession ? plugin.indexer.resolve(q.questOutcomeSession, q.path) : null;
							return (out ? anchorPositionKey(out) : null) ?? 0;
						};
						// Active: manual loomSeq order (from sessionQuests). Resolved
						// groups: most recently finished on top (by outcome position),
						// no reorder — and "Resolved previously" is capped by the setting.
						const limit = plugin.settings.sessionResolvedQuests;
						const list =
							state === 'active'
								? sessionQuests.filter((q) => q.state === state)
								: (() => {
										const sorted = sessionQuests
											.filter((q) => q.state === state)
											.slice()
											.sort((a, b) => outcomeKey(b.quest) - outcomeKey(a.quest));
										return state === 'resolvedPrev' && limit > 0 ? sorted.slice(0, limit) : sorted;
									})();
						const total = sessionQuests.filter((q) => q.state === state).length;
						const open = questsOpen[state];
						const gkey = 'quest-' + state;
						const reorderable = state === 'active';
						const questRecords = list.map((x) => x.quest);
						const pageLabel = record.type === 'scene' ? beatLabel : anchorLabel;
						const heading =
							state === 'active'
								? 'Active'
								: state === 'resolvedThis'
									? `Resolved this ${pageLabel}`
									: 'Resolved previously';
						return (
							<div key={state} className="loom-section">
								<button
									className="loom-section-header"
									onClick={() => setQuestsOpen({ ...questsOpen, [state]: !open })}
								>
									<span className={open ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
									{heading}
									<span className="loom-section-count">
										{state === 'resolvedPrev' && limit > 0 && total > list.length
											? `${list.length} of ${total}`
											: list.length}
									</span>
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
<span className="loom-quest-card-value">														{received && roleOf(received.type) === questAnchorRole ? (
															received.path === record.path ? (
																<span>This {pageLabel}</span>
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
																{quest.loomTags.map((t) => (
																	<QuestTagChip key={t} plugin={plugin} tag={t} />
																))}
															</span>
														</div>
													) : null}

													{state !== 'active' ? (
														<>
															<div className="loom-quest-card-row">
															<span className="loom-quest-card-label">Completed on:</span>
<span className="loom-quest-card-value">																{outcomeSes && roleOf(outcomeSes.type) === questAnchorRole ? (
																	outcomeSes.path === record.path ? (
																		<span>This {pageLabel}</span>
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
								<span className="loom-field-label">Received in {questAnchorRole === 'beat' ? beatLabel : anchorLabel}</span>
								{questReceived && roleOf(questReceived.type) === questAnchorRole ? (
									sessionChip(questReceived, () => setQuestSession('questReceived', null))
								) : (
									<SearchableSelect
										placeholder={`Pick the ${questAnchorRole === 'beat' ? beatLabel : anchorLabel}…`}
										options={questAnchorsSorted.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
										onPick={(name) => setQuestSession('questReceived', name)}
									/>
								)}
							</div>
							{record.questOutcome !== '' ? (
								<div className="loom-field">
									<span className="loom-field-label">
										{record.questOutcome[0].toUpperCase() + record.questOutcome.slice(1)} in{' '}
										{questAnchorRole === 'beat' ? beatLabel : anchorLabel}
									</span>
									{questOutcomeSession && roleOf(questOutcomeSession.type) === questAnchorRole ? (
										sessionChip(questOutcomeSession, () => setQuestSession('questOutcomeSession', null))
									) : (
										<SearchableSelect
											placeholder={`Pick the ${questAnchorRole === 'beat' ? beatLabel : anchorLabel}…`}
											options={questAnchorsSorted.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
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
						<div className="loom-field">
							<span className="loom-field-label">Reward</span>
							<MarkdownField
								app={plugin.app}
								value={reward}
								names={linkNames}
								placeholder="Not specified"
								onOpenLink={openLinkTarget}
								onCreateEntity={createLinkEntity}
								onChange={(v) => {
									setReward(v);
									saveReward(v);
								}}
							/>
						</div>
					</div>
				</div>
			) : null}

		{isItemCopy ? (
				<div className="loom-field">
					<span className="loom-field-label">
						{description === '' ? 'Description' : 'Alternative description'}
					</span>
					<MarkdownField
						app={plugin.app}
						value={description === '' ? copyOriginal?.description ?? '' : description}
						names={linkNames}
						onOpenLink={openLinkTarget}
						onCreateEntity={createLinkEntity}
						onChange={(v) => {
							setDescription(v);
							saveDescription(v);
						}}
					/>
					{description !== '' ? (
						<details className="loom-orig-desc">
							<summary>Original description</summary>
							<MarkdownField
								app={plugin.app}
								value={copyOriginal?.description ?? ''}
								names={linkNames}
								onOpenLink={openLinkTarget}
								onChange={() => undefined}
								readOnly
							/>
						</details>
					) : null}
				</div>
			) : (
		<div className={isSession ? 'loom-field loom-field-sep' : 'loom-field'}>
				<span className="loom-field-label">Description</span>
				{isPc ? (
					<label className="loom-check">
						<input type="checkbox" checked={record.alive} onChange={(e) => setAlive(e.target.checked)} />
						Alive
					</label>
				) : null}
				{isPc ? (
					<label
						className="loom-check"
						title="Inactive characters are not included when the Group is added (e.g. while away from the party)"
					>
						<input
							type="checkbox"
							checked={record.active}
							onChange={(e) => setActive(e.target.checked)}
						/>
						Active
					</label>
				) : null}
				{isPc && !record.alive ? (
					<div className="loom-death-row">
						<span className="loom-field-label">Death session</span>
						{deathSession && roleOf(deathSession.type) === 'anchor' ? (
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
			)}

		{isSession && project ? (
				<div className="loom-field loom-graph-under">
					<button className="loom-section-header" onClick={() => setGraphOpen(!graphOpen)}>
						<span className={graphOpen ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
						{ENTITY_META[anchorType].label} graph
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

			{/* A writer project's chapter owns its scenes through their own
			    `loomSceneChapter` link — parsed straight out of the script's `#`
			    sections — rather than through the note hub the session page uses.
			    Without this a chapter imported from a script looked empty even
			    though every scene under it pointed at it. */}
			{isSession && scriptMode && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">{ENTITY_META[beatType].plural}</span>
					<div className="loom-hub-add-row">
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, beatType, project, {
									noteSession: record,
									onCreated: () => {},
								}).open()
							}
						>
							+ Add {/^[aeiou]/.test(beatLabel) ? 'an' : 'a'} {beatLabel}
						</button>
					</div>
					{chapterScenes.length === 0 ? (
						<div className="loom-attendance-empty">
							No {ENTITY_META[beatType].plural.toLowerCase()} yet — a heading under this{' '}
							<code># {record.name}</code> section in the script creates them.
						</div>
					) : (
						<div
							className={
								seqDrag?.group === 'chapter-scenes'
									? 'loom-subloc-list loom-subloc-dragging'
									: 'loom-subloc-list'
							}
						>
							{chapterScenes.map((sc, i) => {
								const grabbed = seqDrag?.group === 'chapter-scenes' && seqDrag.from === i;
								return (
									<div
										key={sc.path}
										className={
											grabbed
												? 'loom-script-scene-row loom-subloc-row-slide loom-subloc-row-dragging'
												: 'loom-script-scene-row loom-subloc-row-slide'
										}
										style={seqRowStyle('chapter-scenes', i)}
										data-seq-row=""
									>
										{seqGrip('chapter-scenes', i, chapterScenes, (reordered) => {
											if (!project) return;
											// One atomic rewrite of the whole section's scene order,
											// rather than reasoning about a single "insert before its
											// new neighbor" move — robust to any jump distance.
											void editScriptAndSync(plugin, project, (raw) =>
												reorderScenesInSection(
													raw,
													record.chapterId,
													reordered.map((r) => r.sceneId)
												)
											);
										})}
										<span className="loom-scene-row-num">{i + 1}</span>
										<span className="loom-scene-row-intext">{sc.sceneIntExt}</span>
										<button className="loom-subloc-link" onClick={() => view.openEntity(sc.path)}>
											{sc.name}
										</button>
										{sc.sceneTime !== '' ? <span className="loom-row-desc">{sc.sceneTime}</span> : null}
									</div>
								);
							})}
						</div>
					)}
				</div>
			) : null}

			{record.type === 'chapter' && scriptMode && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Script</span>
					{chapterExcerpt !== null
						? (() => {
								// Same box-local placement as the Scene page's own panel —
								// lives inside the editor box's left margin via a sticky
								// wrapper scoped to the box's own scroll, not the page's.
								const chapterNavPanel =
									chapterNavTree && chapterNavTree.items.length > 0 ? (
										<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
											<button
												className="loom-script-nav-toggle"
												aria-label={chapterNavOpen ? 'Hide navigation' : 'Show navigation'}
												onClick={() => setChapterNavOpen(!chapterNavOpen)}
											>
												<Icon name={chapterNavOpen ? 'panel-left-close' : 'panel-left-open'} fallback="list" />
											</button>
											{chapterNavOpen ? (
												<aside className="loom-script-nav">
													<div className="loom-script-nav-head">
														Navigate
														<button
															className="loom-rel-filter"
															aria-label="Hide navigation"
															onClick={() => setChapterNavOpen(false)}
														>
															<Icon name="chevron-left" />
														</button>
													</div>
													{chapterNavTree.items.map((item) =>
														renderNavTreeItem(item, 1, (line) => {
															// `line` is an ABSOLUTE line in the whole script (from
															// `buildNavTree`) — first back out to a line relative to
															// this chapter's own excerpt (which starts at the
															// chapter's own `#` line), then to one relative to
															// `chapterDraft` (the heading-stripped body). Missing the
															// first subtraction was why every click landed at the
															// very end of the chapter (`bodyLine` came out far past
															// the excerpt's real length, and both branches below just
															// clamp to their last position when that happens).
															const bodyLine =
																line - (chapterNavSection?.line ?? 0) - chapterBodyLineOffset;
															if (chapterScriptMode === 'pages') {
																// Jumping to the PAGE's own top isn't precise enough —
																// a page can run much taller than the visible box, so
																// the target line could still sit far below the fold
																// after landing on the right page. Every rendered `<p>`
																// carries its own `data-line`, so find the specific
																// element at (or just after — sections/branches don't
																// render their own paragraph, only the printed marker
																// that follows them) this line and scroll straight to
																// IT. Not `scrollIntoView` — see the search-match jump
																// above for why (cascades through every scrollable
																// ancestor, including the whole entity page).
																const excerptLine = bodyLine + chapterBodyLineOffset;
																const flatEls = chapterBodyPages.flat();
																const target = flatEls.find((e) => e.line >= excerptLine) ?? flatEls[flatEls.length - 1];
																const container = chapterScriptPagesRef.current;
																const targetEl = target
																	? container?.querySelector(`[data-line="${target.line}"]`)
																	: null;
																if (container && targetEl) {
																	const containerRect = container.getBoundingClientRect();
																	const targetRect = targetEl.getBoundingClientRect();
																	const top = container.scrollTop + (targetRect.top - containerRect.top);
																	container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
																}
																return;
															}
															const offset =
																chapterDraft.split('\n').slice(0, bodyLine).join('\n').length +
																(bodyLine > 0 ? 1 : 0);
															chapterScriptEditorRef.current?.selectRange(offset, offset);
														})
													)}
												</aside>
											) : null}
										</div>
									) : null;
								const chapterMatches: number[] = [];
								if (chapterScriptQuery.trim() !== '') {
									const needle = chapterScriptQuery.toLowerCase();
									const hay = chapterDraft.toLowerCase();
									for (
										let at = hay.indexOf(needle);
										at !== -1;
										at = hay.indexOf(needle, at + needle.length)
									) {
										chapterMatches.push(at);
									}
								}
								const gotoChapterMatch = (index: number) => {
									if (chapterMatches.length === 0) return;
									const next =
										((index % chapterMatches.length) + chapterMatches.length) % chapterMatches.length;
									setChapterScriptMatchIndex(next);
									if (chapterScriptMode === 'script') {
										const offset = chapterMatches[next];
										chapterScriptEditorRef.current?.selectRange(offset, offset + chapterScriptQuery.length);
									} else {
										window.requestAnimationFrame(() => {
											const container = chapterScriptPagesRef.current;
											const mark = container?.querySelectorAll('mark')[next];
											if (!container || !mark) return;
											const containerRect = container.getBoundingClientRect();
											const markRect = mark.getBoundingClientRect();
											const target =
												container.scrollTop +
												(markRect.top - containerRect.top) -
												container.clientHeight / 2 +
												markRect.height / 2;
											container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
										});
									}
								};
								const currentChapterPage = (): number => {
									const container = chapterScriptPagesRef.current;
									if (!container) return 1;
									const top = container.getBoundingClientRect().top;
									const threshold = top + container.clientHeight / 3;
									let current = 1;
									for (const node of container.querySelectorAll<HTMLElement>('[data-page]')) {
										if (node.getBoundingClientRect().top <= threshold) current = Number(node.dataset.page);
									}
									return current;
								};
								const switchChapterMode = (next: 'script' | 'pages') => {
									if (next === chapterScriptMode) return;
									if (next === 'pages') {
										const topLine = chapterScriptEditorRef.current?.getTopLine();
										setChapterScriptMode('pages');
										if (topLine !== undefined) {
											const target = chapterPageOfLine(topLine);
											window.requestAnimationFrame(() => {
												chapterScriptPagesRef.current
													?.querySelector(`[data-page="${target}"]`)
													?.scrollIntoView({ block: 'start', behavior: 'instant' });
											});
										}
									} else {
										pendingChapterScrollLineRef.current = chapterLineOfPage(currentChapterPage());
										setChapterScriptMode('script');
									}
								};
								return (
									<>
										<div className="loom-script-tabs loom-seg">
											<button
												className={
													chapterScriptMode === 'script' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'
												}
												onClick={() => switchChapterMode('script')}
											>
												Script
											</button>
											<button
												className={
													chapterScriptMode === 'pages' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'
												}
												onClick={() => switchChapterMode('pages')}
											>
												Pages preview
											</button>
										</div>
										<div className="loom-script-toolbar">
											<div className="loom-search-wrap">
												<input
													className="loom-script-search"
													type="search"
													placeholder="Search this chapter…"
													value={chapterScriptQuery}
													onChange={(e) => {
														setChapterScriptQuery(e.target.value);
														setChapterScriptMatchIndex(0);
													}}
													onKeyDown={(e) => {
														if (e.key !== 'Enter') return;
														e.preventDefault();
														gotoChapterMatch(
															e.shiftKey ? chapterScriptMatchIndex - 1 : chapterScriptMatchIndex + 1
														);
													}}
												/>
												{chapterScriptQuery !== '' ? (
													<button
														className="loom-chip-remove loom-search-clear"
														aria-label="Clear search"
														onClick={() => {
															setChapterScriptQuery('');
															setChapterScriptMatchIndex(0);
														}}
													>
														✕
													</button>
												) : null}
											</div>
											<button
												className="loom-rel-filter"
												aria-label="Previous match"
												disabled={chapterMatches.length === 0}
												onClick={() => gotoChapterMatch(chapterScriptMatchIndex - 1)}
											>
												<Icon name="chevron-up" />
											</button>
											<button
												className="loom-rel-filter"
												aria-label="Next match"
												disabled={chapterMatches.length === 0}
												onClick={() => gotoChapterMatch(chapterScriptMatchIndex + 1)}
											>
												<Icon name="chevron-down" />
											</button>
											<span className="loom-script-stat">
												{chapterScriptQuery.trim() === ''
													? ''
													: chapterMatches.length === 0
														? 'No matches'
														: `${(chapterScriptMatchIndex % chapterMatches.length) + 1} of ${chapterMatches.length}`}
											</span>
										</div>
										{chapterScriptMode === 'script' ? (
											<div className="loom-scene-script">
												{chapterNavPanel}
												<FountainField
													ref={chapterScriptEditorRef}
													value={chapterDraft}
													onChange={setChapterBody}
													onBlur={() => {
														if (!project || chapterDraft === chapterBodyOf(chapterExcerpt)) return;
														void editScriptAndSync(plugin, project, (raw) =>
															replaceChapterBody(raw, record.chapterId, chapterDraft)
														).then(() => setChapterBody(null));
													}}
													characters={scriptParsed?.characters ?? []}
													locations={scriptParsed?.locations ?? []}
													entityOptions={entityOptions}
													onOpenCharacter={(name) => {
														if (!project) return;
														const match = plugin.indexer
															.getAll('character', project.root)
															.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
														if (match) view.openEntity(match.path);
													}}
													onOpenLocation={(sceneLoomId) => {
														const sc = plugin.indexer
															.getAll('scene', record.project)
															.find((s) => s.sceneId === sceneLoomId);
														if (!sc || sc.sceneLocation === '') return;
														const loc = plugin.indexer.resolve(sc.sceneLocation, sc.path);
														if (loc) view.openEntity(loc.path);
													}}
													onOpenChapter={() => view.openEntity(record.path)}
													onOpenEntity={(path) => view.openEntity(path)}
												/>
											</div>
										) : (
											<div className="loom-screenplay loom-scene-pages" ref={chapterScriptPagesRef}>
												{chapterNavPanel}
												{chapterBodyPages.map((elements, i) => (
													<div key={i} className="loom-screenplay-page" data-page={i + 1}>
														{elements.map((el, j) =>
															el.type === 'scene-heading' ? (
																<p key={j} className="loom-sp-scene-heading" data-line={el.line}>
																	<span
																		dangerouslySetInnerHTML={{
																			__html: highlight(
																				renderInline(preventOrphans(stripEntityLinksForDisplay(elementText(el)))),
																				chapterScriptQuery
																			),
																		}}
																	/>
																	{el.sceneNumber ? (
																		<span className="loom-sp-scene-num">{el.sceneNumber}</span>
																	) : null}
																</p>
															) : (
																<p
																	key={j}
																	className={`loom-sp-${el.type}`}
																	data-line={el.line}
																	dangerouslySetInnerHTML={{
																		__html: highlight(
																			renderInline(preventOrphans(stripEntityLinksForDisplay(elementText(el)))),
																			chapterScriptQuery
																		),
																	}}
																/>
															)
														)}
													</div>
												))}
											</div>
										)}
									</>
								);
							})()
						: (
							<div className="loom-attendance-empty">This chapter isn't in the script yet.</div>
						)}
				</div>
			) : null}

			{isSession && !scriptMode && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">{ENTITY_META[beatType].plural}</span>
					{/* Creation first, as always. The modal's Name field searches
					    existing beats — picking one pins it here instead of
					    creating a duplicate. */}
					<div className="loom-hub-add-row">
						<button
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, beatType, project, {
									noteSession: record,
									onCreated: () => {},
								}).open()
							}
						>
							+ Add {/^[aeiou]/.test(beatLabel) ? 'an' : 'a'} {beatLabel}
						</button>
					</div>
					{ENTITY_TYPES.filter((t) => hubEntries.some((e) => e.owner.type === t)).map((t) => {
						const entries = hubEntries.filter((e) => e.owner.type === t);
						// Event and quest notes are drag-reorderable by loomSeq (events
						// share it with the timeline); other hub groups keep note order.
						if (roleOf(t) !== 'beat' && t !== 'quest') {
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

			{isQuest ? (
				(() => {
					const rows = objectives.map((o, idx) => ({ o, idx }));
					const active = rows.filter((r) => r.o.finishedOn === '');
					const resolved = rows.filter((r) => r.o.finishedOn !== '');
					const activeDrafts = active.map((r) => r.o);
					const resolvedDrafts = resolved.map((r) => r.o);
					const commitSet = (idx: number, patch: Partial<ObjectiveDraft>) =>
						commitObjectives(objectives.map((o, j) => (j === idx ? { ...o, ...patch } : o)));
					const del = (idx: number) => commitObjectives(objectives.filter((_, j) => j !== idx));
					const objectiveRow = (
						idx: number,
						grip: ReactNode,
						style: CSSProperties | undefined,
						dragging: boolean
					) => {
						const o = objectives[idx];
						const finished =
							o.finishedOn !== '' ? plugin.indexer.resolve(o.finishedOn, record.path) : null;
						return (
							<div
								key={idx}
								data-obj-row=""
								className={dragging ? 'loom-obj-row loom-obj-row-dragging' : 'loom-obj-row'}
								style={style}
							>
								{grip}
								<div className="loom-obj-name">
									<HubNoteText
										app={plugin.app}
										initial={o.name}
										names={linkNames}
										onOpenLink={openLinkTarget}
										onCreateEntity={createLinkEntity}
										onCommit={(v) => commitSet(idx, { name: v })}
									/>
								</div>
								<div className="loom-obj-finished">
									{finished && roleOf(finished.type) === questAnchorRole ? (
										sessionChip(finished, () => commitSet(idx, { finishedOn: '' }))
									) : (
										<SearchableSelect
											placeholder="Finished on…"
											options={questAnchorsSorted.map((s) => ({
												value: linkTargetOf(s),
												label: recordLabel(s, project),
											}))}
											onPick={(name) => commitSet(idx, { finishedOn: name })}
										/>
									)}
								</div>
								<button
									className="loom-nav-btn loom-obj-remove"
									aria-label="Remove objective"
									onClick={() => del(idx)}
								>
									✕
								</button>
							</div>
						);
					};
					return (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">Objectives</span>
							<div className="loom-hub-add-row">
								<button
									className="loom-rel-add"
									onClick={() => setObjectives([...objectives, { name: '', finishedOn: '' }])}
								>
									+ Add objective
								</button>
							</div>
							<div className="loom-obj-section">
								<span className="loom-rel-group-label">
									Active<span className="loom-section-count">{active.length}</span>
								</span>
								<div className={objDrag ? 'loom-obj-list loom-subloc-dragging' : 'loom-obj-list'}>
									{active.map((r, i) =>
										objectiveRow(
											r.idx,
											objGrip(i, activeDrafts, resolvedDrafts),
											objRowStyle(i, active.length),
											objDrag?.from === i
										)
									)}
								</div>
							</div>
							{resolved.length > 0 ? (
								<div className="loom-obj-section">
									<span className="loom-rel-group-label">
										Resolved<span className="loom-section-count">{resolved.length}</span>
									</span>
									<div className="loom-obj-list">
										{resolved.map((r) => objectiveRow(r.idx, null, undefined, false))}
									</div>
								</div>
							) : null}
						</div>
					);
				})()
			) : null}

			{record.type === 'faction' ? (
				<div className="loom-field">
					<span className="loom-field-label">Members</span>
					<SearchableSelect
						placeholder="Add a member…"
						options={[
							...groupOption(
								groupPcs.filter((c) => !memberRecords.some((m) => m.path === c.path)).length,
								null
							),
							...projectCharacters
								.filter((c) => !memberRecords.some((m) => m.path === c.path))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((c) => ({ value: linkTargetOf(c), label: c.name })),
						]}
						onPick={(name) => {
							const adds =
								name === PC_GROUP_VALUE
									? groupPcs
											.filter((c) => !memberRecords.some((m) => m.path === c.path))
											.map(linkTargetOf)
									: [name];
							editMembersOf(record, (arr) => [...arr, ...adds.map((n) => `[[${n}]]`)]);
						}}
						action={
							project
								? {
										label: '+ Create new character',
										onPick: () =>
											new CreateEntityModal(plugin, 'character', project, {
												onCreated: (created) =>
													editMembersOf(record, (arr) => [...arr, `[[${created.basename}]]`]),
											}).open(),
									}
								: undefined
						}
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
									// Option values are link targets (file basenames), not names.
									const faction = projectFactions.find((f) => linkTargetOf(f) === name);
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
							+ Add a faction
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

			{/* Character: Items sit directly under the Faction(s) section. */}
			{record.type === 'character' ? itemsSection : null}

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


			{isBeat && scriptMode ? (
				<>
					{/* Mandatory, and re-assignable. Moving is two steps, since a
					    single dropdown pick can't say WHERE in the target chapter
					    the scene should land: (1) pick the chapter, (2) drag the
					    scene into position among that chapter's existing scenes.
					    Either step physically moves the writing in the script, so
					    the note's chapter link and the script can never drift
					    apart — a chapter link edited any other way would just be
					    undone by the next sync. Cast sits alongside it as a
					    read-only side column — it's `loomSceneCast`, derived from
					    the script's own character cues, never edited here. */}
					<div className="loom-field loom-field-sep">
					<div
						className={
							sceneCastRecords.length +
								sceneFactionRecords.length +
								sceneMentionedLocationRecords.length +
								sceneItemRecords.length ===
							0
								? 'loom-scene-chapter-grid loom-scene-chapter-grid-solo'
								: 'loom-scene-chapter-grid'
						}
					>
					<div className="loom-scene-chapter-left">
						<span className="loom-field-label">{ENTITY_META[anchorType].label}</span>
						<div className="loom-tag-row">
							{sceneChapterRecord ? (
								<EntityChip
									plugin={plugin}
									record={sceneChapterRecord}
									onOpen={() => view.openEntity(sceneChapterRecord.path)}
								/>
							) : null}
							{moveTargetChapter ? null : (
								<SearchableSelect
									placeholder={
										sceneChapterRecord ? `Move to another ${anchorLabel}…` : `Pick the ${anchorLabel}…`
									}
									options={plugin.indexer
										.getAll(anchorType, record.project)
										.filter((c) => c.path !== sceneChapterRecord?.path)
										.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created))
										.map((c) => ({ value: c.path, label: c.name }))}
									onPick={(path) => {
										const target = plugin.indexer.get(path);
										if (!target) return;
										setMoveTargetChapter(target);
										setMovePlaceAt(0);
									}}
								/>
							)}
						</div>
						{sceneChapterRecord || moveTargetChapter ? null : (
							<span className="loom-field-hint">
								Every scene belongs to a chapter — that's where its writing lives in the script.
							</span>
						)}
						{moveTargetChapter && project
							? (() => {
									const siblings = plugin.indexer
										.getAll('scene', record.project)
										.filter(
											(sc) =>
												sc.path !== record.path &&
												sc.sceneChapter !== '' &&
												plugin.indexer.resolve(sc.sceneChapter, sc.path)?.path === moveTargetChapter.path
										)
										.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));
									const placeAt = Math.max(0, Math.min(siblings.length, movePlaceAt));
									// Dragging only updates `movePlaceAt` (a pending placement);
									// nothing moves in the script until this commits it — a drop
									// that fired instantly gave no chance to readjust.
									const finishMove = () => {
										const nextSibling = siblings[placeAt];
										void editScriptAndSync(plugin, project, (raw) =>
											nextSibling
												? moveSceneBefore(raw, record.sceneId, nextSibling.sceneId)
												: moveSceneToSection(raw, record.sceneId, moveTargetChapter.chapterId)
										).then(() => {
											setMoveTargetChapter(null);
											setMovePlaceAt(0);
										});
									};
									return (
										<>
											<div className="loom-field-hint">
												{siblings.length === 0
													? `"${moveTargetChapter.name}" has no scenes yet — this will be its first.`
													: `Drag this scene into position among "${moveTargetChapter.name}"'s scenes, then confirm.`}
											</div>
											{siblings.length > 0 ? (
												<div
													className={
														seqDrag?.group === 'scene-move'
															? 'loom-subloc-list loom-subloc-dragging'
															: 'loom-subloc-list'
													}
												>
													{(() => {
														const display = [
															...siblings.slice(0, placeAt),
															record,
															...siblings.slice(placeAt),
														];
														return display.map((sc, i) => {
															const grabbed = seqDrag?.group === 'scene-move' && seqDrag.from === i;
															const isSelf = sc.path === record.path;
															return (
																<div
																	key={sc.path}
																	className={
																		grabbed
																			? 'loom-script-scene-row loom-subloc-row-slide loom-subloc-row-dragging'
																			: 'loom-script-scene-row loom-subloc-row-slide'
																	}
																	style={seqRowStyle('scene-move', i)}
																	data-seq-row=""
																>
																	{isSelf
																		? seqGrip('scene-move', i, display, (reordered, moved) => {
																				const idx = reordered.findIndex(
																					(r) => r.path === moved.path
																				);
																				setMovePlaceAt(idx);
																			})
																		: <span className="loom-subloc-grip loom-subloc-grip-static" />}
																	<span className="loom-scene-row-num">{i + 1}</span>
																	<span className={isSelf ? 'loom-subloc-link loom-hub-name-static' : ''}>
																		{sc.name}
																	</span>
																</div>
															);
														});
													})()}
												</div>
											) : null}
											<div className="loom-hub-add-row">
												<button className="loom-rel-add" onClick={finishMove}>
													Move the scene
												</button>
												<button
													className="loom-rel-filter"
													onClick={() => {
														setMoveTargetChapter(null);
														setMovePlaceAt(0);
													}}
												>
													Cancel
												</button>
											</div>
										</>
									);
								})()
							: null}
					</div>
					{sceneCastRecords.length +
						sceneFactionRecords.length +
						sceneMentionedLocationRecords.length +
						sceneItemRecords.length ===
					0 ? null : (
						<div className="loom-scene-chapter-right">
							<span className="loom-field-label">Entities in the scene</span>
							{(
								[
									['Characters', sceneCastRecords],
									['Factions', sceneFactionRecords],
									['Locations', sceneMentionedLocationRecords],
									['Items', sceneItemRecords],
								] as const
							).map(([label, records]) =>
								records.length === 0 ? null : (
									<div key={label} className="loom-scene-entity-group">
										<span className="loom-field-sublabel">{label}</span>
										<div className="loom-tag-row">
											{records.map((r) => (
												<EntityChip
													key={r.path}
													plugin={plugin}
													record={r}
													onOpen={() => view.openEntity(r.path)}
												/>
											))}
										</div>
									</div>
								)
							)}
						</div>
					)}
					</div>
					</div>
					{/* A focused window onto this scene's stretch of the script. The
					    heading (and the hidden id on it) stays owned by the script,
					    so only the writing beneath it is editable here. Script/Pages
					    preview + search mirror the main Script view exactly, scoped
					    to just this scene's own excerpt. */}
					<div className="loom-field loom-field-sep">
						<span className="loom-field-label">Script</span>
						{sceneExcerpt !== null
							? (() => {
									const sceneMatches: number[] = [];
									if (sceneScriptQuery.trim() !== '') {
										const needle = sceneScriptQuery.toLowerCase();
										const hay = sceneDraft.toLowerCase();
										for (
											let at = hay.indexOf(needle);
											at !== -1;
											at = hay.indexOf(needle, at + needle.length)
										) {
											sceneMatches.push(at);
										}
									}
									const gotoSceneMatch = (index: number) => {
										if (sceneMatches.length === 0) return;
										const next = ((index % sceneMatches.length) + sceneMatches.length) % sceneMatches.length;
										setSceneScriptMatchIndex(next);
										if (sceneScriptMode === 'script') {
											const offset = sceneMatches[next];
											sceneScriptEditorRef.current?.selectRange(offset, offset + sceneScriptQuery.length);
										} else {
											// Pages mode has no offset-to-page mapping to scroll by (this
											// excerpt isn't laid out against the whole document) — the
											// `<mark>`s render in the same reading order as `sceneMatches`,
											// so the Nth one in the DOM is the Nth match; wait a frame for
											// the highlight to actually be in the DOM before finding it.
											// Scrolled manually via scrollTop rather than the mark's own
											// `scrollIntoView`, which scrolls EVERY scrollable ancestor
											// needed to bring it into view — including the whole entity
											// page behind this one small preview box, not just the box.
											window.requestAnimationFrame(() => {
												const container = sceneScriptPagesRef.current;
												const mark = container?.querySelectorAll('mark')[next];
												if (!container || !mark) return;
												const containerRect = container.getBoundingClientRect();
												const markRect = mark.getBoundingClientRect();
												const target =
													container.scrollTop +
													(markRect.top - containerRect.top) -
													container.clientHeight / 2 +
													markRect.height / 2;
												container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
											});
										}
									};
									/** The page currently at the top of the Pages preview's
									 *  viewport — read on demand from the DOM rather than kept
									 *  as tracked state, since this scene preview (unlike the
									 *  main Script view) has no page-number readout that would
									 *  otherwise need that state anyway. Mirrors the main view's
									 *  scroll-tracking logic exactly (top third of the container
									 *  counts as "current"). */
									const currentScenePage = (): number => {
										const container = sceneScriptPagesRef.current;
										if (!container) return 1;
										const top = container.getBoundingClientRect().top;
										const threshold = top + container.clientHeight / 3;
										let current = 1;
										for (const node of container.querySelectorAll<HTMLElement>('[data-page]')) {
											if (node.getBoundingClientRect().top <= threshold) current = Number(node.dataset.page);
										}
										return current;
									};
									/** Same restore-your-place logic as the main Script view's
									 *  `switchMode`, against this scene's own `sceneBodyPages`
									 *  instead of the whole document's. Leaving Pages scrolls
									 *  immediately ('instant' — no animated jump across the whole
									 *  preview on every toggle, matching the main view's fix for
									 *  the same issue); leaving Script stashes a line for the
									 *  effect above to apply once `FountainField` remounts. */
									const switchSceneMode = (next: 'script' | 'pages') => {
										if (next === sceneScriptMode) return;
										if (next === 'pages') {
											const topLine = sceneScriptEditorRef.current?.getTopLine();
											setSceneScriptMode('pages');
											if (topLine !== undefined) {
												const target = scenePageOfLine(topLine);
												window.requestAnimationFrame(() => {
													sceneScriptPagesRef.current
														?.querySelector(`[data-page="${target}"]`)
														?.scrollIntoView({ block: 'start', behavior: 'instant' });
												});
											}
										} else {
											pendingSceneScrollLineRef.current = sceneLineOfPage(currentScenePage());
											setSceneScriptMode('script');
										}
									};
									// The raw first line still carries the hidden `[[loom:<id>]]`
									// marker — `parseSceneHeading` strips it and splits out the
									// location so it can be a real link instead of leaking the
									// marker as visible text.
									const headingParts = parseSceneHeading(sceneExcerpt.split('\n')[0]);
									// Lives INSIDE the editor box (its own left margin), not above
									// it — the box is where the spare horizontal space actually is;
									// stacked in the Script/Pages tabs above it, the toggle collided
									// with the scene-heading caption right below. `position: sticky`
									// keeps it pinned to the box's own top-left through the box's
									// OWN internal scroll (`.loom-scene-script`'s `overflow-y: auto`),
									// independent of the page's scroll — same zero-height-wrapper
									// trick as the main Script view's panel, just scoped smaller.
									const sceneNavPanel =
										sceneNavTree && sceneNavTree.items.length > 0 ? (
											<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
												<button
													className="loom-script-nav-toggle"
													aria-label={sceneNavOpen ? 'Hide navigation' : 'Show navigation'}
													onClick={() => setSceneNavOpen(!sceneNavOpen)}
												>
													<Icon name={sceneNavOpen ? 'panel-left-close' : 'panel-left-open'} fallback="list" />
												</button>
												{sceneNavOpen ? (
													<aside className="loom-script-nav">
														<div className="loom-script-nav-head">
															Navigate
															<button
																className="loom-rel-filter"
																aria-label="Hide navigation"
																onClick={() => setSceneNavOpen(false)}
															>
																<Icon name="chevron-left" />
															</button>
														</div>
														{sceneNavTree.items.map((item) =>
															renderNavTreeItem(item, 1, (line) => {
																// Same fix as the Chapter panel's callback: back out the
																// scene's own start line before the body offset, or
																// every click lands at the end of the scene.
																const bodyLine =
																	line - (sceneNavScene?.line ?? 0) - sceneBodyLineOffset;
																if (sceneScriptMode === 'pages') {
																	// Scroll straight to the target's own rendered element
																	// (`data-line`), not just the page it's on — see the
																	// Chapter panel's identical callback for why (a page can
																	// run much taller than the box, and `scrollIntoView`
																	// cascades through every scrollable ancestor).
																	const excerptLine = bodyLine + sceneBodyLineOffset;
																	const flatEls = sceneBodyPages.flat();
																	const target = flatEls.find((e) => e.line >= excerptLine) ?? flatEls[flatEls.length - 1];
																	const container = sceneScriptPagesRef.current;
																	const targetEl = target
																		? container?.querySelector(`[data-line="${target.line}"]`)
																		: null;
																	if (container && targetEl) {
																		const containerRect = container.getBoundingClientRect();
																		const targetRect = targetEl.getBoundingClientRect();
																		const top = container.scrollTop + (targetRect.top - containerRect.top);
																		container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
																	}
																	return;
																}
																const offset =
																	sceneDraft.split('\n').slice(0, bodyLine).join('\n').length +
																	(bodyLine > 0 ? 1 : 0);
																sceneScriptEditorRef.current?.selectRange(offset, offset);
															})
														)}
													</aside>
												) : null}
											</div>
										) : null;
									return (
										<>
											<div className="loom-scene-heading">
												{headingParts.intExt ? `${headingParts.intExt} ` : ''}
												{initialSceneLocation ? (
													<button
														className="loom-subloc-link"
														onClick={() => view.openEntity(initialSceneLocation.path)}
													>
														{headingParts.location}
													</button>
												) : (
													<span>{headingParts.location}</span>
												)}
												{headingParts.timeOfDay ? ` - ${headingParts.timeOfDay}` : ''}
											</div>
											<div className="loom-script-tabs loom-seg">
												<button
													className={
														sceneScriptMode === 'script' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'
													}
													onClick={() => switchSceneMode('script')}
												>
													Script
												</button>
												<button
													className={
														sceneScriptMode === 'pages' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'
													}
													onClick={() => switchSceneMode('pages')}
												>
													Pages preview
												</button>
											</div>
											<div className="loom-script-toolbar">
												<div className="loom-search-wrap">
													<input
														className="loom-script-search"
														type="search"
														placeholder="Search this scene…"
														value={sceneScriptQuery}
														onChange={(e) => {
															setSceneScriptQuery(e.target.value);
															setSceneScriptMatchIndex(0);
														}}
														onKeyDown={(e) => {
															if (e.key !== 'Enter') return;
															e.preventDefault();
															gotoSceneMatch(e.shiftKey ? sceneScriptMatchIndex - 1 : sceneScriptMatchIndex + 1);
														}}
													/>
													{sceneScriptQuery !== '' ? (
														<button
															className="loom-chip-remove loom-search-clear"
															aria-label="Clear search"
															onClick={() => {
																setSceneScriptQuery('');
																setSceneScriptMatchIndex(0);
															}}
														>
															✕
														</button>
													) : null}
												</div>
												<button
													className="loom-rel-filter"
													aria-label="Previous match"
													disabled={sceneMatches.length === 0}
													onClick={() => gotoSceneMatch(sceneScriptMatchIndex - 1)}
												>
													<Icon name="chevron-up" />
												</button>
												<button
													className="loom-rel-filter"
													aria-label="Next match"
													disabled={sceneMatches.length === 0}
													onClick={() => gotoSceneMatch(sceneScriptMatchIndex + 1)}
												>
													<Icon name="chevron-down" />
												</button>
												<span className="loom-script-stat">
													{sceneScriptQuery.trim() === ''
														? ''
														: sceneMatches.length === 0
															? 'No matches'
															: `${(sceneScriptMatchIndex % sceneMatches.length) + 1} of ${sceneMatches.length}`}
												</span>
											</div>
											{sceneScriptMode === 'script' ? (
												<div className="loom-scene-script">
													{sceneNavPanel}
													<FountainField
														ref={sceneScriptEditorRef}
														value={sceneDraft}
														onChange={setSceneBody}
														onBlur={() => {
															if (!project || sceneDraft === sceneBodyOf(sceneExcerpt)) return;
															void editScriptAndSync(plugin, project, (raw) =>
																replaceSceneBody(raw, record.sceneId, sceneDraft)
															).then(() => setSceneBody(null));
														}}
														characters={scriptParsed?.characters ?? []}
														locations={scriptParsed?.locations ?? []}
														entityOptions={entityOptions}
														onOpenCharacter={(name) => {
															if (!project) return;
															const match = plugin.indexer
																.getAll('character', project.root)
																.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
															if (match) view.openEntity(match.path);
														}}
														onOpenLocation={() => {
															if (initialSceneLocation) view.openEntity(initialSceneLocation.path);
														}}
														onOpenChapter={() => {
															if (sceneChapterRecord) view.openEntity(sceneChapterRecord.path);
														}}
														onOpenEntity={(path) => view.openEntity(path)}
													/>
												</div>
											) : (
												<div className="loom-screenplay loom-scene-pages" ref={sceneScriptPagesRef}>
													{sceneNavPanel}
													{sceneBodyPages.map((elements, i) => (
														<div key={i} className="loom-screenplay-page" data-page={i + 1}>
															{elements.map((el, j) =>
																el.type === 'scene-heading' ? (
																	<p key={j} className="loom-sp-scene-heading" data-line={el.line}>
																		<span
																			dangerouslySetInnerHTML={{
																				__html: highlight(
																					renderInline(preventOrphans(stripEntityLinksForDisplay(elementText(el)))),
																					sceneScriptQuery
																				),
																			}}
																		/>
																		{el.sceneNumber ? (
																			<span className="loom-sp-scene-num">{el.sceneNumber}</span>
																		) : null}
																	</p>
																) : (
																	<p
																		key={j}
																		className={`loom-sp-${el.type}`}
																		data-line={el.line}
																		dangerouslySetInnerHTML={{
																			__html: highlight(renderInline(preventOrphans(stripEntityLinksForDisplay(elementText(el)))), sceneScriptQuery),
																		}}
																	/>
																)
															)}
														</div>
													))}
												</div>
											)}
										</>
									);
								})()
							: (
								<div className="loom-attendance-empty">This scene isn't in the script yet.</div>
							)}
					</div>
				</>
			) : isBeat ? (
				<div className="loom-field loom-field-sep">
					{sessionNotes.length > 0 ? (
						<span className="loom-field-label">{ENTITY_META[anchorType].label} notes</span>
					) : null}
					<div className="loom-hub-add-row">
						<button
							className="loom-rel-add"
							onClick={() => setSessionNotes([...sessionNotes, { session: '', text: '', places: [], involved: [], group: [], seq: Date.now(), idx: null }])}
						>
							+ Add a {anchorLabel} note
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

			{/* Reverse of a character/location's Items section: who carries this
			    item. Chips (persistent entities), an "Add to …" search, remove only. */}
			{showsItemHolders && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Characters</span>
					<div className="loom-hub-add-row">
						<SearchableSelect
							placeholder="Add to character…"
							options={plugin.indexer
								.getAll('character', project.root)
								.filter((c) => !holderCharacters.some((h) => h.path === c.path))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((c) => ({ value: c.path, label: c.name }))}
							onPick={(path) => {
								const c = plugin.indexer.get(path);
								if (c) addItemToHolder(c);
							}}
						/>
					</div>
					{holderCharacters.length > 0 ? (
						<div className="loom-tag-row">
							{holderCharacters.map((c) => (
								<EntityChip
									key={c.path}
									plugin={plugin}
									record={c}
									onOpen={() => view.openEntity(c.path)}
									onRemove={() => removeItemFromHolder(c)}
									removeLabel="Remove from this character"
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{showsItemHolders && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Locations</span>
					<div className="loom-hub-add-row">
						<SearchableSelect
							placeholder="Add to location…"
							options={plugin.indexer
								.getAll('location', project.root)
								.filter((l) => !holderLocations.some((h) => h.path === l.path))
								.sort((a, b) => locationLabel(a, plugin).localeCompare(locationLabel(b, plugin)))
								.map((l) => ({ value: l.path, label: locationLabel(l, plugin) }))}
							onPick={(path) => {
								const l = plugin.indexer.get(path);
								if (l) addItemToHolder(l);
							}}
						/>
					</div>
					{holderLocations.length > 0 ? (
						<div className="loom-tag-row">
							{holderLocations.map((l) => (
								<EntityChip
									key={l.path}
									plugin={plugin}
									record={l}
									label={locationLabel(l, plugin)}
									onOpen={() => view.openEntity(l.path)}
									onRemove={() => removeItemFromHolder(l)}
									removeLabel="Remove from this location"
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}


			{/* Characters serving a faction at this location (reverse of the
			    faction/character membership `location`). Read-only — edits happen
			    on the faction or character pages. Each faction's members hang off a
			    vertical nesting rail beneath the faction chip. */}
			{isLocation && locationFactionRows.length > 0 ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Factions</span>
					{[...new Map(locationFactionRows.map((r) => [r.faction.path, r.faction])).values()].map(
						(faction) => (
							<div key={faction.path} className="loom-locnote-group loom-char-event-group">
								<div className="loom-tag-row loom-event-group-session">
									<EntityChip
										plugin={plugin}
										record={faction}
										onOpen={() => view.openEntity(faction.path)}
									/>
								</div>
								<div className="loom-event-nest loom-locfac-nest">
									{locationFactionRows
										.filter((r) => r.faction.path === faction.path)
										.map((r) => (
											<span key={r.character.path} className="loom-locfac-member">
												<EntityChip
													plugin={plugin}
													record={r.character}
													onOpen={() => view.openEntity(r.character.path)}
												/>
												{r.role && r.role.toLowerCase() !== 'member' ? (
													<span className="loom-member-sep">{r.role}</span>
												) : null}
											</span>
										))}
								</div>
							</div>
						)
					)}
				</div>
			) : null}

			{/* Location keeps Items in the Factions → Items → Sublocations chain;
			    a character renders it right after its Faction(s) section instead. */}
			{isLocation ? itemsSection : null}

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

			{/* A writer project's Scenes section: this is where the location shows
			    up in the script, read-only (the scene page owns the heading that
			    puts it there) — the same "Items in sublocations" grouping the
			    Items section uses, since a sublocation may host scenes of its
			    own. Sits where Events would on any other project's location
			    page — a writer project has no Event type to show instead. */}
			{isLocation && scriptMode && (locationScenes.length > 0 || inheritedSceneGroups.length > 0) ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Scenes</span>
					{locationScenes.length > 0 ? (
						<div className="loom-subloc-list">
							{locationScenes.map((sc, i) => (
								<div key={sc.path} className="loom-script-scene-row">
									<span className="loom-scene-row-num">{i + 1}</span>
									<span className="loom-scene-row-intext">{sc.sceneIntExt}</span>
									<button className="loom-subloc-link" onClick={() => view.openEntity(sc.path)}>
										{sc.name}
									</button>
									{sc.sceneTime !== '' ? <span className="loom-row-desc">{sc.sceneTime}</span> : null}
								</div>
							))}
						</div>
					) : null}
					{inheritedSceneGroups.length > 0 ? (
						<div className="loom-inherited-items">
							<span className="loom-field-sublabel">Scenes in sublocations</span>
							{inheritedSceneGroups.map((g) => (
								<div key={g.holder.path} className="loom-locnote-group loom-char-event-group">
									<div className="loom-tag-row loom-event-group-session">
										<EntityChip
											plugin={plugin}
											record={g.holder}
											label={recordLabel(g.holder, project)}
											onOpen={() => view.openEntity(g.holder.path)}
										/>
									</div>
									<div className="loom-event-nest loom-locfac-nest loom-subloc-list">
										{g.scenes.map((sc, i) => (
											<div key={sc.path} className="loom-script-scene-row">
												<span className="loom-scene-row-num">{i + 1}</span>
												<span className="loom-scene-row-intext">{sc.sceneIntExt}</span>
												<button className="loom-subloc-link" onClick={() => view.openEntity(sc.path)}>
													{sc.name}
												</button>
												{sc.sceneTime !== '' ? (
													<span className="loom-row-desc">{sc.sceneTime}</span>
												) : null}
											</div>
										))}
									</div>
								</div>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{/* Region page: its member locations (a location's "Part of region"
			    points here). Like a location's Sublocations, but for the grouping
			    layer — add existing / create new / remove. */}
			{isRegion && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">Locations</span>
					<div className="loom-hub-add-row">
						<SearchableSelect
							placeholder="Add a location…"
							options={plugin.indexer
								.getAll('location', project.root)
								.filter((l) => !regionLocations.some((m) => m.path === l.path))
								.sort((a, b) => locationLabel(a, plugin).localeCompare(locationLabel(b, plugin)))
								.map((l) => ({ value: linkTargetOf(l), label: locationLabel(l, plugin) }))}
							action={{
								label: '+ New location',
								onPick: () =>
									new CreateEntityModal(plugin, 'location', project, {
										onCreated: (created) => addRegionLocation(created.basename),
									}).open(),
							}}
							onPick={(target) => addRegionLocation(target)}
						/>
					</div>
					{regionLocations.length > 0 ? (
						<div className="loom-tag-row">
							{regionLocations.map((l) => (
								<EntityChip
									key={l.path}
									plugin={plugin}
									record={l}
									label={locationLabel(l, plugin)}
									onOpen={() => view.openEntity(l.path)}
									onRemove={() => removeRegionLocation(l)}
									removeLabel="Remove from this region"
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{/* Events is the last content section on every page — big, so all the
			    page-specific sections above render first and only Relationships +
			    Connected entities follow it. A single placement (null when the page
			    doesn't show events, e.g. event/session pages). */}
			{eventsSection}

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
