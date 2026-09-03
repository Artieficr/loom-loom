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
	defaultMemberRole,
	ENTITY_META,
	ENTITY_TAGS,
	ENTITY_TYPES,
	EntityOrigin,
	EntityRecord,
	EntityType,
	EventKind,
	FM,
	PC_GROUP_NAME,
	PC_GROUP_VALUE,
	PC_TAG,
	QUEST_OUTCOMES,
	questOutcomeLabel,
	SPECIAL_CONDITION_TYPES,
	SpecialCondition,
	SpecialConditionGroup,
	SpecialConditionType,
	VIEW_ENTITY,
	VIEW_GROUP,
	VIEW_LIST,
	pcGroupStub,
} from '../types';
import {
	AltTextModal,
	ConfirmModal,
	CreateEntityModal,
	EntityTypeSuggestModal,
	RecordSuggestModal,
	SessionConflictModal,
	TextInputModal,
	createEntity,
	createItemCopy,
	dailyNoteLink,
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
	InfoIcon,
	NavRail,
	SearchableSelect,
	SuggestInput,
	QuestTagChip,
	Truncated,
	buildEntityLinkNames,
	buildLinkTargetLabels,
	locationLabel,
	mainLocationFirst,
	openCreateLinkEntity,
	openEntityLink,
	recordLabel,
	scrollIntoContainer,
} from './common';
import { ConnectedEntities } from './connected-entities';
import { LinkOption } from './link-textarea';
import { MarkdownField, type MarkdownFieldHandle } from './markdown-field';
import { FountainField, FountainFieldHandle } from './fountain-field';
import { BranchDraft, BranchOverlay } from './branch-overlay';
import { extractLinkpath, linkTargetOf, memberEntryLinkpath } from '../indexer';
import { evaluateEvent, recomputeEventLocks, waitForMetadataSync } from '../gm-lock';
import { cascadeDecisionPointSession, reconcileSessionBeforeLink } from '../gm-decision-point';
import { clearFmKeys, fmLoomValue, setLoomKey } from '../fm';
import { MiniGraph } from './mini-graph';
import { findMapsFile } from './map-view';
import { useIndexVersion } from './hooks';
import {
	PagesPreviewBody,
	buildNavTree,
	actScriptText,
	deleteScriptEntity,
	editScriptAndSync,
	pushActTitles,
	renderNavTreeItem,
	replaceAltContentInScript,
	sceneScriptText,
	stripAnnotationMarkerInScript,
	useScriptText,
	type NavItem,
	type NavNode,
	type ScriptSearchMatch,
} from './script-view';
import {
	ActChapterBlocks,
	deleteBookEntity,
	editBookAndSync,
	openThisChapter,
	useBookAnnotations,
	useBookText,
} from './book-view';
import {
	chapterBookText,
	moveBookChapterToAct,
	renameBookActTitle,
	renameBookChapterTitle,
	replaceBookChapterBody,
	reorderBookChaptersInAct,
} from '../prose';
import {
	AltTextEntry,
	CommentEntry,
	mutateScriptNotes,
	undecidedAltRows,
	unresolvedCommentRows,
	useScriptNotes,
} from './script-notes';
import { AlternativesBrowserPanel, CommentPopover, CommentsBrowserPanel } from './annotation-popover';
import {
	moveSceneToSection,
	moveSceneBefore,
	reorderScenesInSection,
	renameSectionTitle,
	replaceSceneBody,
	joinLocationSub,
	setSceneHeadingParts,
	findAnnotationSpans,
	type AnnotationSpan,
	nextSectionAtLevel,
	nextTopSectionLine,
	parseFountain,
	parseSceneHeading,
	reorderBranchGroup,
	sceneAtLine,
	sceneBodyLineOffset as computeSceneBodyLineOffset,
	sceneEndLine,
	type ParsedScript,
	branchComboKey,
	collectLoomIds,
	copyBranchGroup,
	cutBranchGroup,
	freshLoomId,
	insertBranch,
	nextComboNumber,
	pasteBranchGroup,
	removeBranchFromGroup,
	replaceBranchBody,
	setBranchTagValue,
} from '../fountain';
import { getBranchClipboard, setBranchClipboard } from './branch-clipboard';
import { pdfPages } from '../pdf';
import { features, projectRoleType, projectTypes, roleOf } from '../project-kind';
import type LoomLoomPlugin from '../main';
import { LocaleKey, t, tn } from '../i18n';
import { entityLabel, entityPlural } from '../types';

/**
 * Embedded branch cards — spike toggle. When `true`, the Scene page's own
 * `FountainField` renders branch groups as chrome laid directly over their
 * own real text (see `fountain-field.tsx`'s "Embedded branch cards" doc
 * comment above `activeBranchByGroup`) instead of mounting `BranchOverlay`'s
 * `position: fixed` cards. A single flag rather than deleting anything yet —
 * this is step 1 of the phased plan (ROADMAP), not a finished replacement:
 * flip back to `false` to compare against the overlay, or once a real gap is
 * found against it.
 */
const EMBEDDED_BRANCH_CARDS_SPIKE = true;

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
		if (!this.file) return t('view.entity.tabFallback');
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

/** `buildNavTree` only starts grouping branch-tagged sections under a shared
 *  decision-point parent once it has seen a real 'scene' item (`lastScene` in
 *  its own merge loop) — so a tree bounded to just ONE scene's own span has
 *  to include that scene's own heading line in the build, or every branch
 *  section it contains falls through as a flush top-level sibling instead of
 *  nesting under its `DP-xx` identifier. But the Scene page's own mini nav
 *  panel and Outline don't want the scene repeating itself as a row — so
 *  this builds WITH the heading included, then unwraps the single resulting
 *  'scene' item back out, keeping whatever grouping happened inside it. */
function sceneOwnTree(parsed: ParsedScript, headingLine: number, endLine: number): NavNode {
	const tree = buildNavTree(parsed, headingLine, endLine);
	const first = tree.items[0];
	return first && first.kind === 'scene' ? { ...tree, items: first.items } : tree;
}

function useFrontmatterWriter(plugin: LoomLoomPlugin, file: TFile | null) {
	return useMemo(
		() => (apply: (fm: Record<string, unknown>) => void) => {
			if (!file) return;
			plugin.app.fileManager.processFrontMatter(file, apply).catch((e) => {
				console.error('Loom Loom: failed to update frontmatter', e);
				new Notice(t('view.entity.common.saveFailed'));
			});
		},
		[plugin, file]
	);
}

/** A debounced (600ms idle) writer for one frontmatter key — the Description
 *  and Reward fields commit this exact way (no blur-style moment reliably
 *  fires before navigation), differing only in which key to write and what to
 *  log on failure. */
function useDebouncedFrontmatterField(plugin: LoomLoomPlugin, file: TFile | null, key: string, label: string) {
	return useMemo(() => {
		let timer = 0;
		return (value: string) => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				if (!file) return;
				plugin.app.fileManager
					.processFrontMatter(file, (fm: Record<string, unknown>) => {
						setLoomKey(fm, key, value);
					})
					.catch((e) => {
						console.error(`Loom Loom: failed to save ${label}`, e);
					});
			}, 600);
		};
	}, [plugin, file, key, label]);
}

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
	linkLabels,
	ambientSuggestDismissMs,
	ambientExcludeTarget,
	onOpenLink,
	onCreateEntity,
	onCommit,
}: {
	app: App;
	initial: string;
	names: LinkOption[];
	linkLabels?: Map<string, string>;
	ambientSuggestDismissMs?: number;
	ambientExcludeTarget?: string;
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
			linkLabels={linkLabels}
			ambientSuggestDismissMs={ambientSuggestDismissMs}
			ambientExcludeTarget={ambientExcludeTarget}
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
	/** The project's Book, for a Chapter/Act page's Editor section — same
	 *  role `scriptText` plays for Script mode, unused by every other
	 *  entity type. */
	const bookText = useBookText(plugin, project);
	/** Comments/alternative-text for the Book — shared by the Chapter and Act
	 *  (Prose) sections below via `useBookAnnotations` (book-view.tsx), same
	 *  hook `BookView` itself uses, so an id resolves identically wherever
	 *  it's opened from. */
	const bookAnnotations = useBookAnnotations(plugin, project);
	/** Guards `commitName`/`commitActTitle` against firing twice concurrently
	 *  (Enter then blur) — see those functions' own doc comments. Read here,
	 *  not down next to them, for the same reason as `scriptText`/`bookText`
	 *  above: a hook can't sit behind the early return below (`!file ||
	 *  !record`) — a real, reported bug this fixes: this ref used to live
	 *  right next to `commitName` itself, past that return, so a component
	 *  instance whose `record` only became available on a LATER render (the
	 *  vault's index still cold right after Obsidian's own startup, well
	 *  after this same view had already rendered once with `record`
	 *  undefined) called one MORE hook than its previous render had — a
	 *  genuine Rules-of-Hooks violation (React error #310, "rendered more
	 *  hooks than during the previous render"), surfacing as every page in
	 *  the workspace going blank until the affected tab was closed and
	 *  reopened fresh (a plain navigation always hits a warm index, so it
	 *  never took this path) — restoring a saved workspace on the next
	 *  launch reliably reproduced it again, since the same cold-index race
	 *  replayed identically. */
	const commitNameInFlightRef = useRef(false);
	/** Session page's own event hub: the bottom "+ Add" button (mirrors the
	 *  top one, added so a long play session doesn't need scrolling back up
	 *  every time) only shows once the TOP button has scrolled out of view —
	 *  otherwise both would be on screen at once, redundant. Tracked via
	 *  IntersectionObserver rather than a scroll listener, so it costs
	 *  nothing while the top button is in view (the common case). */
	const topAddEventBtnRef = useRef<HTMLButtonElement | null>(null);
	const [topAddEventBtnVisible, setTopAddEventBtnVisible] = useState(true);
	useEffect(() => {
		const el = topAddEventBtnRef.current;
		if (!el) return;
		const observer = new IntersectionObserver(([entry]) => setTopAddEventBtnVisible(entry.isIntersecting), {
			threshold: 0,
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [record?.path]);
	const [chapterEditorMode, setChapterEditorMode] = useState<'editor' | 'preview'>('editor');
	const [chapterSearchQuery, setChapterSearchQuery] = useState('');
	/** Scrolls the tabs row into view on every click — mirrors Script-mode's
	 *  own `clickActTab`/`scrollTabsIntoView`, even a re-click of the pane
	 *  already active. */
	const chapterTabsRef = useRef<HTMLDivElement | null>(null);
	const clickChapterTab = (next: 'editor' | 'preview') => {
		setChapterEditorMode(next);
		window.requestAnimationFrame(() => {
			chapterTabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	};
	const chapterEditorRef = useRef<MarkdownFieldHandle | null>(null);
	/** A character offset to land on once the chapter's own Editor field is
	 *  back — same "stash it, apply once mounted" pattern as the Scene
	 *  section's `pendingSceneScrollLineRef`. Seeded from
	 *  `loom-chapter-script-line:<path>`, written by the "Open this chapter"
	 *  right-click action (`ActChapterBlocks`/`Book`'s own `openThisChapter`)
	 *  before navigating here — an offset, not a line, since `MarkdownField`
	 *  exposes only `scrollToPos`. */
	const pendingChapterScrollLineRef = useRef<number | null>(
		(() => {
			if (!record) return null;
			const saved = window.localStorage.getItem(`loom-chapter-script-line:${record.path}`);
			const n = saved ? Number(saved) : NaN;
			return Number.isFinite(n) && n >= 0 ? n : null;
		})()
	);
	/** Comments/Alternatives browse-all panel, Chapter's own Preview — a
	 *  confirmed gap this closes: this page never had one at all (only the
	 *  disabled placeholder pair), even though Book's identical Preview
	 *  surface already had a working one. Scoped to just `chapterExcerpt`
	 *  (not the whole book) — the same "this page's own excerpt only"
	 *  scope Scene's Fountain-side panel already uses, not Book's
	 *  whole-document one, since a Chapter page is a single-chapter surface
	 *  the same way a Scene page is a single-scene one. */
	const [chapterSidePanel, setChapterSidePanel] = useState<'comments' | 'alt' | null>(null);
	/** Scopes the browse panel's "jump to this text" DOM lookup to just
	 *  Chapter's own rendered Preview — mirrors `sceneScriptEditorWrapRef`'s
	 *  own reasoning (never accidentally match a DIFFERENT field mounted
	 *  elsewhere in the same window). */
	const chapterPreviewWrapRef = useRef<HTMLDivElement | null>(null);
	/** Act (Prose) page's own Preview/Outline pill + search — sibling of the
	 *  Chapter section's own state just above, kept separate from
	 *  `actScriptMode`/`actScriptQuery` (Script-mode Act, a different feature
	 *  entirely) even though the two never render at once (`bookMode` and
	 *  `scriptMode` are mutually exclusive per project). No Editor mode —
	 *  Act lost its own editable field, so only Preview/Outline remain. */
	const [actBookMode, setActBookMode] = useState<'preview' | 'outline'>('preview');
	const [actBookQuery, setActBookQuery] = useState('');
	const actBookTabsRef = useRef<HTMLDivElement | null>(null);
	const clickActBookTab = (next: 'preview' | 'outline') => {
		setActBookMode(next);
		window.requestAnimationFrame(() => {
			actBookTabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	};
	/** Comments/Alternatives browse-all panel, Act's own Prose section — same
	 *  confirmed gap as Chapter's Preview above (only the disabled placeholder
	 *  pair existed). Scoped per-chapter and concatenated (see the row-list
	 *  computation below, near `actChapters`) rather than over the whole
	 *  book — this act's own chapters only, matching the "this page's own
	 *  content" scope every other browse panel on this file uses. */
	const [actBookSidePanel, setActBookSidePanel] = useState<'comments' | 'alt' | null>(null);
	const actBookPreviewWrapRef = useRef<HTMLDivElement | null>(null);
	const actBookCommitQueueRef = useRef<Promise<unknown>>(Promise.resolve());
	/** Same fix as `book-view.tsx`'s `queueBookEdit` (see its own doc comment
	 *  — a straight port of `script-view.tsx`'s `commit`'s `.catch`
	 *  reasoning): without swallowing a failed run's rejection on the queue
	 *  itself, one throwing `editBookAndSync` call would silently wedge
	 *  every edit queued after it on this Act page for the rest of its
	 *  lifetime. Outline's own chapter-reorder is the only thing left using
	 *  this — Act's own Editor field (which used to share it via
	 *  `commitActBookDraft`) is gone. */
	const queueActBookEdit = (apply: (text: string) => string | null) => {
		if (!project) return;
		const run = actBookCommitQueueRef.current.then(() => editBookAndSync(plugin, project, apply));
		actBookCommitQueueRef.current = run.catch((e) => {
			console.error('Loom Loom: could not commit an act book edit', e);
		});
	};
	/** Comment bodies + alt-text option lists — same project-level sidecar
	 *  the main Script view reads/writes, kept live the same way. Unused by
	 *  every entity type but Scene/Act, same as `scriptText` above. */
	const scriptNotes = useScriptNotes(plugin, project);
	/** Which comment's popover is open (Scene and Act pages share this
	 *  one piece of state — a page is only ever one or the other, never
	 *  both, so there's no risk of them fighting over it). */
	const [openComment, setOpenComment] = useState<{ id: string; rect: DOMRect } | null>(null);
	/** Marker ids that have had a reply added THIS session — same reasoning
	 *  as script-view.tsx's own copy: `scriptNotes` only catches up once the
	 *  sidecar's `vault.modify` + file-watch round trip completes, so
	 *  `handleCloseComment` below checks this instead of trusting
	 *  `scriptNotes` alone at close time. */
	const commentsWithNewEntryRef = useRef<Set<string>>(new Set());
	/** A marker id the current Act/Scene search match points at — same
	 *  role as the main Script view's own `highlightedAnnotationId`. */
	const [highlightedAnnotationId, setHighlightedAnnotationId] = useState<string | null>(null);
	/** Comment/alt-text handlers — identical logic to the main Script view's
	 *  own (script-view.tsx's `Script` component), just guarded on `project`
	 *  being resolved here rather than gated behind an early return. Shared
	 *  by both the Act and Scene Script sections below. */
	/** `wrapRef`/`pagesRefArg` are whichever of the Act/Scene section's own
	 *  wrapper refs is currently mounted — same "take the caller's own ref as
	 *  a parameter" pattern as `handleCycleAlt`/`handleOpenAltMenu` below,
	 *  since this one handler is shared by both and only one is ever live.
	 *  Opens the popover immediately (see script-view.tsx's own
	 *  `handleCreateComment` for why a frame's delay is defensive, not load-
	 *  bearing — CM6 updates its gutter synchronously as part of dispatch).
	 *  Deliberately does NOT pre-create a sidecar entry — same reasoning as
	 *  script-view.tsx's own copy of this handler: `entries: []` is what
	 *  lands the user in the popover's always-available reply box instead of
	 *  a pre-created blank row. */
	const handleCreateComment = (
		wrapRef: { current: HTMLDivElement | null },
		pagesRefArg: { current: HTMLDivElement | null },
		id: string,
		_selectedText: string
	) => {
		window.requestAnimationFrame(() => {
			const icon =
				wrapRef.current?.querySelector(`[data-loom-annotation-id="${id}"]`) ??
				pagesRefArg.current?.querySelector(`[data-loom-annotation-id="${id}"]`);
			if (icon instanceof HTMLElement) handleOpenComment(id, icon.getBoundingClientRect());
		});
	};
	/** Wraps the selection as option 0, then immediately prompts for a SECOND
	 *  option (same `TextInputModal` the right-click menu's "Add
	 *  alternative…" uses) — matches the comment flow's "picking the menu
	 *  item opens something to type into" expectation. Cancelling (closing
	 *  the modal without submitting) undoes the WHOLE creation — same
	 *  reasoning as script-view.tsx's own copy of this handler: a span stuck
	 *  at one option is exactly the "nothing left to alternate between" case
	 *  `handleDeleteAltOption` already strips back to plain text for, so
	 *  backing out here does the same. Only ever reachable from the Scene
	 *  section's own `FountainField` — creating a NEW span needs a live
	 *  selection, which only Scene (and Chapter, on the Prose side) still
	 *  has. */
	const handleCreateAlt = (id: string, selectedText: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => ({
			...notes,
			altText: { ...notes.altText, [id]: { id, options: [selectedText], activeIndex: 0, acceptedIndex: null } },
		}));
		new TextInputModal(plugin.app, {
			title: t('view.entity.altText.addWordingTitle'),
			placeholder: selectedText,
			cta: t('project.common.add'),
			multiline: true,
			onSubmit: (value) => {
				if (!project) return;
				void mutateScriptNotes(plugin.app, project, (notes) => {
					const cur = notes.altText[id];
					if (!cur) return notes;
					return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options: [...cur.options, value] } } };
				});
			},
			onCancel: () => {
				if (!project) return;
				void mutateScriptNotes(plugin.app, project, (notes) => {
					const { [id]: _dropped, ...rest } = notes.altText;
					return { ...notes, altText: rest };
				}).then(() => applyRemoveMarkers(id));
			},
		}).open();
	};
	/** Persists whatever the Scene section's own live CM6 instance currently
	 *  holds — same reasoning as script-view.tsx's own (now-deleted, raw-text
	 *  based) `commitFieldEdit`: alt-text cycling/drafting/accepting/deleting,
	 *  all reachable from a gutter/margin icon or `AltTextModal`, apply their
	 *  edit straight through the ref without ever putting real EDITOR FOCUS
	 *  on it, so the normal write-on-blur path never fires and the change
	 *  would otherwise sit in the live document only, lost on reload. Reads
	 *  the fresh EXCERPT text off the ref (`getValue`), then writes it back
	 *  into the full script via `replaceSceneBody`. Act has no live ref any
	 *  more (its own Script section lost its editable field) — its own
	 *  mutations go through `applyAltContentChange`/`applyRemoveMarkers`
	 *  below instead, which call this only for Scene. */
	const commitFieldEdit = (fieldRef: { current: FountainFieldHandle | null }) => {
		if (!project || !record || record.type !== 'scene') return;
		const fresh = fieldRef.current?.getValue();
		if (fresh === undefined) return;
		void editScriptAndSync(plugin, project, (raw) => replaceSceneBody(raw, record.sceneId, fresh));
	};
	/** The single write path every alt-text mutation handler below goes
	 *  through: Scene's own field mutates then commits through it whenever
	 *  it's actually mounted (`sceneScriptEditorRef.current` truthy — Scene's
	 *  own Script/live-editor mode), byte-identical to what this codebase did
	 *  before Act lost its own field. **Falls to the raw-text
	 *  `replaceAltContentInScript` (script-view.tsx) whenever the ref is
	 *  null, full stop — not just for Act.** A real, confirmed bug this
	 *  fixes: the ref is ALSO null while viewing Scene's own Pages/Outline
	 *  mode (its `FountainField` only mounts in Script mode), and the
	 *  previous `record?.type === 'act'` guard silently no-op'd there too —
	 *  cycling/picking alt-text from Scene's Pages view (or deleting an
	 *  option down to one, which strips the sidecar entry unconditionally
	 *  regardless of whether the raw-text strip below succeeds) looked like
	 *  it worked from the sidecar's own perspective but never touched the
	 *  actual document, leaving a stale marker with no sidecar data behind
	 *  it. Same raw-text-find-and-rewrite approach `book-view.tsx`'s
	 *  `replaceAltContentInBook` already uses for the identical "no live
	 *  field to dispatch through" problem. */
	const applyAltContentChange = (id: string, text: string) => {
		if (sceneScriptEditorRef.current) {
			sceneScriptEditorRef.current.replaceAltContent(id, text);
			commitFieldEdit(sceneScriptEditorRef);
		} else if (project) {
			void replaceAltContentInScript(plugin, project, id, text);
		}
	};
	/** Mirrors `applyAltContentChange` for stripping an orphaned marker pair
	 *  (a comment thread emptied down to zero replies, or a just-created
	 *  alt-text span cancelled) — same fix, same reasoning: falls to the
	 *  raw-text path whenever the ref is null, not just for Act. */
	const applyRemoveMarkers = (id: string) => {
		if (sceneScriptEditorRef.current) {
			sceneScriptEditorRef.current.removeAnnotationMarkers(id);
			commitFieldEdit(sceneScriptEditorRef);
		} else if (project) {
			void stripAnnotationMarkerInScript(plugin, project, id);
		}
	};
	const handleOpenComment = (id: string, rect: DOMRect) => setOpenComment({ id, rect });

	/** Closing the popover with nothing ever added to the thread abandons the
	 *  whole comment creation — same reasoning as `handleCreateAlt`'s own
	 *  cancel above: a freshly inserted marker pair backed by no
	 *  `comments[id]` entry (only `handleAddCommentReply` ever creates one)
	 *  would otherwise sit in the document forever as a permanently-empty
	 *  gutter icon. Checks BOTH `scriptNotes` (an existing comment, reopened)
	 *  and `commentsWithNewEntryRef` (a reply just added this session, ahead
	 *  of the sidecar's own async round trip). Reachable from either the
	 *  Act's (Pages, read-only) or the Scene's (live editor) own section, so
	 *  goes through `applyRemoveMarkers` — its own `record.type` branch
	 *  picks the right path regardless of which page this is. */
	const handleCloseComment = () => {
		if (
			openComment &&
			!commentsWithNewEntryRef.current.has(openComment.id) &&
			!scriptNotes.comments[openComment.id]
		) {
			applyRemoveMarkers(openComment.id);
		}
		setOpenComment(null);
	};
	/** Saves an EDIT to one reply's text — same reasoning as script-view.tsx's
	 *  own `handleSaveCommentEntry`. */
	const handleSaveCommentEntry = (id: string, index: number, text: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const list = notes.comments[id];
			if (!list || index < 0 || index >= list.length) return notes;
			const next = list.slice();
			next[index] = { ...next[index], text, updatedAt: Date.now() };
			return { ...notes, comments: { ...notes.comments, [id]: next } };
		});
	};
	const handleToggleCommentResolved = (id: string, index: number) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const list = notes.comments[id];
			if (!list || index < 0 || index >= list.length) return notes;
			const existing = list[index];
			const resolved = !existing.resolved;
			const next = list.slice();
			next[index] = { ...existing, resolved, resolvedAt: resolved ? Date.now() : null };
			return { ...notes, comments: { ...notes.comments, [id]: next } };
		});
	};
	/** Same reasoning as script-view.tsx's own `handleDeleteCommentEntry` — an
	 *  empty thread also has to strip the marker pair from the document, or
	 *  an orphaned marker with no sidecar data behind it keeps rendering as a
	 *  live span. This page's `CommentPopover` is shared by the Act and
	 *  Scene sections, so goes through `applyRemoveMarkers` the same way
	 *  `handleCloseComment` above does. */
	const handleDeleteCommentEntry = (id: string, index: number) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const list = notes.comments[id];
			if (!list || index < 0 || index >= list.length) return notes;
			const next = list.filter((_, i) => i !== index);
			if (next.length === 0) {
				const { [id]: _dropped, ...rest } = notes.comments;
				return { ...notes, comments: rest };
			}
			return { ...notes, comments: { ...notes.comments, [id]: next } };
		}).then((next) => {
			if (!next.comments[id]) {
				applyRemoveMarkers(id);
				setOpenComment((prev) => (prev && prev.id === id ? null : prev));
			}
		});
	};
	const handleAddCommentReply = (id: string, text: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const list = notes.comments[id] ?? [];
			const entry: CommentEntry = {
				id,
				text,
				resolved: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				resolvedAt: null,
			};
			return { ...notes, comments: { ...notes.comments, [id]: [...list, entry] } };
		});
	};
	/** The CURRENT live text between an alt-text span's markers — read from
	 *  `sceneDraft` ONLY, not the sidecar's own stored copy: the active
	 *  option's wording is normally edited directly in the script, not
	 *  through `AltTextModal`, and that edit needs somewhere to land before a
	 *  swap moves away from it. **Scene only, deliberately, since the
	 *  modular-only editing change (2026-08-25)**: `actDraft` used to also be
	 *  checked here, back when Act had its own live editable field — now it's
	 *  always just a disk mirror (no live typing possible on Act's own page
	 *  any more), so comparing an option's stored text against it doesn't
	 *  detect a "hand-edit," it detects ordinary replication lag from the
	 *  PREVIOUS swap's write not having round-tripped back into `actDraft`
	 *  yet — treating that lag as a hand-edit worth preserving corrupted a
	 *  DIFFERENT option's text with stale wording, the exact bug reported as
	 *  "cycling turns every option into the same one" (mirrors the identical
	 *  fix in script-view.tsx's own `handleCycleAlt`, which had no live
	 *  editor to protect either, for the same reason). */
	const liveAltSpanText = (id: string): string | null => {
		const span = findAnnotationSpans(sceneDraft).find((s) => s.kind === 'alt' && s.id === id);
		return span ? sceneDraft.slice(span.contentFrom, span.contentTo) : null;
	};
	const syncOutgoingAltOption = (id: string, cur: AltTextEntry): AltTextEntry => {
		const live = liveAltSpanText(id);
		if (live === null || live === cur.options[cur.activeIndex]) return cur;
		const options = cur.options.slice();
		options[cur.activeIndex] = live;
		return { ...cur, options };
	};
	/** Same "compute the next index INSIDE the fresh re-read" shape as
	 *  script-view.tsx's own `handleCycleAlt` — a click landing before
	 *  `scriptNotes` React state has caught up with a just-written change
	 *  would otherwise recompute the same "next" index every time and the
	 *  cycle would stall after one step. */
	const handleCycleAlt = (id: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur0 = notes.altText[id];
			if (!cur0 || cur0.options.length === 0) return notes;
			const cur = syncOutgoingAltOption(id, cur0);
			const nextIndex = (cur.activeIndex + 1) % cur.options.length;
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, activeIndex: nextIndex } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur) applyAltContentChange(id, cur.options[cur.activeIndex]);
		});
	};
	/** A row was picked as the DRAFT — clears `acceptedIndex` (choosing a
	 *  different draft means the span is back to "still deciding"), same
	 *  reasoning as script-view.tsx's own `handleDraftAlt`. */
	const handleDraftAlt = (id: string, index: number) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur0 = notes.altText[id];
			if (!cur0 || index < 0 || index >= cur0.options.length) return notes;
			const cur = syncOutgoingAltOption(id, cur0);
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, activeIndex: index, acceptedIndex: null } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur) applyAltContentChange(id, cur.options[cur.activeIndex]);
		});
	};
	/** A row was picked as the ACCEPTED, final option. */
	const handleAcceptAlt = (id: string, index: number) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur0 = notes.altText[id];
			if (!cur0 || index < 0 || index >= cur0.options.length) return notes;
			const cur = syncOutgoingAltOption(id, cur0);
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, activeIndex: index, acceptedIndex: index } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur) applyAltContentChange(id, cur.options[cur.activeIndex]);
		});
	};
	/** An existing option's wording was edited in place inside `AltTextModal`
	 *  — same reasoning as script-view.tsx's own `handleEditAltOption`: if
	 *  it's the currently ACTIVE option, the live document has to follow. */
	const handleEditAltOption = (id: string, index: number, newText: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur = notes.altText[id];
			if (!cur || index < 0 || index >= cur.options.length) return notes;
			const options = cur.options.slice();
			options[index] = newText;
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options } } };
		}).then((next) => {
			const cur = next.altText[id];
			if (cur && cur.activeIndex === index) applyAltContentChange(id, newText);
		});
	};
	const handleAddAltOption = (id: string, text: string) => {
		if (!project) return;
		void mutateScriptNotes(plugin.app, project, (notes) => {
			const cur = notes.altText[id];
			if (!cur) return notes;
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options: [...cur.options, text] } } };
		});
	};
	/** Same reasoning/renumbering as script-view.tsx's own
	 *  `handleDeleteAltOption` — deleting down to exactly one remaining
	 *  option strips the `[[loom-alt:<id>]]` wrapper entirely (nothing left
	 *  to alternate between), leaving the survivor's wording as plain text,
	 *  same as a comment thread's own "delete the last one" behavior. The
	 *  modal awaits the resolved value to re-sync its own local list. */
	const handleDeleteAltOption = (id: string, index: number) => {
		if (!project) return Promise.resolve(undefined);
		let strippedTo: string | null = null;
		return mutateScriptNotes(plugin.app, project, (notes) => {
			const cur = notes.altText[id];
			if (!cur || cur.options.length <= 1 || index < 0 || index >= cur.options.length) return notes;
			const options = cur.options.slice();
			options.splice(index, 1);
			if (options.length <= 1) {
				strippedTo = options[0] ?? '';
				const { [id]: _dropped, ...rest } = notes.altText;
				return { ...notes, altText: rest };
			}
			let activeIndex = cur.activeIndex;
			if (index === activeIndex) activeIndex = Math.min(index, options.length - 1);
			else if (index < activeIndex) activeIndex -= 1;
			let acceptedIndex = cur.acceptedIndex;
			if (acceptedIndex !== null) {
				if (index === acceptedIndex) acceptedIndex = null;
				else if (index < acceptedIndex) acceptedIndex -= 1;
			}
			return { ...notes, altText: { ...notes.altText, [id]: { ...cur, options, activeIndex, acceptedIndex } } };
		}).then((next) => {
			if (strippedTo !== null) {
				applyAltContentChange(id, strippedTo);
				applyRemoveMarkers(id);
				return undefined;
			}
			const cur = next.altText[id];
			if (cur) applyAltContentChange(id, cur.options[cur.activeIndex]);
			return cur;
		});
	};
	/** Right-click: opens `AltTextModal` (project.ts — a real closeable
	 *  window, same as script-view.tsx's own) instead of the old truncating
	 *  `Menu`. Reachable from both the Act's (Pages) and the Scene's (live
	 *  editor) own section — `applyAltContentChange`/`applyRemoveMarkers`
	 *  pick the right write path via `record.type`, closed over directly by
	 *  the modal's callbacks since the modal is a one-shot imperative dialog
	 *  with no need to remember it across a React re-render. */
	const handleOpenAltMenu = (id: string) => {
		if (!project) return;
		const entry = scriptNotes.altText[id];
		if (!entry) return;
		// Patches the active row's DISPLAYED text with whatever's actually live
		// in the document right now — same reasoning as script-view.tsx's own
		// copy of this fix: `entry` is the sidecar's stored copy, which only
		// catches up lazily on the next cycle/draft/accept swap, so opening
		// the modal right after a hand-edit used to show stale wording for the
		// active option until the next swap resynced it.
		const { options } = syncOutgoingAltOption(id, entry);
		new AltTextModal(plugin.app, {
			options,
			activeIndex: entry.activeIndex,
			acceptedIndex: entry.acceptedIndex,
			onDraft: (index) => handleDraftAlt(id, index),
			onAccept: (index) => handleAcceptAlt(id, index),
			onEditOption: (index, newText) => handleEditAltOption(id, index, newText),
			onAddOption: (text) => handleAddAltOption(id, text),
			onDeleteOption: (index) => handleDeleteAltOption(id, index),
		}).open();
	};
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
	 *  as the main Script view, scoped to just this scene's own excerpt.
	 *  Remembered per-note in `localStorage` — same "which pane was open last
	 *  time" preference the main Script view keeps under `loom-script-mode:`,
	 *  just keyed separately since a Scene note's own excerpt view is a
	 *  distinct surface from the whole-script one. */
	const [sceneScriptMode, setSceneScriptMode] = useState<'script' | 'pages' | 'outline'>(() => {
		const saved = record ? window.localStorage.getItem(`loom-scene-script-mode:${record.path}`) : null;
		return saved === 'pages' || saved === 'outline' ? saved : 'script';
	});
	const [sceneScriptQuery, setSceneScriptQuery] = useState('');
	const [sceneScriptMatchIndex, setSceneScriptMatchIndex] = useState(0);
	const sceneScriptEditorRef = useRef<FountainFieldHandle | null>(null);
	/** The Script-mode wrapper div (`.loom-scene-script`) — scoped lookups for
	 *  a comment's rendered gutter icon (search-driven auto-open) read from
	 *  here rather than the whole document, in case more than one script
	 *  editor happens to be mounted at once across different open panes. */
	const sceneScriptEditorWrapRef = useRef<HTMLDivElement | null>(null);
	const sceneScriptPagesRef = useRef<HTMLDivElement | null>(null);
	/** Bumped on every CM6 update where the field's own viewport/geometry
	 *  actually changed (`FountainField`'s `onGeometryChange`) — the one
	 *  signal `BranchOverlay` has no other way to see, since it's a plain
	 *  React component with no access to CM6's own update stream. Passed
	 *  down as a prop so a change re-triggers its positioning effect, same
	 *  as `text` changing. */
	const [sceneScriptGeometryVersion, setSceneScriptGeometryVersion] = useState(0);
	/** The modular branch editor's still-open drafts (`BranchOverlay.tsx`) —
	 *  co-located with the Script section's own refs above, same reasoning:
	 *  a page is only ever showing one Scene at a time, so there's no
	 *  cross-component coordination to do. Cleared to `[]` on record change
	 *  via the same reset the Scene page's other per-record state already
	 *  gets (see the effect below) — a draft's CM6 anchor lives in the OTHER
	 *  Scene's own `FountainField` instance and would be meaningless here. */
	const [branchDrafts, setBranchDrafts] = useState<BranchDraft[]>([]);
	useEffect(() => {
		setBranchDrafts([]);
	}, [record?.path]);
	/** The section id of a branch just created via `handleAddBranch`, still
	 *  waiting for its own Title field to claim the one-shot "show blank,
	 *  not the underlying `'Untitled'` placeholder" treatment — see that
	 *  function's own doc comment. Reset alongside `branchDrafts` for the
	 *  same reason (meaningless once the page moves to a different Scene). */
	const [pendingBranchTitleFocusId, setPendingBranchTitleFocusId] = useState<string | null>(null);
	useEffect(() => {
		setPendingBranchTitleFocusId(null);
	}, [record?.path]);
	/** Extra `padding-top` (pixels, keyed by branch section id) the Scene's
	 *  own `FountainField` reserves right after each branch's span, so its
	 *  `BranchOverlay` panel can be genuinely taller than the raw span
	 *  without overlapping whatever follows — see branch-overlay.tsx's own
	 *  top doc comment ("A branch's card can be genuinely TALLER..."). Reset
	 *  alongside `branchDrafts` for the same reason (meaningless once the
	 *  page moves to a different Scene). */
	const [sceneBranchSpacers, setSceneBranchSpacers] = useState<Record<string, number>>({});
	useEffect(() => {
		setSceneBranchSpacers({});
	}, [record?.path]);
	/** Applies a patch to one draft and, once its required fields are all
	 *  filled, transitions it to a real branch (`insertBranch`, fountain.ts)
	 *  through `editScriptAndSync` — the same "operate on fresh disk text,
	 *  never on `sceneDraft`" pattern every other structural Scene-page edit
	 *  already uses (`setSceneHeadingParts`'s own call sites), so this needs
	 *  no special handling for `sceneDraft` possibly holding uncommitted
	 *  prose edits: the live `FountainField`'s own "sync external value only
	 *  while unfocused" convention (fountain-field.tsx) is what reconciles
	 *  the two once the field next loses focus, same as it always has. */
	/** A draft field changed — updates state only, never commits. Committing
	 *  used to happen automatically the instant `title`/`identifier`/
	 *  `subidentifier` all became non-empty, which meant typing the FIRST
	 *  character of whichever of the three happened to be filled in LAST
	 *  wrote the branch immediately, mid-keystroke, before the user had
	 *  finished typing that field — a real, reported complaint. Committing
	 *  is now exclusively `handleCommitBranchDraft`'s job, fired only by the
	 *  draft's own explicit "Create" button. */
	const handleBranchDraftField = (id: string, patch: Partial<BranchDraft>) => {
		setBranchDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
	};
	/** The draft's own "Create" button — the one place a `new-group` draft
	 *  actually becomes a real branch (see `handleBranchDraftField`'s own
	 *  doc comment for why this is no longer automatic). A no-op if the
	 *  required fields (title/identifier/subidentifier) aren't all filled —
	 *  the button itself is disabled in that state too, this is just the
	 *  same guard against a stale click racing a field clearing back out. */
	const handleCommitBranchDraft = (id: string) => {
		const draft = branchDrafts.find((d) => d.id === id);
		if (!draft) return;
		const title = draft.title.trim();
		const ready = title !== '' && draft.identifier.trim() !== '' && draft.subidentifier.trim() !== '';
		if (!ready || !project) return;
		setBranchDrafts((prev) => prev.filter((d) => d.id !== id));
		const anchorLine = sceneScriptEditorRef.current?.getDraftAnchorLine(id);
		sceneScriptEditorRef.current?.clearDraftAnchor(id);
		if (anchorLine === null || anchorLine === undefined) return;
		void editScriptAndSync(plugin, project, (raw) => {
			const parsed = parseFountain(raw);
			// The draft's anchor line is relative to `sceneDraft` (the SCENE'S
			// OWN excerpt, heading stripped) — `editScriptAndSync` hands
			// `apply` the FULL script text, so the anchor has to be
			// re-expressed as a whole-document line before `insertBranch` can
			// use it. `sceneBodyLineOffset` (this component's own shared
			// helper) is the exact same "how many lines does the scene's own
			// heading/body-start occupy" math every other excerpt-relative-to-
			// whole-document translation here uses.
			const scene = parsed.scenes.find((s) => s.loomId === record?.sceneId);
			if (!scene) return null;
			const wholeDocLine = scene.line + computeSceneBodyLineOffset(sceneExcerpt ?? '') + anchorLine;
			const numberOrOverride =
				draft.numberOverride.trim() ||
				String(nextComboNumber(parsed, branchComboKey(`${draft.identifier.trim()}-${draft.subidentifier.trim()}-1`)));
			const branchValue = `${draft.identifier.trim()}-${draft.subidentifier.trim()}-${numberOrOverride}`;
			return insertBranch(raw, { line: wholeDocLine }, { title, branchValue });
		});
	};
	const handleDismissBranchDraft = (id: string) => {
		sceneScriptEditorRef.current?.clearDraftAnchor(id);
		setBranchDrafts((prev) => prev.filter((d) => d.id !== id));
	};
	const handleCreateBranchDraft = (pos: number) => {
		const id = sceneScriptEditorRef.current?.createDraftAnchor(pos);
		if (!id) return;
		setBranchDrafts((prev) => [...prev, { id, title: '', identifier: '', subidentifier: '', numberOverride: '' }]);
	};
	/** The group's own "+" — writes a real new branch to the document
	 *  IMMEDIATELY (no draft/staging step at all), titled with a literal
	 *  `'Untitled'` placeholder, then focuses its Title field
	 *  (`pendingBranchTitleFocusId`, claimed by `BranchTitleField`'s own
	 *  `autoFocusEmpty`, which shows that field blank rather than literally
	 *  "Untitled" until something is actually typed).
	 *
	 *  This USED TO stage a `kind: 'new-branch'` draft instead, committed
	 *  only once its Title field's `ready` check passed — which, for a
	 *  join-existing-group branch, needed nothing but a non-empty title, so
	 *  it silently became a real section the instant the FIRST character
	 *  landed in that field: a visible, jarring "the card you're typing into
	 *  just turned into a different card" moment (a real, reported
	 *  complaint) despite the panel looking identical before and after.
	 *  Creating it for real up front and masking the placeholder instead
	 *  removes that mode switch entirely — the card is always the SAME real
	 *  card, start to finish.
	 *
	 *  No `ready`/ `insertBranch`-on-edit path is needed here the way
	 *  `handleBranchDraftField` still has for a brand-new decision point
	 *  (`new-group`, from the editor's own right-click) — unlike that case,
	 *  a join-existing-group branch has nothing else to fill in first
	 *  (`identifier`/`subidentifier`/`numberOverride` are inherited verbatim
	 *  from the group, never composed), so there was never a real reason to
	 *  wait.
	 *
	 *  **The new section's id is rolled HERE, synchronously, not learned by
	 *  re-parsing the file after the write lands** — a real, reported bug
	 *  from the first version of this: `editScriptAndSync` does real
	 *  disk-round-tripping work (write, re-read, `syncScenes`, sidecar
	 *  pruning) before its promise ever resolves, and the Scene page's own
	 *  reactive `text` (from `useScriptText`'s vault-modify listener) can
	 *  pick up the raw file write and mount the new card LONG before that —
	 *  seeding `BranchTitleField`'s masked-blank display from a still-`null`
	 *  pending id, so it showed the literal `'Untitled'` text instead of
	 *  masking it. Rolling the id up front and calling
	 *  `setPendingBranchTitleFocusId` BEFORE the `await` guarantees it's
	 *  already in React state by the time any reactive re-render — however
	 *  fast — could possibly mount that card. `insertBranch` (fountain.ts)
	 *  re-validates the id against the actual `parsed` set at write time
	 *  regardless (its own `id?` doc comment), so a caller-supplied id is
	 *  never trusted blindly. */
	const handleAddBranch = async (groupId: string) => {
		if (!project || !scriptParsed) return;
		const newId = freshLoomId(collectLoomIds(scriptParsed.scenes, scriptParsed.sections, scriptParsed.pageBreaks));
		setPendingBranchTitleFocusId(newId);
		const ok = await editScriptAndSync(plugin, project, (raw) =>
			insertBranch(raw, { afterGroupId: groupId }, { title: 'Untitled', branchValue: groupId, id: newId })
		);
		if (!ok) setPendingBranchTitleFocusId(null);
	};
	const handleRenameBranchTitle = (sectionId: string, newTitle: string) => {
		if (!project) return;
		void editScriptAndSync(plugin, project, (raw) => renameSectionTitle(raw, sectionId, newTitle));
	};
	const handleSetBranchCombo = (groupId: string, identifier: string, subidentifier: string, numberOrOverride: string) => {
		if (!project) return;
		void editScriptAndSync(plugin, project, (raw) =>
			setBranchTagValue(raw, groupId, `${identifier}-${subidentifier}-${numberOrOverride}`)
		);
	};
	const handleSetBranchRaw = (groupId: string, newValue: string) => {
		if (!project) return;
		void editScriptAndSync(plugin, project, (raw) => setBranchTagValue(raw, groupId, newValue));
	};
	const handleSetBranchBody = (sectionId: string, newBody: string) => {
		if (!project) return;
		void editScriptAndSync(plugin, project, (raw) => replaceBranchBody(raw, sectionId, newBody));
	};
	const handleCutBranchGroupInScene = (groupId: string) => {
		if (!project) return;
		void editScriptAndSync(plugin, project, (raw) => {
			const result = cutBranchGroup(raw, groupId);
			if (!result) return null;
			setBranchClipboard(result.cut);
			return result.text;
		});
	};
	/** The read-only sibling of the above — leaves the group in the document,
	 *  reading through `editScriptAndSync`'s own fresh-from-disk `raw` purely
	 *  for a consistent read (returning `null` always, so nothing is ever
	 *  written back). A later paste of what this stashes renumbers/re-ids
	 *  itself automatically if the source is still around by then
	 *  (`pasteBranchGroup`, fountain.ts) — nothing extra to do here. */
	const handleCopyBranchGroupInScene = (groupId: string) => {
		if (!project) return;
		void editScriptAndSync(plugin, project, (raw) => {
			const block = copyBranchGroup(raw, groupId);
			if (block) setBranchClipboard(block);
			return null;
		});
	};
	/** The trash icon on a branch card's own `###` row — deletes just THIS
	 *  branch, unlike "Cut branch group" (which keeps the whole group
	 *  recoverable via paste): real prose is genuinely lost, so this confirms
	 *  first (`confirmDialog`, defined further down this component but
	 *  already safe to reference here — it's only actually read once this
	 *  handler is CALLED, by which point the whole component body, including
	 *  that declaration, has already run). */
	const handleDeleteBranchInScene = (sectionId: string) => {
		if (!project) return;
		void confirmDialog(
			t('view.script.branch.deleteBranchConfirmTitle'),
			t('view.script.branch.deleteBranchConfirmDetail'),
			t('view.script.branch.deleteBranchConfirmButton')
		).then((confirmed) => {
			if (!confirmed) return;
			// `setSceneBody(null)` afterward, same as the outer field's own
			// blur-commit — `sceneDraft` falls back to `sceneBody`, a locally
			// buffered override, whenever it's non-null; without clearing it
			// here too, a delete landing while that buffer still holds an
			// UNCOMMITTED edit from the outer field would keep `sceneDraft`
			// (and so every branch card's own re-derived `text`) pinned to
			// the stale pre-delete value regardless of what the write just
			// changed on disk.
			void editScriptAndSync(plugin, project, (raw) => removeBranchFromGroup(raw, sectionId)).then((ok) => {
				if (!ok) {
					new Notice(t('view.script.editWriteFailed'));
					return;
				}
				setSceneBody(null);
			});
		});
	};
	/** Pastes a cut-or-copied decision point, then hands the field's own new
	 *  body straight to `replaceBody` (fountain-field.tsx) once the write
	 *  lands — a direct imperative sync, not the normal reactive
	 *  `scriptText` round trip. That distinction matters here specifically:
	 *  `sceneScriptText` unconditionally strips trailing whitespace from a
	 *  scene's excerpt, which would erase the two blank lines
	 *  `pasteBranchGroup` reserves as a landing spot the INSTANT they become
	 *  the scene's own trailing content (a real, reported bug — the safe
	 *  cursor line computed against the round-tripped, re-stripped excerpt
	 *  pointed at a line that no longer existed there, landing the cursor
	 *  back under the branch card). Computing the new body directly from
	 *  `result.text` inside `apply` — before any such round trip — and
	 *  pushing it into the field ourselves sidesteps the erasure entirely. */
	const handlePasteBranchGroupInScene = (line: number) => {
		if (!project) return;
		const block = getBranchClipboard();
		if (!block) return;
		let pastedBody: string | null = null;
		let pastedCursorLine: number | null = null;
		void editScriptAndSync(plugin, project, (raw) => {
			const parsed = parseFountain(raw);
			const scene = parsed.scenes.find((s) => s.loomId === record?.sceneId);
			if (!scene) return null;
			const bodyOffset = scene.line + computeSceneBodyLineOffset(sceneExcerpt ?? '');
			const result = pasteBranchGroup(raw, bodyOffset + line, block);
			if (result === null) {
				new Notice(t('view.script.branch.pasteRejected'));
				return null;
			}
			const newParsed = parseFountain(result.text);
			const newScene = newParsed.scenes.find((s) => s.loomId === record?.sceneId);
			if (newScene) {
				const newExcerptUntrimmed = result.text
					.split('\n')
					.slice(newScene.line, sceneEndLine(newParsed, newScene))
					.join('\n');
				pastedBody = sceneBodyOf(newExcerptUntrimmed);
				pastedCursorLine = result.cursorLine - newScene.line - computeSceneBodyLineOffset(newExcerptUntrimmed);
			}
			return result.text;
		}).then((ok) => {
			if (ok && pastedBody !== null && pastedCursorLine !== null) {
				sceneScriptEditorRef.current?.replaceBody(pastedBody, pastedCursorLine);
			}
		});
	};
	/** Scrolled into view on every tab click (mirrors the main Script view's
	 *  `tabsRef`/`scrollTabsIntoView`) so switching Script/Pages always lands
	 *  the section in a convenient spot to work in, not wherever the page
	 *  happened to be scrolled. */
	const sceneScriptTabsRef = useRef<HTMLDivElement | null>(null);
	/** A body line to land on once the scene's Script pane is back — same
	 *  "stash it, apply once FountainField remounts" pattern as the main
	 *  Script view's `pendingScrollLineRef`. Also doubles as the initial-open
	 *  restore, seeded from `loom-scene-script-line:<path>` in `localStorage`
	 *  (persisted on the field's own `onBlur` below) — same reasoning as the
	 *  main Script view's identical seeding of its own `pendingScrollLineRef`. */
	const pendingSceneScrollLineRef = useRef<number | null>(
		(() => {
			if (!record) return null;
			const saved = window.localStorage.getItem(`loom-scene-script-line:${record.path}`);
			const n = saved ? Number(saved) : NaN;
			return Number.isFinite(n) && n >= 0 ? n : null;
		})()
	);
	/** Same per-note pane memory as `sceneScriptMode` above, own key since a
	 *  Act note's excerpt is its own separate surface too. No Script mode —
	 *  Act lost its own editable field, so only Pages/Outline remain. */
	const [actScriptMode, setActScriptMode] = useState<'pages' | 'outline'>(() => {
		const saved = record ? window.localStorage.getItem(`loom-act-script-mode:${record.path}`) : null;
		return saved === 'outline' ? saved : 'pages';
	});
	const [actScriptQuery, setActScriptQuery] = useState('');
	const [actScriptMatchIndex, setActScriptMatchIndex] = useState(0);
	const actScriptPagesRef = useRef<HTMLDivElement | null>(null);
	/** Same as `sceneScriptTabsRef`, for the Act page's own Script section. */
	const actScriptTabsRef = useRef<HTMLDivElement | null>(null);
	/** `openComment.rect` is a one-time snapshot — without this, scrolling
	 *  the Scene/Act Script section left the popover floating in the same
	 *  screen spot while the commented text scrolled out from under it. Same
	 *  live-tracking approach as the main Script view's own copy of this
	 *  effect (script-view.tsx): re-measure the icon's rect on every scroll
	 *  and follow it, closing if the icon can no longer be found. Only one of
	 *  the Scene/Act sections is ever mounted at a time, so trying every
	 *  container is safe — exactly the "chain of ??" pattern
	 *  `handleCreateComment` above already uses. */
	useEffect(() => {
		if (!openComment) return;
		const id = openComment.id;
		const containers = [sceneScriptEditorWrapRef.current, sceneScriptPagesRef.current, actScriptPagesRef.current].filter(
			(c): c is HTMLDivElement => c !== null
		);
		const track = () => {
			let icon: Element | null = null;
			let container: HTMLDivElement | null = null;
			for (const c of containers) {
				const found = c.querySelector(`[data-loom-annotation-id="${id}"]`);
				if (found) {
					icon = found;
					container = c;
					break;
				}
			}
			if (!(icon instanceof HTMLElement)) {
				setOpenComment(null);
				return;
			}
			// The icon can still be IN THE DOM (passing the check above) while
			// scrolled fully outside its own container's visible viewport — see
			// script-view.tsx's own copy of this effect for why that matters:
			// repositioning the popover to that clamped spot overlapped the tabs/
			// search bar above the editor instead of tracking the actual text.
			const rect = icon.getBoundingClientRect();
			if (container) {
				const containerRect = container.getBoundingClientRect();
				if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) {
					setOpenComment(null);
					return;
				}
			}
			setOpenComment((prev) => (prev && prev.id === id ? { id, rect } : prev));
		};
		document.addEventListener('scroll', track, true);
		return () => document.removeEventListener('scroll', track, true);
	}, [openComment?.id]);
	/** Same collapsible nav panel as the main Script view, scoped to just this
	 *  scene's/act's own bounded tree — rendered INSIDE the editor box
	 *  (`.loom-script-nav-sticky-inset` in styles.css), not stacked above it,
	 *  so it lives in the box's own spare left margin instead of colliding
	 *  with the scene-heading caption. */
	const [sceneNavOpen, setSceneNavOpen] = useState(false);
	const [actNavOpen, setActNavOpen] = useState(false);
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
		if (!actNavOpen) return;
		const onDown = (e: MouseEvent) => {
			const el = e.target as HTMLElement | null;
			if (el?.closest('.loom-script-nav, .loom-script-nav-toggle')) return;
			setActNavOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [actNavOpen]);

	// `scriptText` is in the dependency list for the same reason the main
	// Script view's identical effect needs `text`: on the initial-open restore
	// (the ref seeded straight from `localStorage` above, not from a mode
	// switch), this can fire before `scriptText` — and so `sceneExcerpt` and
	// the `FountainField` mounted from it — has actually loaded; guarding on
	// the ref instead of unconditionally clearing it lets the effect retry
	// once `scriptText` arrives, rather than silently dropping the restore.
	useEffect(() => {
		if (sceneScriptMode !== 'script') return;
		const line = pendingSceneScrollLineRef.current;
		if (line === null) return;
		const field = sceneScriptEditorRef.current;
		if (!field) return;
		pendingSceneScrollLineRef.current = null;
		field.scrollToLine(line);
	}, [sceneScriptMode, scriptText]);

	// Same reasoning as the scene effect just above, `bookText` in place of
	// `scriptText` — the "Open this chapter" right-click action (Book/Act's
	// own Preview) navigates here having already seeded
	// `pendingChapterScrollLineRef` from `localStorage`.
	useEffect(() => {
		if (chapterEditorMode !== 'editor') return;
		const offset = pendingChapterScrollLineRef.current;
		if (offset === null) return;
		const field = chapterEditorRef.current;
		if (!field) return;
		pendingChapterScrollLineRef.current = null;
		field.scrollToPos(offset);
	}, [chapterEditorMode, bookText]);

	/** Same idea as `pendingSceneScrollLineRef` just above, for the Comments/
	 *  Alternatives browser panels' own "jump to this text" action
	 *  (script-view.tsx's own copy of this pattern) — needs a real
	 *  SELECTION, not just a scroll position. Scene-only: Act has no live
	 *  field to select into any more (see `jumpToActAnnotation`, which opens
	 *  the popover/highlights the icon directly in Pages instead). */
	const pendingSceneSelectRangeRef = useRef<{ from: number; to: number } | null>(null);
	useEffect(() => {
		if (sceneScriptMode !== 'script') return;
		const range = pendingSceneSelectRangeRef.current;
		if (!range) return;
		pendingSceneSelectRangeRef.current = null;
		sceneScriptEditorRef.current?.selectRange(range.from, range.to);
	}, [sceneScriptMode]);

	// Persists the Scene/Act pane memory above — separate from the read,
	// which only needs to happen once (the lazy `useState` initializers),
	// while these need to re-fire on every later switch.
	useEffect(() => {
		if (!record) return;
		window.localStorage.setItem(`loom-scene-script-mode:${record.path}`, sceneScriptMode);
	}, [record?.path, sceneScriptMode]);
	useEffect(() => {
		if (!record) return;
		window.localStorage.setItem(`loom-act-script-mode:${record.path}`, actScriptMode);
	}, [record?.path, actScriptMode]);

	/** Comments/Alternatives browser panels — same overlaid side-panel slot as
	 *  the nav toggle, one independent pair per Act/Scene section (only
	 *  one of the two sections is ever mounted at a time, but each keeps its
	 *  own state rather than sharing script-view.tsx's single `openSidePanel`,
	 *  since nothing here forces the two sections' panels to be mutually
	 *  exclusive with each other the way Script/Pages/Outline already are). */
	const [sceneCommentsPanelOpen, setSceneCommentsPanelOpen] = useState(false);
	const [sceneAltPanelOpen, setSceneAltPanelOpen] = useState(false);
	const openSceneSidePanel = (panel: 'nav' | 'comments' | 'alt' | null) => {
		setSceneNavOpen(panel === 'nav');
		setSceneCommentsPanelOpen(panel === 'comments');
		setSceneAltPanelOpen(panel === 'alt');
	};
	const [actCommentsPanelOpen, setActCommentsPanelOpen] = useState(false);
	const [actAltPanelOpen, setActAltPanelOpen] = useState(false);
	const openActSidePanel = (panel: 'nav' | 'comments' | 'alt' | null) => {
		setActNavOpen(panel === 'nav');
		setActCommentsPanelOpen(panel === 'comments');
		setActAltPanelOpen(panel === 'alt');
	};
	useEffect(() => {
		if (!sceneCommentsPanelOpen && !sceneAltPanelOpen) return;
		const onDown = (e: MouseEvent) => {
			const el = e.target as HTMLElement | null;
			if (el?.closest('.loom-script-nav, .loom-script-nav-toggle, .loom-script-side-toggles')) return;
			openSceneSidePanel(null);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [sceneCommentsPanelOpen, sceneAltPanelOpen]);
	useEffect(() => {
		if (!actCommentsPanelOpen && !actAltPanelOpen) return;
		const onDown = (e: MouseEvent) => {
			const el = e.target as HTMLElement | null;
			if (el?.closest('.loom-script-nav, .loom-script-nav-toggle, .loom-script-side-toggles')) return;
			openActSidePanel(null);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [actCommentsPanelOpen, actAltPanelOpen]);

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
	/** Acts: the title emitted into the exported script. */
	const [displayTitle, setDisplayTitle] = useState(record?.displayTitle ?? '');
	/** Scenes: step 2 of "move to another act" — the act picked in step
	 *  1, whose scene list is then shown for drag placement. Null = step 1
	 *  (just the act picker). */
	const [moveTargetAct, setMoveTargetAct] = useState<EntityRecord | null>(null);
	/** Step 2's pending drop position among the target act's scenes (index
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
	/** Events (GM projects): the "+ Add a condition" builder — OR'd groups of
	 *  AND'd conditions, each a `{ type, target }` linkpath pick. */
	const [specialConditions, setSpecialConditions] = useState<SpecialConditionGroup[]>(
		record?.specialConditions ?? []
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
		setSpecialConditions(record.specialConditions);
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
	const linkNames = useMemo(
		() => (project ? buildEntityLinkNames(plugin, project) : []),
		[plugin, project, version]
	);
	const linkLabels = useMemo(
		() => (project ? buildLinkTargetLabels(plugin, project) : new Map<string, string>()),
		[plugin, project, version]
	);

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
	const saveDescription = useDebouncedFrontmatterField(plugin, file, FM.description, 'description');

	// Reward supports markdown (links, multiple lines); commits on idle like the
	// description field.
	const saveReward = useDebouncedFrontmatterField(plugin, file, FM.reward, 'reward');

	/** Opens a wikilink target from the markdown fields: loom entities get
	 *  their entity page, anything else Obsidian's normal link opening. */
	const openLinkTarget = (target: string, newTab = false) => {
		if (!record) return;
		openEntityLink(plugin, view, record.path, target, newTab);
	};

	/** Act's own Preview's right-click "Open this chapter" (`ActChapterBlocks`'s
	 *  `onOpenChapter`, via `MarkdownField`'s own contextmenu handler) —
	 *  `Book`'s own `openThisChapter` (book-view.tsx), shared rather than
	 *  duplicated a second time (found byte-identical to a copy that used to
	 *  live here). */
	const openThisChapterFromAct = (chapterId: string, offset: number) =>
		openThisChapter(plugin, project, view, chapterId, offset);

	/** "+ Create …" from a [[ completion: type picker → creation modal with
	 *  the short name prefilled; the finished entity links back in place. */
	const createLinkEntity = (entered: string, insert: (linkInsert: string) => void) => {
		if (!project) return;
		openCreateLinkEntity(plugin, project, entered, insert);
	};

	if (!file || !record) {
		return (
			<div className="loom-entity loom-empty">
				<p>{t('view.entity.notEntity.loading')}</p>
				<button onClick={() => view.navigateTo('markdown', { file: file?.path })}>{t('view.entity.notEntity.openAsMarkdown')}</button>
			</div>
		);
	}

	// The page shell is role-based: `isSession` means "this is the project's
	// chronological anchor" (a Session, or an Act in a writer project), and
	// the parts that really are session-only (dates, attendance) gate on the
	// kind's features instead.
	const anchorType = projectRoleType(project?.config, 'anchor');
	const beatType = projectRoleType(project?.config, 'beat');
	const anchorLabel = entityLabel(anchorType).toLowerCase();
	const beatLabel = entityLabel(beatType).toLowerCase();
	const kindFeatures = features(project?.config);
	/** Writer/Script: the writing lives in the script, not in note fields. */
	const scriptMode = kindFeatures.script;
	/** Writer/Prose: the writing lives in the Book, not in note fields. */
	const bookMode = kindFeatures.book;
	/** Writer, either sub-mode — both resolve quests against their beat type
	 *  (Scene/Chapter) rather than directly against the anchor (Act), unlike
	 *  Player/GM (Session). See `questAnchorRole` below. */
	const isWriterProject = kindFeatures.script || kindFeatures.book;
	/** True for BOTH Writer sub-modes (Script's Acts and Prose's Chapters are
	 *  both manually ordered, `loomSeq`, not dated) — distinct from
	 *  `scriptMode`, which is Script-only. Chronology math (quest resolution
	 *  position, anchor numbering) should key off this, not `scriptMode` —
	 *  a Chapter has no date to fall back to, so using `scriptMode` there
	 *  would silently misorder/misresolve everything against Prose. */
	const seqOrdered = kindFeatures.anchorOrder === 'sequence';
	/** Named by the script rather than here — see the Name field. */
	const scriptNamed =
		scriptMode && (record.type === 'act' ? record.actId !== '' : record.sceneId !== '');
	/** Named by the Book rather than here, Prose's own counterpart to
	 *  `scriptNamed` — an Act/Chapter note IS its stretch of the
	 *  `.loomprose` file the same way a Scene/Act note is its stretch of the
	 *  script. */
	const bookNamed =
		bookMode &&
		(record.type === 'act' ? record.actId !== '' : record.type === 'chapter' ? record.chapterId !== '' : false);
	const sceneActRecord =
		record.sceneAct !== '' ? plugin.indexer.resolve(record.sceneAct, record.path) : null;
	const chapterActRecord =
		record.type === 'chapter' && record.chapterAct !== ''
			? plugin.indexer.resolve(record.chapterAct, record.path)
			: null;
	/** This chapter's own stretch of the Book — heading-stripped, mirrors
	 *  `sceneExcerpt`. Null while the Book/heading doesn't exist yet (an
	 *  orphan, or before the first sync has run). */
	const chapterExcerpt =
		record.type === 'chapter' && bookText !== null && record.chapterId !== ''
			? chapterBookText(bookText, record.chapterId)
			: null;
	/** Chapter's own browse-all panel row data — same shared
	 *  `unresolvedCommentRows`/`undecidedAltRows` (script-notes.ts) Book uses,
	 *  scoped to just `chapterExcerpt` (see `chapterSidePanel`'s own doc
	 *  comment for why that scope, not the whole book). */
	const chapterUnresolvedCommentRowsList =
		chapterExcerpt !== null ? unresolvedCommentRows(chapterExcerpt, bookAnnotations.comments) : [];
	const chapterUndecidedAltRowsList =
		chapterExcerpt !== null ? undecidedAltRows(chapterExcerpt, bookAnnotations.altText) : [];
	/** Always lands in Preview before scrolling — mirrors `Book`'s own
	 *  `jumpToAnnotation` exactly (force the reading surface, not
	 *  `MarkdownFieldHandle`'s narrower `scrollToPos`-only API, which has no
	 *  selection/range concept the way Scene's live `FountainField` does). */
	const jumpToChapterAnnotation = (span: AnnotationSpan) => {
		setChapterSidePanel(null);
		setChapterEditorMode('preview');
		window.requestAnimationFrame(() => {
			const el = chapterPreviewWrapRef.current?.querySelector(`[data-loom-annotation-content="${span.id}"]`);
			if (!(el instanceof HTMLElement)) return;
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			if (span.kind === 'comment') bookAnnotations.handleOpenComment(span.id, el.getBoundingClientRect());
		});
	};
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
	/** Book-recognized cast/factions/items/mentioned-locations — `loomChapterCast`
	 *  etc., derived from a plain `[[...]]` wikilink anywhere in the chapter's
	 *  own text by `syncActsChapters`, shown read-only (same "the writing
	 *  itself is the source" reasoning as `sceneCastRecords`, just reading
	 *  Prose's native wikilink syntax instead of Fountain's `@[...]`). */
	const chapterCastRecords = record.chapterCast
		.map((lp) => plugin.indexer.resolve(lp, record.path))
		.filter((r): r is EntityRecord => r != null);
	const chapterFactionRecords = record.chapterFactions
		.map((lp) => plugin.indexer.resolve(lp, record.path))
		.filter((r): r is EntityRecord => r != null);
	const chapterItemRecords = record.chapterItems
		.map((lp) => plugin.indexer.resolve(lp, record.path))
		.filter((r): r is EntityRecord => r != null);
	const chapterMentionedLocationRecords = record.chapterMentionedLocations
		.map((lp) => plugin.indexer.resolve(lp, record.path))
		.filter((r): r is EntityRecord => r != null);
	const sceneExcerpt = sceneScriptText(scriptText, record.sceneId);
	/** This scene's own mini nav panel: whatever `##`+ (branch or ordinary)
	 *  sections exist inside its own line span, using the exact same
	 *  algorithm as the main Script view's nav tree (`buildNavTree`), just
	 *  bounded to this one scene instead of the whole document. */
	const sceneNavScene = scriptParsed?.scenes.find((s) => s.loomId === record.sceneId) ?? null;
	// Built FROM the scene's own heading line (`sceneOwnTree` unwraps that
	// single 'scene' item back out) rather than excluding it — a branch
	// section right under the heading needs `buildNavTree` to have seen the
	// scene item first, or it can't group under its `DP-xx` identifier.
	const sceneNavTree =
		scriptParsed && sceneNavScene
			? sceneOwnTree(scriptParsed, sceneNavScene.line, sceneEndLine(scriptParsed, sceneNavScene))
			: null;
	// The heading line is the script's, not the note's — only what follows it is
	// editable here, so the title and its hidden id can't be typed over.
	// Leading blanks skipped via `computeSceneBodyLineOffset` (shared with the
	// excerpt-to-whole-document line math everywhere else in this component)
	// rather than a bare `.trim()` — trimming the WHOLE joined string would
	// also eat TRAILING blanks, which `sceneScriptText` already strips before
	// this ever runs in the normal (read-from-disk) path, so this changes
	// nothing there; it matters for `handlePasteBranchGroupInScene`'s own
	// direct, untrimmed injection (`replaceBody`), which deliberately keeps
	// trailing blank lines a `.trim()` here would otherwise erase again.
	const sceneBodyOf = (excerpt: string) => excerpt.split('\n').slice(computeSceneBodyLineOffset(excerpt)).join('\n');
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
	const sceneBodyLineOffset = sceneExcerpt !== null ? computeSceneBodyLineOffset(sceneExcerpt) : 0;
	/** A fresh, EXCERPT-relative parse — `sceneNavTree` above uses `scriptParsed`
	 *  (absolute line numbers), which don't line up with `sceneBodyPages`
	 *  (paginated from `sceneExcerpt` alone, line 0 = the scene's own heading).
	 *  The Outline tab needs both a nav tree AND page ranges built from the
	 *  SAME numbering, so it gets its own tree from this parse instead of
	 *  reusing `sceneNavTree`. */
	const sceneExcerptParsed = sceneExcerpt !== null ? parseFountain(sceneExcerpt) : null;
	// Line 0 of the excerpt IS the scene's own heading — built from there
	// (not line 1) via `sceneOwnTree` for the same reason `sceneNavTree`
	// above now is: a branch section needs `buildNavTree` to see the scene
	// item first to group under its decision-point identifier.
	const sceneOutlineTree = sceneExcerptParsed ? sceneOwnTree(sceneExcerptParsed, 0, Infinity) : null;
	/** A branch/section's own page range, same idea as `actScenePageRange`
	 *  — its block is `[section.line, nextSectionAtLevel)`, at whatever level
	 *  it's nested to, since a branch can sit at any depth. */
	const sceneOutlinePageRange = (node: NavNode): string => {
		if (!sceneExcerptParsed) return '—';
		const section = sceneExcerptParsed.sections.find((s) => s.line === node.line);
		if (!section) return '—';
		const end = nextSectionAtLevel(sceneExcerptParsed, section.line, section.level) ?? Infinity;
		const hits: number[] = [];
		sceneBodyPages.forEach((els, i) => {
			if (els.some((el) => el.line >= section.line && el.line < end)) hits.push(i + 1);
		});
		if (hits.length === 0) return '—';
		const first = hits[0];
		const last = hits[hits.length - 1];
		return first === last ? String(first) : `${first}–${last}`;
	};
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
	/** Act page's own Script section — same shape as the Scene page's
	 *  `sceneExcerpt`/`sceneDraft`/`sceneBodyPages`, but spanning every scene
	 *  under this act rather than one heading's worth. The `#` section
	 *  line is stripped from the editable body the same way a scene's heading
	 *  is — the Act page's own Title field is where that line's text is
	 *  actually edited, so the Script section doesn't show a rival copy. */
	const actExcerpt = record.type === 'act' ? actScriptText(scriptText, record.actId) : null;
	/** This act's own nav panel — every scene/branch/sub-section between
	 *  its `#` line and the next top-level one, same `buildNavTree` bounded
	 *  call the Scene page's mini nav uses. */
	const actNavSection =
		record.type === 'act' && scriptParsed
			? (scriptParsed.sections.find((s) => s.level === 1 && s.loomId === record.actId) ?? null)
			: null;
	const actNavTree =
		scriptParsed && actNavSection
			? buildNavTree(
					scriptParsed,
					actNavSection.line + 1,
					nextTopSectionLine(scriptParsed, actNavSection.line) ?? Infinity
				)
			: null;
	const actBodyOf = (excerpt: string) => excerpt.split('\n').slice(1).join('\n').trim();
	const actDraft = actExcerpt === null ? '' : actBodyOf(actExcerpt);
	const actBodyPages = actExcerpt !== null ? pdfPages(parseFountain(actExcerpt)) : [];
	/** Re-parsed straight from the excerpt (its own line numbers, not the whole
	 *  script's), so a scene's page range can be read the same way the main
	 *  Script view's Outline reads `scenePages` — `actScenes[i]` and
	 *  `actExcerptParsed.scenes[i]` line up 1:1 in document order, same
	 *  `seq`-sorted order `syncScenes` already guarantees between the two. */
	const actExcerptParsed = actExcerpt !== null ? parseFountain(actExcerpt) : null;
	const actScenePageRange = (index: number): string => {
		if (!actExcerptParsed) return '—';
		const scene = actExcerptParsed.scenes[index];
		if (!scene) return '—';
		const end = sceneEndLine(actExcerptParsed, scene);
		const hits: number[] = [];
		actBodyPages.forEach((els, i) => {
			if (els.some((el) => el.line >= scene.line && el.line < end)) hits.push(i + 1);
		});
		if (hits.length === 0) return '—';
		const first = hits[0];
		const last = hits[hits.length - 1];
		return first === last ? String(first) : `${first}–${last}`;
	};
	/** Act pages: the scenes pointing at this act, in script order. */
	const actScenes = plugin.indexer
		.getAll('scene', record.project)
		.filter((sc) => sc.sceneAct !== '' && plugin.indexer.resolve(sc.sceneAct, sc.path)?.path === record.path)
		.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));
	/** Prose Act page: the chapters pointing at this act, in book order —
	 *  mirrors `actScenes` above. */
	const actChapters = plugin.indexer
		.getAll('chapter', record.project)
		.filter((c) => c.chapterAct !== '' && plugin.indexer.resolve(c.chapterAct, c.path)?.path === record.path)
		.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created));
	/** Act's own browse-all panel row data — computed PER CHAPTER (each via
	 *  its own `chapterBookText` slice, the same text `ActChapterBlocks`
	 *  itself renders from) and concatenated, rather than run once over the
	 *  whole book: this scopes the panel to just this act's own chapters,
	 *  and avoids feeding `unresolvedCommentRows`/`undecidedAltRows` a
	 *  synthetic concatenation of unrelated chapters' text (their own
	 *  `excerpt` field slices a context window around each match, which
	 *  only makes sense within one real chapter's own prose). Ids are
	 *  globally unique, so concatenating the RESULT lists is safe even
	 *  though each call only sees one chapter's own text. */
	const actChapterExcerpts =
		bookText !== null
			? (() => {
					const book = bookText;
					return actChapters
						.map((ch) => (ch.chapterId !== '' ? chapterBookText(book, ch.chapterId) : null))
						.filter((excerpt): excerpt is string => excerpt !== null);
				})()
			: [];
	const actUnresolvedCommentRowsList = actChapterExcerpts.flatMap((excerpt) =>
		unresolvedCommentRows(excerpt, bookAnnotations.comments)
	);
	const actUndecidedAltRowsList = actChapterExcerpts.flatMap((excerpt) =>
		undecidedAltRows(excerpt, bookAnnotations.altText)
	);
	/** Always lands in Preview before scrolling — mirrors `Book`'s own
	 *  `jumpToAnnotation`/Chapter's own `jumpToChapterAnnotation` exactly. */
	const jumpToActBookAnnotation = (span: AnnotationSpan) => {
		setActBookSidePanel(null);
		setActBookMode('preview');
		window.requestAnimationFrame(() => {
			const el = actBookPreviewWrapRef.current?.querySelector(`[data-loom-annotation-content="${span.id}"]`);
			if (!(el instanceof HTMLElement)) return;
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			if (span.kind === 'comment') bookAnnotations.handleOpenComment(span.id, el.getBoundingClientRect());
		});
	};
	const isSession = roleOf(record.type) === 'anchor';
	const isBeat = roleOf(record.type) === 'beat';
	const vocab = ENTITY_TAGS[record.type];
	const allTags = [...new Set([...vocab, ...record.loomTags])];
	const sessions = project ? plugin.indexer.getAll(anchorType, project.root) : [];
	const targetRecords = project
		? plugin.indexer.getAll(undefined, project.root).filter((r) => r.type !== 'decisionPoint')
		: [];

	// This anchor's chronological number: its 1-based position among all the
	// project's anchors — sessions ordered by date, acts by their manual
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
				new Notice(t('view.entity.common.saveFailed'));
			});
	};

	/** Renames the file to its managed name and stores the entered display
	 *  name (`loomName` + a native alias so [[…]] autocomplete finds it).
	 *
	 *  Guarded against re-entrant calls (`commitNameInFlightRef`): the Name
	 *  input commits on BOTH Enter (below) and blur, and pressing Enter then
	 *  clicking/tabbing away fires both in quick succession — a real,
	 *  reported bug for Chapter/Act (whose commit cascades into
	 *  `editBookAndSync` → `syncActsChapters`, itself several awaited
	 *  `processFrontMatter`/`renameFile` calls across multiple notes): two
	 *  unqueued, concurrent runs of that cascade could race on the SAME
	 *  files — one run's `renameFile` landing while the other's own
	 *  `existingChapters` snapshot (read once at that run's own start) still
	 *  pointed at the pre-rename path, silently dropping that run's write
	 *  and leaving the title looking reverted once the dust settled. */
	const commitName = async () => {
		if (commitNameInFlightRef.current) return;
		const entered = name.trim();
		if (entered === '' || entered === record.name || !project) {
			setName(record.name);
			return;
		}
		commitNameInFlightRef.current = true;
		try {
			// A Chapter's title is Book-owned once a Book exists, same reasoning as
			// an Act's — write the `##` heading and let `syncActsChapters` rename
			// the note, rather than racing a direct frontmatter rename against it.
			if (record.type === 'chapter' && bookMode) {
				await editBookAndSync(plugin, project, (raw) => renameBookChapterTitle(raw, record.chapterId, entered));
				return;
			}
			// Checked BEFORE the frontmatter write below, not after: a collision
			// must abort the rename entirely, never leave the note's displayed
			// name changed while its file name silently stays behind.
			const parentName =
				record.type === 'location' && record.parentLocation !== null
					? plugin.indexer.resolve(record.parentLocation, record.path)?.name
					: undefined;
			const base = entityFileName(project, record.type, entered, parentName);
			const parent = file.parent?.path ?? '';
			const newPath = normalizePath(parent === '' ? `${base}.md` : `${parent}/${base}.md`);
			if (newPath !== file.path && plugin.app.vault.getAbstractFileByPath(newPath)) {
				new Notice(t('project.common.nameExists'));
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
			if (newPath === file.path) return;
			await plugin.app.fileManager.renameFile(file, newPath);
		} finally {
			commitNameInFlightRef.current = false;
		}
	};

	/** Act page's Title field: writes straight into the script's `#`
	 *  section line — the note itself is updated by the sync that follows,
	 *  not directly here, so the script stays the one place that authors it.
	 *  Guarded by the SAME `commitNameInFlightRef` as `commitName` — the
	 *  Name input's Enter/blur handlers call whichever of the two applies,
	 *  never both, so sharing one flag is safe and avoids a second ref for
	 *  the identical race. */
	const commitActTitle = async () => {
		if (commitNameInFlightRef.current) return;
		const entered = name.trim();
		if (entered === '' || entered === record.name || !project || record.type !== 'act') {
			setName(record.name);
			return;
		}
		commitNameInFlightRef.current = true;
		try {
			if (bookMode) {
				await editBookAndSync(plugin, project, (raw) => renameBookActTitle(raw, record.actId, entered));
				return;
			}
			await editScriptAndSync(plugin, project, (raw) => renameSectionTitle(raw, record.actId, entered));
		} finally {
			commitNameInFlightRef.current = false;
		}
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
			// Native-graph link to the day's daily note — see `FM.dailyNote`'s
			// own doc comment; re-derived on every date edit, not just at
			// creation, so it never points at the wrong day after a change.
			if (record.type === 'session') {
				const link = value !== '' ? dailyNoteLink(plugin.app, value) : null;
				setLoomKey(fm, FM.dailyNote, link ?? '');
			}
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
		if (project) void pushActTitles(plugin, project);
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
					t('view.entity.scene.renameConfirmTitle', { name: current.name, newName: name }),
					kind === 'sublocation'
						? t('view.entity.scene.renameSublocationDetail')
						: t('view.entity.scene.renameLocationDetail'),
					t('view.list.rename')
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
							t('view.entity.scene.renameConfirmTitle', { name: currentSub.name, newName: subName }),
							t('view.entity.scene.renameSublocationDetail'),
							t('view.list.rename')
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
				t('view.entity.scene.deleteSublocationTitle', { name: subName }),
				t('view.entity.scene.deleteSublocationDetail'),
				t('project.common.delete')
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
	const objRowStyle = (i: number): CSSProperties | undefined => {
		if (!objDrag) return undefined;
		const slot = objDragRef.current?.slot ?? 40;
		if (objDrag.from === i)
			return { transform: `translateY(${objDrag.dy}px)`, position: 'relative', zIndex: 2 };
		const { from, over } = objDrag;
		let sh = 0;
		if (from < i && i <= over) sh = -1;
		else if (over <= i && i < from) sh = 1;
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
	// A quest resolves against whatever unit play/writing actually happens
	// in: Sessions in a Player/GM project (acts/chapters have no date or
	// single sitting of their own) — but a Scene in Writer/Script or a
	// Chapter in Writer/Prose, both of which resolve against their beat
	// type rather than the anchor, unlike Player/GM. `questAnchorRole` is
	// what a resolved link must be to count as valid.
	const questAnchorType = isWriterProject ? beatType : anchorType;
	const questAnchorRole = isWriterProject ? 'beat' : 'anchor';
	const questAnchorsSorted = (project ? plugin.indexer.getAll(questAnchorType, project.root) : [])
		.slice()
		.sort((a, b) =>
			seqOrdered ? (a.seq ?? a.created) - (b.seq ?? b.created) : (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0)
		);
	const sessionChip = (s: EntityRecord, clear: () => void) => (
		<div className="loom-tag-row">
			<EntityChip
				plugin={plugin}
				record={s}
				label={recordLabel(s, project)}
				onOpen={() => view.openEntity(s.path)}
				onRemove={clear}
				removeLabel={t('view.entity.common.clearSession')}
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
					clearFmKeys(fm, 'loomparentlocation', 'parentlocation');
				});
				// Back to the top-level name (no parent).
				await renameLocationFile(s, undefined);
			} catch (e) {
				console.error('Loom Loom: failed to detach sublocation', e);
				new Notice(t('view.entity.location.detachFailed'));
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
	// A sublocation never owns its own `region` — it's inherited from
	// whichever main (top-level) location it ultimately sits under, walking
	// the `parentLocation` chain. `region` is only ever WRITTEN on a main
	// location's own frontmatter (both here and the creation modal) — never
	// on a sublocation's — which is also what keeps a sublocation from ever
	// drawing its own region graph edge (only location->region and
	// sublocation->location edges are wanted; see `FM.region`'s own doc
	// comment for the full reasoning).
	const isSublocationPage = isLocation && record.parentLocation !== null;
	const effectiveRegionOwner = (() => {
		if (!isLocation) return null;
		let cur: EntityRecord = record;
		const seen = new Set<string>([record.path]);
		for (let guard = 0; guard < 20 && cur.parentLocation !== null; guard++) {
			const parent = plugin.indexer.resolve(cur.parentLocation, cur.path);
			if (!parent || parent.type !== 'location' || seen.has(parent.path)) break;
			cur = parent;
			seen.add(parent.path);
		}
		return cur;
	})();
	const currentRegion =
		effectiveRegionOwner?.region && effectiveRegionOwner.region !== ''
			? plugin.indexer.resolve(effectiveRegionOwner.region, effectiveRegionOwner.path)
			: null;
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
			clearFmKeys(fm, 'loomregion', 'region');
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
		void (async () => {
			// A location just made via this field's own "+ Create new" action
			// isn't indexed yet the instant `onCreated` fires — Obsidian's
			// metadataCache re-parses a write on its own later tick, not
			// synchronously (see `waitForMetadataSync`'s doc comment). Resolve
			// immediately first (the common case: an already-existing pick,
			// where waiting would just be a pointless delay); only fall back to
			// waiting when that comes up empty.
			let rec = plugin.indexer.resolve(target, record.path);
			if (!rec) {
				const pending = plugin.app.metadataCache.getFirstLinkpathDest(target, record.path);
				if (!pending) return;
				await waitForMetadataSync(plugin.app, pending);
				rec = plugin.indexer.resolve(target, record.path);
				if (!rec) return;
			}
			const f = plugin.app.vault.getFileByPath(rec.path);
			if (!f) return;
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
			clearFmKeys(fm, 'loomregion', 'region');
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

	// --- Decision Points (GM projects): a grouping layer above events, --------
	// --- mirroring Regions above locations exactly. ---------------------------
	const isDecisionPoint = record.type === 'decisionPoint';
	const isEvent = record.type === 'event';
	// Decision points available to pick as an event's own field, GM projects only.
	const decisionPoints =
		isEvent && kindFeatures.eventPlanning && project ? plugin.indexer.getAll('decisionPoint', project.root) : [];
	const currentDecisionPoint =
		record.decisionPoint !== null ? plugin.indexer.resolve(record.decisionPoint, record.path) : null;
	/** Runs the lock evaluator over the whole project. `justWritten`, when
	 *  given, is awaited via `waitForMetadataSync` first — the ONE record at
	 *  risk of being stale is whichever file a caller just wrote, so
	 *  targeting that file specifically is both correct AND cheap (no
	 *  project-wide rescan the way `rebuildNow` would be, which doesn't even
	 *  fix the staleness — it just re-reads metadataCache exactly as it
	 *  currently stands, same race). Called after any edit that can affect
	 *  an event's lock state; a no-op outside GM projects. */
	const triggerEventLockRecompute = (justWritten?: TFile | null) => {
		if (!project || !kindFeatures.eventPlanning) return;
		void (async () => {
			if (justWritten) await waitForMetadataSync(plugin.app, justWritten);
			await recomputeEventLocks(plugin.app, plugin.indexer, project.root);
		})();
	};
	/** Awaitable sibling of `writeFm` — same target file, same error handling,
	 *  just exposes the write's completion so a lock recompute can be chained
	 *  after it lands rather than firing on a stale index. */
	const writeFmAwait = async (apply: (fm: Record<string, unknown>) => void) => {
		if (!file) return;
		try {
			await plugin.app.fileManager.processFrontMatter(file, apply);
		} catch (e) {
			console.error('Loom Loom: failed to update frontmatter', e);
			new Notice(t('view.entity.common.saveFailed'));
		}
	};
	const setEventDecisionPoint = (target: string | null) => {
		void (async () => {
			if (target === null) {
				await writeFmAwait((fm) => clearFmKeys(fm, 'loomdecisionpoint', 'decisionpoint'));
				triggerEventLockRecompute(file);
				return;
			}
			// Same fast-path-then-wait resolve as `addDecisionPointEvent` — a
			// Decision Point just made via this field's own "+ Create new"
			// action isn't indexed yet the instant `onCreated` fires.
			let dp = plugin.indexer.resolve(target, record.path);
			if (!dp) {
				const pending = plugin.app.metadataCache.getFirstLinkpathDest(target, record.path);
				if (!pending) return;
				await waitForMetadataSync(plugin.app, pending);
				dp = plugin.indexer.resolve(target, record.path);
				if (!dp) return;
			}
			// A brand-new Decision Point has no session of its own yet, so this
			// always auto-adopts THIS event's session with no conflict (see
			// `reconcileSessionBeforeLink`) — the same call handles "picked an
			// existing Decision Point" and "just created one" identically.
			if (project) {
				const conflict = await reconcileSessionBeforeLink(plugin.app, plugin.indexer, dp, record);
				if (conflict) {
					const linked = await new SessionConflictModal(plugin.app, conflict, plugin, project).openAndWait();
					if (!linked) return;
				}
			}
			await writeFmAwait((fm) => setLoomKey(fm, FM.decisionPoint, `[[${target}]]`));
			triggerEventLockRecompute(file);
		})();
	};
	// Decision Point page: its own session — a direct link, not a full
	// `sessionNotes` array (see `FM.decisionPointSession`'s doc comment).
	// Changing it cascades onto every member event's own session.
	const currentDpSession =
		record.decisionPointSession !== null ? plugin.indexer.resolve(record.decisionPointSession, record.path) : null;
	const setDecisionPointSession = (target: string | null) => {
		void (async () => {
			const ok = await cascadeDecisionPointSession(plugin.app, plugin.indexer, record, target);
			if (!ok) new Notice(t('view.entity.common.saveFailed'));
		})();
	};
	// Decision Point page: its member events, ordered by `decisionPointOrder`.
	const decisionPointEvents = (() => {
		if (!isDecisionPoint || !project) return [];
		const orderIdx = new Map<string, number>(
			record.decisionPointOrder
				.map((lp, i) => [plugin.indexer.resolve(lp, record.path)?.path, i] as const)
				.filter((e): e is [string, number] => e[0] !== undefined)
		);
		return plugin.indexer
			.getAll('event', project.root)
			.filter((e) => e.decisionPoint !== null && plugin.indexer.resolve(e.decisionPoint, e.path)?.path === record.path)
			.sort(
				(a, b) =>
					(orderIdx.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
						(orderIdx.get(b.path) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)
			);
	})();
	const writeDecisionPointOrder = (ordered: EntityRecord[]) => {
		writeFm((fm) => setLoomKey(fm, FM.decisionPointOrder, ordered.map((s) => `[[${linkTargetOf(s)}]]`)));
	};
	/** Sets an event's decision point to this one (decision point page "Add event"). */
	const addDecisionPointEvent = (target: string) => {
		void (async () => {
			// Same fast-path-then-wait pattern as `addRegionLocation` above — an
			// event just made via this field's own "+ New event" action isn't
			// indexed yet the instant `onCreated` fires.
			let rec = plugin.indexer.resolve(target, record.path);
			if (!rec) {
				const pending = plugin.app.metadataCache.getFirstLinkpathDest(target, record.path);
				if (!pending) return;
				await waitForMetadataSync(plugin.app, pending);
				rec = plugin.indexer.resolve(target, record.path);
				if (!rec) return;
			}
			// A brand-new event has no session of its own yet, so this always
			// auto-adopts THIS decision point's session with no conflict (see
			// `reconcileSessionBeforeLink`) — the same call handles "picked an
			// existing event" and "just created one" identically.
			if (project) {
				const conflict = await reconcileSessionBeforeLink(plugin.app, plugin.indexer, record, rec);
				if (conflict) {
					const linked = await new SessionConflictModal(plugin.app, conflict, plugin, project).openAndWait();
					if (!linked) return;
				}
			}
			const f = plugin.app.vault.getFileByPath(rec.path);
			if (!f) return;
			try {
				await plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) =>
					setLoomKey(fm, FM.decisionPoint, `[[${linkTargetOf(record)}]]`)
				);
			} catch (e) {
				console.error('Loom Loom: failed to update frontmatter', e);
				new Notice(t('view.entity.common.saveFailed'));
				return;
			}
			writeDecisionPointOrder([...decisionPointEvents, rec]);
			triggerEventLockRecompute(f);
		})();
	};
	/** Removes an event from this decision point (clears its `decisionPoint`). */
	const removeDecisionPointEvent = (e: EntityRecord) => {
		const f = plugin.app.vault.getFileByPath(e.path);
		if (!f) return;
		void (async () => {
			await plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
				clearFmKeys(fm, 'loomdecisionpoint', 'decisionpoint');
			});
			writeDecisionPointOrder(decisionPointEvents.filter((o) => o.path !== e.path));
			triggerEventLockRecompute(f);
		})();
	};

	// Events (GM projects): status pill + Improvised tick. The pill only ever
	// writes `planned`/`happened`/`lore` directly — `locked` is written solely
	// by the lock-recompute pass (`recomputeEventLocks`, gm-lock.ts), never
	// picked here.
	const setEventStatus = (kind: EventKind) => {
		void (async () => {
			await writeFmAwait((fm) => setLoomKey(fm, FM.eventKind, kind));
			triggerEventLockRecompute(file);
		})();
	};
	const setImprovised = (v: boolean) => {
		writeFm((fm) => setLoomKey(fm, FM.improvised, v));
	};
	const commitSpecialConditions = (next: SpecialConditionGroup[]) => {
		setSpecialConditions(next);
		void (async () => {
			// Compute the new lock state synchronously, in memory, against the
			// EDITED conditions, and write it in the SAME transaction as the
			// edit itself — a real, reported bug this fixes: writing just the
			// conditions and leaving `eventKind`/`eventLockReasons` for the
			// later async `triggerEventLockRecompute` pass to catch up left the
			// event showing as still Locked for however long `waitForMetadataSync`
			// took to see its own write land (bounded, but not instant), which
			// read as "deleting a condition doesn't unlock the event." A frozen
			// (`happened`/`lore`) event is never touched here, matching
			// `recomputeEventLocks`'s own skip — its status doesn't reopen for
			// re-evaluation just because its conditions were edited afterward.
			const stillFrozen = record.eventKind === 'happened' || record.eventKind === 'lore';
			const result =
				!stillFrozen && project && kindFeatures.eventPlanning
					? evaluateEvent({ ...record, specialConditions: next }, plugin.indexer, project.root)
					: null;
			await writeFmAwait((fm) => {
				setLoomKey(
					fm,
					FM.specialConditions,
					next.map((g) => ({
						conditions: g.conditions.map((c) => ({
							type: c.type,
							target: c.target === '' ? '' : `[[${c.target}]]`,
						})),
					}))
				);
				if (result) {
					setLoomKey(fm, FM.eventKind, result.eventKind);
					setLoomKey(fm, FM.eventLockReasons, result.reasons);
				}
			});
			// Backstop only now — the write above already applied this event's
			// own new lock state, so this pass has nothing left to do for IT,
			// but still catches any knock-on effect on OTHER events (e.g. this
			// event just became the last one needed to unblock a sibling's own
			// `eventHappened` condition — never true here since editing
			// conditions can't change THIS event's own `happened` status, but
			// kept for the same defense-in-depth every other lock-affecting
			// write in this file already has).
			triggerEventLockRecompute(file);
		})();
	};
	/** Which entity type a condition's target search picks from. */
	const conditionTargetType = (type: SpecialConditionType): EntityType =>
		type === 'characterAlive'
			? 'character'
			: type === 'groupCarriesItem'
				? 'item'
				: type === 'eventHappened'
					? 'event'
					: 'decisionPoint';
	const conditionTypeLabel = (type: SpecialConditionType): string =>
		t(`view.entity.event.condition${type.charAt(0).toUpperCase()}${type.slice(1)}` as LocaleKey);
	/** The target-search list + placeholder for one condition row, scoped to
	 *  this project and excluding the event's own page as a target. */
	const conditionPickerFor = (type: SpecialConditionType): { list: EntityRecord[]; placeholder: string } => {
		const targetType = conditionTargetType(type);
		const list = project
			? plugin.indexer.getAll(targetType, project.root).filter((r) => r.path !== record.path)
			: [];
		const placeholderKey =
			targetType === 'character'
				? 'view.entity.event.pickCharacterPlaceholder'
				: targetType === 'item'
					? 'view.entity.event.pickItemPlaceholder'
					: targetType === 'event'
						? 'view.entity.event.pickEventPlaceholder'
						: 'view.entity.event.pickDecisionPointConditionPlaceholder';
		return { list, placeholder: t(placeholderKey) };
	};
	/** Opens the "+ Add a condition"/"+ Add an alternative set" type-pick menu. */
	const openConditionTypeMenu = (e: ReactMouseEvent, onPick: (type: SpecialConditionType) => void) => {
		const menu = new Menu();
		for (const type of SPECIAL_CONDITION_TYPES) {
			menu.addItem((item) => item.setTitle(conditionTypeLabel(type)).onClick(() => onPick(type)));
		}
		menu.showAtMouseEvent(e.nativeEvent);
	};
	/** Human-readable text for one `loomEventLockReasons` entry — resolves a
	 *  condition reason's target name fresh from the index rather than storing
	 *  display text, so a later character/item rename never leaves a stale
	 *  blocker label behind. */
	const lockReasonLabel = (reason: string): string => {
		if (reason === 'cascade') return t('view.entity.event.lockedReasonCascade');
		const m = /^condition:(\d+):(\d+)$/.exec(reason);
		if (!m) return reason;
		const cond: SpecialCondition | undefined = record.specialConditions[Number(m[1])]?.conditions[Number(m[2])];
		if (!cond) return t('view.entity.event.lockedReasonConditionPrefix');
		const targetRec = plugin.indexer.resolve(cond.target, record.path);
		return `${t('view.entity.event.lockedReasonConditionPrefix')} ${conditionTypeLabel(cond.type)} — ${targetRec?.name ?? cond.target}`;
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
			(l) => {
				const target = linkTargetOf(l);
				// Warn first if this location has a zone on the map — it gets deleted.
				void (async () => {
					const zoneExists = await locationHasZone();
					if (zoneExists) {
						new ConfirmModal(
							plugin.app,
							t('view.entity.location.turnIntoSublocationTitle'),
							t('view.entity.location.turnIntoSublocationDetail'),
							() => {
								void (async () => {
									await dropMapZonesForThisLocation();
									setParentLocation(target);
								})();
							},
							t('view.entity.location.turnIntoSublocationCta')
						).open();
					} else {
						setParentLocation(target);
					}
				})();
			},
			t('view.entity.location.pickParentPlaceholder')
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
				{newestFirst ? t('view.entity.events.newOnTop') : t('view.entity.events.newOnBottom')}
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
		// A GM "Group carries an item" condition reads a PC's own `loomItems`,
		// so any change here can flip which events are locked.
		const setItemLinks = (links: string[]) => {
			void (async () => {
				await writeFmAwait((fm) => setLoomKey(fm, FM.items, links));
				triggerEventLockRecompute(file);
			})();
		};
		const addItemLink = (linkTarget: string) => {
			if (currentItemLinks().includes(`[[${linkTarget}]]`)) return;
			setItemLinks([...currentItemLinks(), `[[${linkTarget}]]`]);
		};
		const removeItem = (item: EntityRecord) =>
			setItemLinks(itemRecords.filter((r) => r.path !== item.path).map((r) => `[[${linkTargetOf(r)}]]`));
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
				new Notice(t('view.entity.items.copyCreateFailed'));
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
			void (async () => {
				await plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
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
				// A GM "Group carries an item" condition reads a PC's own
				// `loomItems`, so a new holder can flip which events are locked.
				triggerEventLockRecompute(f);
			})();
		};
		const removeItemFromHolder = (holder: EntityRecord) => {
			const f = plugin.app.vault.getFileByPath(holder.path);
			if (!f) return;
			void (async () => {
				await plugin.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
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
				triggerEventLockRecompute(f);
			})();
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
					new Notice(t('view.entity.events.addFailed'));
				});
		};
		// A plain chip per item (2026-08-26, per user request — the old
		// always-expanded inline editor read like a session-note entry, not the
		// light chip list every other "entities on this page" section uses, e.g.
		// "Items in sublocations" just beneath this; a later request dropped
		// drag-reorder entirely too, so `loomItems`' own stored order is no
		// longer meaningful — `setItemLinks` still writes the list in whatever
		// order it's built, just never reordered by the user any more). Renaming
		// and description-editing moved from here to the item's own page (opened
		// via the chip itself). Right-click for Delete + — on a character page,
		// for a non-copy item — "Replace with a character specific copy"; the
		// chip's own ✕ already covers unlinking, so no separate "Remove" menu
		// item.
		const itemRow = (item: EntityRecord) => {
			// A character-specific copy's name is derived (original + owner), so
			// it can't be re-copied — the copy action is omitted for it.
			const rowIsCopy = item.itemOrigin !== null;
			const openItemMenu = (e: ReactMouseEvent) => {
				e.preventDefault();
				const menu = new Menu();
				if (record.type === 'character' && !rowIsCopy) {
					menu.addItem((mi) =>
						mi
							.setTitle(t('view.entity.items.replaceWithCopy'))
							.setIcon('layers-2')
							.onClick(() => void makeItemCopy(item))
					);
				}
				menu.addItem((mi) =>
					mi
						.setTitle(t('view.entity.items.deleteThisItem'))
						.setIcon('trash-2')
						.onClick(() =>
							new ConfirmModal(
								plugin.app,
								t('view.list.deleteConfirmTitle', { name: item.name }),
								t('view.list.deleteMessageGeneral'),
								() => {
									const f = plugin.app.vault.getFileByPath(item.path);
									if (!f) return;
									void purgeEntityReferences(plugin, item.path, item.project).finally(() =>
										plugin.app.fileManager.trashFile(f)
									);
								},
								t('project.common.delete')
							).open()
						)
				);
				menu.showAtMouseEvent(e.nativeEvent);
			};
			return (
				<span key={item.path} onContextMenu={openItemMenu}>
					<EntityChip
						plugin={plugin}
						record={item}
						onOpen={() => view.openEntity(item.path)}
						onRemove={() => removeItem(item)}
						removeLabel={t('view.entity.items.removeFromPage')}
					/>
				</span>
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
					(typeof obj?.role === 'string' ? obj.role : defaultMemberRole())
				).trim();
				const location =
					patch.location !== undefined
						? patch.location === null
							? ''
							: `[[${patch.location}]]`
						: typeof obj?.location === 'string'
							? obj.location
							: '';
				const roleIsDefault = role === '' || role === defaultMemberRole();
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
				new Notice(t('view.entity.common.orderSaveFailed'));
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
	/** Like `seqGrip`, but generic over a plain item count rather than
	 *  `EntityRecord[]` — the Scene page's Outline drags branch SECTIONS,
	 *  which have no backing entity to type against. Reuses the SAME
	 *  `seqDrag`/`seqDragRef` state (and so `seqRowStyle`, unchanged — it
	 *  never cared what the dragged items ARE, only their index), just
	 *  calling `onCommit(from, over)` directly instead of `endSeqDrag`'s
	 *  EntityRecord-shaped splice-and-callback. */
	const branchGrip = (group: string, i: number, length: number, onCommit: (from: number, over: number) => void) => (
		<span
			className="loom-subloc-grip"
			onPointerDown={(e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const rowEl = e.currentTarget.closest('[data-seq-row]');
				const row = rowEl instanceof HTMLElement ? rowEl : null;
				const rows = row?.parentElement
					? [...row.parentElement.querySelectorAll(':scope > [data-seq-row]')]
					: [];
				const mids = rows.map((r) => {
					const b = r.getBoundingClientRect();
					return b.top + b.height / 2;
				});
				seqDragRef.current = { startY: e.clientY, slot: (row?.offsetHeight ?? 34) + 8, mids };
				setSeqDrag({ group, from: i, over: i, dy: 0 });
			}}
			onPointerMove={(e) => {
				const start = seqDragRef.current;
				if (!start) return;
				const dy = e.clientY - start.startY;
				const over = Math.max(0, Math.min(length - 1, start.mids.filter((m) => m < e.clientY).length));
				setSeqDrag((cur) =>
					cur && cur.group === group && (cur.over !== over || cur.dy !== dy) ? { ...cur, over, dy } : cur
				);
			}}
			onPointerUp={() => {
				const drag = seqDrag;
				seqDragRef.current = null;
				setSeqDrag(null);
				if (drag && drag.group === group && drag.from !== drag.over) onCommit(drag.from, drag.over);
			}}
			onPointerCancel={() => {
				seqDragRef.current = null;
				setSeqDrag(null);
			}}
		>
			<Icon name="grip-vertical" />
		</span>
	);
	/**
	 * The Scene page's own Outline: this scene's branch structure
	 * (`sceneOutlineTree`, bounded to just this scene's line span and
	 * numbered against `sceneExcerptParsed` so `sceneOutlinePageRange` lines
	 * up), rendered with the SAME row shape the Script view's and Act
	 * page's own Outlines use (`.loom-writer-outline-row` grip/caret placeholder
	 * + num placeholder + title + dashed leader + page-range count, each row
	 * wrapped in a `.loom-writer-outline-act`-shaped box so children hang
	 * off the shared `.loom-writer-outline-children` nesting rail) rather than
	 * the read-only nav panel's plain `loom-script-nav-branchpoint` labels.
	 * Only a `branchPoint`'s own children — the branches sharing that ONE
	 * decision point's identifier — are draggable (`reorderBranchGroup`,
	 * scoped to that identifier so a branch can never land under a different
	 * one); the decision point's own header row and a plain untagged nested
	 * section are both static, same as the Title page / page-break rows in
	 * the main Script view's Outline.
	 */
	const renderSceneOutlineItem = (item: NavItem): ReactElement => {
		if (item.kind === 'scene') {
			// Never actually reached — `sceneOutlineTree` is bounded to one
			// scene's own span, so a nested 'scene' item can't appear here.
			return <div key={`sc-${item.scene.line}`} />;
		}
		if (item.kind === 'section') {
			const hasChildren = item.node.items.length > 0;
			return (
				<div key={`sec-${item.node.line}`} className="loom-writer-outline-act">
					<div className="loom-writer-outline-row">
						<span className="loom-subloc-grip-static" aria-hidden="true" />
						<span className="loom-row-caret" aria-hidden="true" />
						<span className="loom-writer-row-num" aria-hidden="true" />
						<span className="loom-script-scene-head">{item.node.title}</span>
						<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
						<span className="loom-writer-row-count">{t('view.entity.script.pageAbbrev', { range: sceneOutlinePageRange(item.node) })}</span>
					</div>
					{hasChildren ? (
						<div className="loom-writer-outline-children">
							{item.node.items.map((child) => renderSceneOutlineItem(child))}
						</div>
					) : null}
				</div>
			);
		}
		const group = `branch:${item.id}`;
		const branches = item.items.filter(
			(x): x is Extract<NavItem, { kind: 'section' }> => x.kind === 'section'
		);
		return (
			<div key={`bp-${item.id}`} className="loom-writer-outline-act">
				<div className="loom-writer-outline-row">
					<span className="loom-subloc-grip-static" aria-hidden="true" />
					<span className="loom-row-caret" aria-hidden="true" />
					<span className="loom-writer-row-num" aria-hidden="true" />
					<span className="loom-writer-outline-pagebreak-label">
						<Icon name="git-branch" fallback="split" /> {item.id}
					</span>
					<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
					<span className="loom-writer-row-count">
						{tn('view.entity.script.branchCount', branches.length)}
					</span>
				</div>
				<div
					className={
						seqDrag?.group === group
							? 'loom-subloc-list loom-subloc-dragging loom-writer-outline-children'
							: 'loom-subloc-list loom-writer-outline-children'
					}
				>
					{branches.map((b, i) => {
						const grabbed = seqDrag?.group === group && seqDrag.from === i;
						const hasChildren = b.node.items.length > 0;
						return (
							<div
								key={b.node.loomId ?? b.node.line}
								className={
									grabbed
										? 'loom-writer-outline-act loom-subloc-row-slide loom-subloc-row-dragging'
										: 'loom-writer-outline-act loom-subloc-row-slide'
								}
								style={seqRowStyle(group, i)}
								data-seq-row=""
							>
								<div className="loom-writer-outline-row">
									{branchGrip(group, i, branches.length, (from, over) => {
										if (!project) return;
										const ids = branches
											.map((x) => x.node.loomId)
											.filter((id): id is string => id !== null);
										const next = [...ids];
										const [moved] = next.splice(from, 1);
										next.splice(over, 0, moved);
										void editScriptAndSync(plugin, project, (raw) => reorderBranchGroup(raw, item.id, next));
									})}
									<span className="loom-row-caret" aria-hidden="true" />
									<span className="loom-writer-row-num">{i + 1}</span>
									<span className="loom-script-scene-head">{b.node.title}</span>
									<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
									<span className="loom-writer-row-count">{t('view.entity.script.pageAbbrev', { range: sceneOutlinePageRange(b.node) })}</span>
								</div>
								{hasChildren ? (
									<div className="loom-writer-outline-children">
										{b.node.items.map((grandchild) => renderSceneOutlineItem(grandchild))}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			</div>
		);
	};
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
					.filter((r) => roleOf(r.type) === null && r.type !== 'decisionPoint')
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
	/** Rewrites one list field on a note entry's frontmatter object (`involved`/
	 *  `group`/`places` are the same shape, differing only in the key and
	 *  whether an emptied-out list drops the key entirely — a `group` snapshot
	 *  cleared down to nothing means "no Group here", not "an empty array"). */
	const writeEntryField = (
		en: LocNoteEntry,
		key: 'involved' | 'group' | 'places',
		apply: (list: unknown[]) => unknown[],
		dropIfEmpty = false
	) => {
		writeOwnerNotes(en.owner, (arr) => {
			const item = arr[en.idx];
			if (typeof item !== 'object' || item === null) return;
			const obj = item as Record<string, unknown>;
			const cur = obj[key];
			const next = apply(Array.isArray(cur) ? cur : []);
			if (dropIfEmpty && next.length === 0) delete obj[key];
			else obj[key] = next;
		});
	};
	const writeEntryInvolved = (en: LocNoteEntry, apply: (list: unknown[]) => unknown[]) =>
		writeEntryField(en, 'involved', apply);
	const writeEntryGroup = (en: LocNoteEntry, apply: (list: unknown[]) => unknown[]) =>
		writeEntryField(en, 'group', apply, true);
	const writeEntryPlaces = (en: LocNoteEntry, apply: (list: unknown[]) => unknown[]) =>
		writeEntryField(en, 'places', apply);
	const involveTargets = project
		? plugin.indexer
				.getAll(undefined, project.root)
				// Locations can be involved (a place discussed/featured in the event)
				// as well as a `places` entry (where it happened) — both are allowed.
				.filter((r) => roleOf(r.type) === null && r.type !== 'decisionPoint' && r.path !== record.path)
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
			new Notice(t('project.common.nameExists'));
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
				new Notice(t('view.entity.common.renameFailed'));
			});
	};
	// Writer/Script projects: quests resolve against Scenes (`seq`);
	// Writer/Prose ones resolve against Chapters (`seq` too — neither has a
	// date). A quest's own `questReceived`/`questOutcomeSession` is always
	// the beat type in a Writer project (Scene or Chapter, never the Act) —
	// `anchorPositionKey` covers that leaf case, plus Session's own anchor
	// case for Player/GM, uniformly by keying on `seqOrdered`; an Act page's
	// OWN position is the one special case, since "as of this act" means "as
	// of its last scene" (`actScenes` is already sorted ascending by `seq`).
	const anchorPositionKey = (r: EntityRecord): number | null =>
		seqOrdered ? r.seq ?? r.created : (r.date?.sortKey ?? null);
	const showsQuestSection = (isSession || record.type === 'scene' || record.type === 'chapter') && project;
	const lastActScene = actScenes.length > 0 ? actScenes[actScenes.length - 1] : null;
	const asOf = seqOrdered
		? record.type === 'act'
			? (lastActScene?.seq ?? lastActScene?.created ?? record.seq ?? record.created)
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
			// THIS page (an Act counts any of its own scenes too), or resolved
			// on an earlier one ("Resolved previously").
			const resolvedHere =
				record.type === 'act'
					? out !== null && actScenes.some((sc) => sc.path === out.path)
					: out?.path === record.path;
			const state = !finished ? 'active' : resolvedHere ? 'resolvedThis' : 'resolvedPrev';
			return { quest: q, state };
		})
		.filter((e): e is { quest: EntityRecord; state: string } => e !== null)
		// Manual order (drag-reorderable), then chronological for the unstamped.
		.sort((a, b) => (a.quest.seq ?? a.quest.created) - (b.quest.seq ?? b.quest.created));
	// Scene/Act/Chapter pages hide the whole Quests block when nothing
	// resolves against them yet — Session pages keep showing it empty (a
	// session's quest involvement is worth surfacing as an invitation to add
	// one; a scene/act/chapter's isn't, since most of them will never touch
	// a quest).
	const questSectionVisible =
		showsQuestSection &&
		((record.type !== 'scene' && record.type !== 'act' && record.type !== 'chapter') ||
			sessionQuests.length > 0);

	// Away-from-the-party ("Active") is always PC-only — an NPC/Cast member
	// was never "in the party" to begin with. Gated on the kind: a writer
	// project's cast has no party to be away from.
	const isPc =
		record.type === 'character' && record.loomTags.includes(PC_TAG) && kindFeatures.pcLifecycle;
	// Alive + death-session: every character, not just PCs, in both Player and
	// GM projects (`characterLifecycleScope`) — tracking any character's fate
	// is useful on its own, and a GM's Special Conditions additionally read it
	// for NPCs. Unticking Alive reveals the death-session picker.
	const showsLifecycle =
		record.type === 'character' &&
		kindFeatures.pcLifecycle &&
		(kindFeatures.characterLifecycleScope === 'all' || record.loomTags.includes(PC_TAG));
	const deathSession =
		record.deathSession !== null ? plugin.indexer.resolve(record.deathSession, record.path) : null;
	const clearDeathKey = (fm: Record<string, unknown>) => clearFmKeys(fm, 'loomdeathsession', 'deathsession');
	const setAlive = (alive: boolean) => {
		void (async () => {
			await writeFmAwait((fm) => {
				setLoomKey(fm, FM.alive, alive);
				if (alive) clearDeathKey(fm);
			});
			// A GM Special Condition can name any character's fate — a death (or
			// an undone one) can flip which events are locked.
			triggerEventLockRecompute(file);
		})();
	};
	const setDeathSession = (target: string | null) => {
		void (async () => {
			await writeFmAwait((fm) => {
				if (target === null) clearDeathKey(fm);
				else setLoomKey(fm, FM.deathSession, `[[${target}]]`);
			});
			// Mirrors `setAlive` above — a Special Condition naming this
			// character could depend on it, and whichever session they died in
			// is part of that fate even though `characterAlive` itself only
			// reads the flat `alive` flag today; keeping this in sync now
			// avoids a silent gap if that condition ever grows session-aware.
			triggerEventLockRecompute(file);
		})();
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
				.setTitle(t('project.createEntity.allEntities'))
				.setIcon('filter')
				.setChecked(current === null)
				.onClick(() => setRowFilter(i, null))
		);
		for (const et of ENTITY_TYPES) {
			menu.addItem((item) =>
				item
					.setTitle(entityPlural(et))
					.setIcon(ENTITY_META[et].icon)
					.setChecked(current === et)
					.onClick(() => setRowFilter(i, et))
			);
		}
		menu.showAtMouseEvent(e.nativeEvent);
	};

	const relRow = (rel: RelationshipDraft, i: number) => (
		<div key={i} className="loom-rel-row">
			<input
				type="text"
				className="loom-rel-type"
				placeholder={t('project.addRelationship.identifier')}
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
				placeholder={rel.filter ? t('view.entity.relationships.targetPlaceholderTyped', { label: entityLabel(rel.filter) }) : t('project.addRelationship.targetPlaceholder')}
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
								label: t('view.entity.sessionNotes.createNewEntityAction'),
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
										project,
										['decisionPoint']
									).open(),
							}
						: undefined
				}
			/>
				<button
				className="loom-rel-filter"
				aria-label={t('project.createEntity.filterByType')}
				onClick={(e) => openRelFilterMenu(e, i)}
			>
				<Icon name={rel.filter ? ENTITY_META[rel.filter].icon : 'filter'} />
			</button>
			</div>
			<button
				className="loom-nav-btn"
				aria-label={t('view.entity.relationships.removeRelationship')}
				onClick={() => {
					const remove = () => commitRelationships(relationships.filter((_, j) => j !== i));
					// A still-empty new row goes silently; a filled one asks first.
					if (rel.target.trim() === '') remove();
					else {
						new ConfirmModal(
							plugin.app,
							t('view.entity.relationships.removeConfirmTitle'),
							t('view.entity.relationships.removeConfirmDetail', {
								type: rel.type.trim() === '' ? t('view.entity.relationships.relatedFallback') : rel.type.trim(),
								target: rel.target.trim(),
							}),
							remove,
							t('common.remove')
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
								removeLabel={t('view.entity.common.clearSession')}
							/>
						</div>
					) : (
						<SearchableSelect
							placeholder={t('view.entity.sessionNotes.pickSession')}
							options={sessionsByDate
								.filter((s) => s.path !== record.path && !takenSessions.has(s.path))
								.map((s) => ({ value: linkTargetOf(s), label: shortSessionLabel(s) }))}
							onPick={(name) => setNote({ session: name }, true)}
							action={
								project
									? {
											label: t('project.createEntity.createNewAction', { label: entityLabel(anchorType) }),
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
							placeholder={t('view.entity.sessionNotes.involvePlaceholder')}
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
											label: t('view.entity.sessionNotes.createNewEntityAction'),
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
													project,
													['decisionPoint']
												).open(),
										}
									: undefined
							}
						/>
						<button
							className="loom-rel-filter"
							aria-label={t('project.createEntity.filterByType')}
							onClick={(e) => {
								const menu = new Menu();
								const fkey = 'row:' + String(i);
								const current = hubFilter[fkey] ?? null;
								menu.addItem((item) =>
									item
										.setTitle(t('project.createEntity.allEntities'))
										.setIcon('filter')
										.setChecked(current === null)
										.onClick(() => setHubFilter({ ...hubFilter, [fkey]: null }))
								);
								for (const et of projectTypes(project?.config).filter((et) => roleOf(et) === null && et !== 'decisionPoint')) {
									menu.addItem((item) =>
										item
											.setTitle(entityPlural(et))
											.setIcon(ENTITY_META[et].icon)
											.setChecked(current === et)
											.onClick(() => setHubFilter({ ...hubFilter, [fkey]: et }))
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
									removeLabel={t('view.entity.common.removeTheGroup')}
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
										removeLabel={t('view.entity.common.removeInvolvedEntity')}
									/>
								))}
						</div>
					) : null}
					</div>
					{hasNoteLocation ? (
						<div className="loom-hub-col">
						<div className="loom-hub-location">
							<SearchableSelect
								placeholder={t('view.entity.common.locationPlaceholder')}
								options={(project ? plugin.indexer.getAll('location', project.root) : [])
									.filter((l) => !noteLocs.some((q) => q.target?.path === l.path))
									.sort(mainLocationFirst)
									.map((l) => ({ value: linkTargetOf(l), label: locationLabel(l, plugin) }))}
								onPick={(name) => setNote({ places: [...note.places, name] }, true)}
								action={
									project
										? {
												label: t('view.entity.sessionNotes.createNewLocationAction'),
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
										removeLabel={t('view.entity.common.removeLocation')}
									/>
								))}
							</div>
						) : null}
						</div>
					) : null}
								<button
					className="loom-nav-btn loom-note-remove loom-entity-delete"
					aria-label={t('view.entity.sessionNotes.deleteNote')}
					onClick={() => {
						const remove = () => commitSessionNotes(sessionNotes.filter((_, j) => j !== i));
						// Only a note that actually holds text needs a confirmation.
						if (note.text.trim() === '') remove();
						else {
							new ConfirmModal(
								plugin.app,
								t('view.entity.sessionNotes.deleteConfirmTitle'),
								t('view.entity.sessionNotes.deleteConfirmDetail'),
								remove,
								t('project.common.delete')
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
									removeLabel={t('view.entity.common.removePlace')}
								/>
							);
						})}
						<SearchableSelect
							placeholder={t('view.entity.common.addPlacePlaceholder')}
							options={projectLocations
								.filter((l) => l.path !== record.path && !note.places.includes(linkTargetOf(l)))
								.sort(mainLocationFirst)
								.map((l) => ({ value: linkTargetOf(l), label: locationLabel(l, plugin) }))}
							onPick={(name) => setNote({ places: [...note.places, name] }, true)}
							action={
								project
									? {
											label: t('project.createEntity.createNewAction', { label: entityLabel('location') }),
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
				
				) : null}
				<div className="loom-note-text">
					<MarkdownField
						app={plugin.app}
						value={note.text}
						names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
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
						aria-label={t('view.entity.common.openPage')}
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
							aria-label={t('view.entity.common.deleteThisEntity')}
							onClick={() =>
								new ConfirmModal(
									plugin.app,
									t('view.list.deleteConfirmTitle', { name: en.owner.name }),
									t('view.list.deleteMessageGeneral'),
									() => {
										const f = plugin.app.vault.getFileByPath(en.owner.path);
										if (!f) return;
										void purgeEntityReferences(plugin, en.owner.path, en.owner.project).finally(() =>
											plugin.app.fileManager.trashFile(f)
										);
									},
									t('project.common.delete')
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
								aria-label={t('view.entity.common.removeFromNote')}
								onClick={() =>
									new ConfirmModal(
										plugin.app,
										t('view.entity.events.removeFromSessionTitle'),
										t('view.entity.events.removeFromSessionDetail'),
										() =>
											writeOwnerNotes(en.owner, (arr) => {
												const item = arr[en.idx];
												if (typeof item === 'object' && item !== null)
													(item as { session?: unknown }).session = '';
											}),
										t('common.remove')
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
								aria-label={t('view.entity.common.removeFromNote')}
								onClick={() =>
									new ConfirmModal(
										plugin.app,
										t('view.entity.events.removeFromNoteTitle'),
										t('view.entity.events.removeFromNoteDetail', { name: record.name, owner: en.owner.name }),
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
									t('common.remove')
								).open()
							}
						>
								✕
							</button>
						)}
					</div>
					<button
						className="loom-nav-btn"
						aria-label={hubMenu === menuKey ? t('view.entity.common.closeActions') : t('view.entity.common.showActions')}
						onClick={() => setHubMenu(hubMenu === menuKey ? null : menuKey)}
					>
						{hubMenu === menuKey ? '>' : '<'}
					</button>
				</div>
				<div className="loom-hub-involve-row loom-hub-location-row">
					<div className="loom-hub-col">
						<div className="loom-hub-involve">
							<SearchableSelect
							placeholder={t('view.entity.sessionNotes.involvePlaceholder')}
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
											label: t('view.entity.sessionNotes.createNewEntityAction'),
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
													project,
													['decisionPoint']
												).open();
											},
										}
									: undefined
							}
						/>
							<button
							className="loom-rel-filter"
							aria-label={t('project.createEntity.filterByType')}
							onClick={(e) => {
								const menu = new Menu();
								const current = hubFilter[menuKey] ?? null;
								menu.addItem((item) =>
									item
										.setTitle(t('project.createEntity.allEntities'))
										.setIcon('filter')
										.setChecked(current === null)
										.onClick(() => setHubFilter({ ...hubFilter, [menuKey]: null }))
								);
								for (const et of projectTypes(project?.config).filter((et) => roleOf(et) === null && et !== 'decisionPoint')) {
									menu.addItem((item) =>
										item
											.setTitle(entityPlural(et))
											.setIcon(ENTITY_META[et].icon)
											.setChecked(current === et)
											.onClick(() => setHubFilter({ ...hubFilter, [menuKey]: et }))
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
										removeLabel={t('view.entity.common.removeTheGroup')}
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
													t('view.entity.events.removeFromInvolvedTitle'),
													t('view.entity.events.removeFromNoteDetail', { name: target.name, owner: en.owner.name }),
													doRemove,
													t('common.remove')
												).open();
											} else doRemove();
										}}
										removeLabel={t('view.entity.common.removeInvolvedEntity')}
									/>
								))}
							</div>
						) : null}
					</div>
					<div className="loom-hub-col">
						<div className="loom-hub-location">
						<SearchableSelect
							placeholder={t('view.entity.common.locationPlaceholder')}
							options={(project ? plugin.indexer.getAll('location', project.root) : [])
								.filter((t) => !locs.some((l) => l.target?.path === t.path))
								.sort(mainLocationFirst)
								.map((t) => ({ value: linkTargetOf(t), label: locationLabel(t, plugin) }))}
							onPick={(name) => writeEntryPlaces(en, (list) => [...list, `[[${name}]]`])}
							action={
								project
									? {
											label: t('view.entity.sessionNotes.createNewLocationAction'),
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
													t('view.entity.events.removeFromLocationTitle'),
													t('view.entity.events.removeFromNoteDetail', { name: target.name, owner: en.owner.name }),
													remove,
													t('common.remove')
												).open();
											} else remove();
										}}
										removeLabel={t('view.entity.common.removeLocation')}
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
						names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
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
	// the location-only sections (Factions/Items/Sublocations) on a location
	// page.
	const eventsSection =
		showsEvents && project ? (
			<div className="loom-field loom-field-sep">
				<span className="loom-field-label">{entityPlural(beatType)}</span>
				<div className="loom-hub-add-row">
					<SearchableSelect
						placeholder={t('view.list.addBeatTitle', {
							article: /^[aeiou]/.test(beatLabel) ? 'an' : 'a',
							beat: beatLabel,
						}) + '…'}
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
							label: t('project.createEntity.createNewAction', { label: entityLabel(beatType) }),
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
									<EntityChip plugin={plugin} record={null} label={t('view.entity.events.noSession')} />
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
				<span className="loom-field-label">{entityPlural('item')}</span>
				<div className="loom-hub-add-row">
					<SearchableSelect
						placeholder={t('view.entity.items.addItemPlaceholder')}
						options={plugin.indexer
							.getAll('item', project.root)
							.filter((it) => !itemRecords.some((r) => r.path === it.path))
							.sort((a, b) => a.name.localeCompare(b.name))
							.map((it) => ({ value: linkTargetOf(it), label: it.name }))}
						onPick={(linkTarget) => addItemLink(linkTarget)}
						action={{
							label: t('project.createEntity.createNewAction', { label: entityLabel('item') }),
							onPick: () =>
								new CreateEntityModal(plugin, 'item', project, {
									onCreated: (created) => addItemLink(created.basename),
								}).open(),
						}}
					/>
				</div>
				{itemRecords.length > 0 ? (
					<div className="loom-tag-row">{itemRecords.map((item) => itemRow(item))}</div>
				) : null}
				{inheritedGroups.length > 0 ? (
					<div className="loom-inherited-items">
						<span className="loom-field-sublabel">{t('view.entity.items.itemsInSublocations')}</span>
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
					← {t('view.entity.common.back')}
				</button>
			<span
					className="loom-chip"
					style={{
						background: plugin.settings.nodeColors[record.type] + '40',
						border: `1px solid ${plugin.settings.nodeColors[record.type]}`,
					}}
				>
					{entityLabel(record.type)}
				</span>
				<div className="loom-shell-spacer" />
				{isLocation && record.parentLocation === null && project ? (
					<button className="loom-nav-btn" onClick={openTurnIntoPicker}>
						{t('view.entity.location.turnToSublocation')}
					</button>
				) : null}
			<button
					className="loom-rel-filter"
					aria-label={t('view.entity.notEntity.openAsMarkdown')}
					onClick={() => view.navigateTo('markdown', { file: file.path })}
				>
					<Icon name="file-type" />
				</button>
			<button
					className="loom-rel-filter loom-entity-delete"
					aria-label={t('project.common.delete')}
					onClick={() =>
						new ConfirmModal(
							plugin.app,
							t('view.list.deleteConfirmTitle', { name: recordLabel(record, project) }),
							// A scene/act IS its stretch of the script — deleting the
							// note while leaving the writing behind would just resurrect it
							// on the next parse, so the two go together. Deleting an act
							// also takes its scenes' notes with it (their headings live in
							// the act's own script block, which is about to go too). An
							// Act/Chapter in a Prose project is the identical story one
							// level over, against the Book instead of the script.
							scriptNamed
								? record.type === 'act'
									? t('view.list.deleteMessageAct')
									: t('view.list.deleteMessageScene')
								: bookNamed
									? record.type === 'act'
										? t('view.list.deleteMessageBookAct')
										: t('view.list.deleteMessageBookChapter')
									: t('view.list.deleteMessageGeneral'),
							() => {
								// Leave the page first so the view never sits on a
								// trashed file, then delete.
								const origin = view.origin;
								if (origin) view.navigateTo(origin.type, origin.state);
								else if (project) {
									view.navigateTo(VIEW_LIST, { project: project.root, entityType: record.type });
								}
								if (scriptNamed && project) {
									void deleteScriptEntity(plugin, project, record);
								} else if (bookNamed && project) {
									void deleteBookEntity(plugin, project, record);
								} else {
									void purgeEntityReferences(plugin, record.path, record.project).finally(() =>
										plugin.app.fileManager.trashFile(file)
									);
								}
							},
							t('project.common.delete')
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
					<span className="loom-field-label">{entityLabel('item')}</span>
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
							{/* Acts (and scenes, on their own modular heading editor)
							    are named by the script — their `#` section / scene
							    heading is the source of truth. That's about not
							    authoring a RIVAL copy of the text, not about the field
							    being read-only: an Act page edit here writes straight
							    into the script's `#` line (`renameSectionTitle`), and the
							    sync round-trips it back into this same field — modularly
							    editable everywhere, same as the rest of the plugin.
							    Labeled "Title" rather than "Name" when it's script-owned,
							    since that's what pairs with the act's editable
							    "Display title" below. A Character's own name gets a
							    dedicated label ("Имя" in Russian) — the generic Name
							    label ("Название") is grammatically a thing's name, not
							    a person's. */}
							<span className="loom-field-label">
								{scriptNamed
									? t('view.entity.common.titleLabel')
									: t(
											record.type === 'character'
												? 'view.entity.common.characterNameLabel'
												: 'view.entity.common.nameLabel'
										)}
							</span>
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								onBlur={() => void (record.type === 'act' ? commitActTitle() : commitName())}
								onKeyDown={(e) => {
									if (e.key === 'Enter') void (record.type === 'act' ? commitActTitle() : commitName());
								}}
							/>
						</label>
						<div className="loom-alias-col">
							<span className="loom-field-label">{t('view.entity.common.aliases')}</span>
							<div className="loom-alias-box">
								<input
									type="text"
									placeholder={t('view.list.addAlias')}
									value={aliasDraft}
									onChange={(e) => setAliasDraft(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') addAlias();
									}}
								/>
								<button className="loom-rel-filter loom-alias-add" aria-label={t('view.list.addAlias')} onClick={addAlias}>
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
									removeLabel={t('view.entity.common.removeAlias')}
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
					<span className="loom-field-label">{t('view.entity.scene.headingLabel')}</span>
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
							placeholder={entityLabel('location')}
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
							placeholder={t('project.createEntity.sublocationOptional')}
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
							placeholder={t('project.createEntity.timePlaceholder')}
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
					<span className="loom-field-label">{t('project.createEntity.sublocationOf')}</span>
					{parentLocation ? (
						<button className="loom-subloc-link" onClick={() => view.openEntity(parentLocation.path)}>
							{parentLocation.name}
						</button>
					) : (
						<span>{record.parentLocation}</span>
					)}
				</div>
			) : null}

			{/* Part of region — a grouping layer above locations, shown right after
			    "Sublocation of". A sublocation shows this READ-ONLY, inherited
			    from whichever main location it ultimately sits under — it never
			    picks its own (see `currentRegion`'s own doc comment for why). */}
			{isSublocationPage ? (
				<div className="loom-field">
					<span className="loom-field-label">{t('project.createEntity.partOfRegion')}</span>
					{/* `.loom-field` is a column flex container (`align-items: stretch`
					    by default), which is what was stretching a bare chip to the
					    full field width — `.loom-region-pick` (a ROW flex container,
					    same wrapper the editable picker below already uses) makes the
					    chip a row item instead, shrink-wrapping to its own text. */}
					<div className="loom-region-pick">
						{currentRegion ? (
							<EntityChip
								plugin={plugin}
								record={currentRegion}
								onOpen={() => view.openEntity(currentRegion.path)}
							/>
						) : (
							<span className="loom-field-hint">{t('common.notSpecified')}</span>
						)}
					</div>
				</div>
			) : isLocation ? (
				<div className="loom-field">
					<span className="loom-field-label">{t('project.createEntity.partOfRegion')}</span>
					{!record.region || editingRegion ? (
						<div className="loom-region-pick">
							<SearchableSelect
								key={`${record.region ?? ''}:${editingRegion}`}
								placeholder={t('common.notSpecified')}
								options={regions
									.map((r) => ({ value: linkTargetOf(r), label: r.name }))
									.sort((a, b) => a.label.localeCompare(b.label))}
								initialQuery={editingRegion ? currentRegion?.name ?? '' : ''}
								action={
									project
										? {
												label: t('project.createEntity.createNewAction', { label: entityLabel('region') }),
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
									aria-label={t('view.entity.location.clearRegion')}
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
								aria-label={t('view.entity.location.changeRegion')}
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
						{t('project.createEntity.date')}
						{sessionNumber > 0 ? (
							<span className="loom-session-number">{t('view.entity.common.sessionNumber', { n: sessionNumber })}</span>
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

			{/* A writer project's Scene/Chapter has no date of its own — its
			    position in the story is the script/book order (`seq`), same as
			    an Act's. */}
			{isBeat && record.type !== 'scene' && record.type !== 'chapter' ? (
				<label className="loom-field">
					<span className="loom-field-label">{t('project.createEntity.date')}</span>
					<input
						type="text"
						placeholder={t('common.notSpecified')}
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
						{t('view.entity.common.todayLink')}
					</span>
				</label>
			) : null}

			{record.type === 'act' ? (
				<label className="loom-field">
					<span className="loom-field-label loom-field-label-row">
						{t('view.entity.common.titleLabel')}
						{sessionNumber > 0 ? (
							<span className="loom-session-number">{t('view.entity.common.actNumber', { n: sessionNumber })}</span>
						) : null}
					</span>
					{/* The script's `# section` line — editing it writes straight into
					    the script (`renameSectionTitle`); the note's own name/file are
					    then reflected back by the sync that follows. Acts don't
					    render the generic Name field above (they take the `isSession`
					    branch of the page shell), so this is the ONLY place the title
					    is exposed and edited. */}
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onBlur={() => void commitActTitle()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void commitActTitle();
						}}
					/>
				</label>
			) : null}

			{/* Display title is a printed-page concept (the exported PDF's
			    centered-bold marker) — meaningless with no script to print,
			    so Prose Acts don't get this field at all. */}
			{record.type === 'act' && scriptMode ? (
				<label className="loom-field">
					<span className="loom-field-label">{t('project.createEntity.displayTitle.name')}</span>
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

			{/* Acts are otherwise `isSession`-shaped (the anchor role) and so
			    skip the generic body section below — but with Description gone
			    from the Scene/Act pages, an Act needs this as its one
			    remaining freeform field, same as every Scene already has it.
			    Placed right after the title fields rather than down with the
			    rest of the page. */}
			{record.type === 'act' ? (
				<div className="loom-field loom-field-body">
					<span className="loom-field-label">{t('project.notes')}</span>
					<MarkdownField
						app={plugin.app}
						value={body ?? ''}
						names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
						onOpenLink={openLinkTarget}
						onCreateEntity={createLinkEntity}
						onChange={(v) => {
							setBody(v);
							saveBody(v);
						}}
					/>
				</div>
			) : null}

			{isSession && kindFeatures.attendance ? (
				<div className="loom-field">
					<span className="loom-field-label">{t('view.entity.common.attendance')}</span>
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
						<div className="loom-attendance-empty">{t('view.entity.common.noPcCharacters')}</div>
					)}
				</div>
			) : null}


			{questSectionVisible ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">{entityPlural('quest')}</span>
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
								? t('view.list.active')
								: state === 'resolvedThis'
									? t('view.entity.quests.resolvedThis', { page: pageLabel })
									: t('view.entity.quests.resolvedPreviously');
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
											? t('view.entity.quests.countOfTotal', { count: list.length, total })
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
															{givers.length > 1 ? t('view.list.questGivers') : t('view.list.questGiver')}
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
													<span className="loom-quest-card-label">{t('view.list.receivedOn')}</span>
<span className="loom-quest-card-value">														{received && roleOf(received.type) === questAnchorRole ? (
															received.path === record.path ? (
																<span>{t('view.entity.quests.thisPage', { page: pageLabel })}</span>
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
																{quest.loomTags.length > 1 ? t('view.list.tagsLabel') : t('view.list.tagLabel')}
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
															<span className="loom-quest-card-label">{t('view.list.completedOn')}</span>
<span className="loom-quest-card-value">																{outcomeSes && roleOf(outcomeSes.type) === questAnchorRole ? (
																	outcomeSes.path === record.path ? (
																		<span>{t('view.entity.quests.thisPage', { page: pageLabel })}</span>
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
																<span className="loom-quest-card-label">{t('view.entity.quests.outcomeLabel')}</span>
<span className="loom-quest-card-value">																<span>
																	{quest.questOutcome !== '' ? questOutcomeLabel(quest.questOutcome) : '—'}
																</span></span>
															</div>
														</>
													) : null}
													<div className="loom-quest-card-row">
													<span className="loom-quest-card-label">{t('view.entity.quests.rewardLabel')}</span>
<span className="loom-quest-card-value">														<Truncated
															className="loom-clip"
															text={quest.reward !== '' ? quest.reward : t('common.notSpecified')}
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
						<span className="loom-field-label">{t('view.entity.quests.questGiversLabel')}</span>
						<SearchableSelect
							placeholder={t('project.createEntity.addQuestGiver')}
							options={characters
								.filter((c) => !questGiverRecords.some((g) => g.path === c.path))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((c) => ({ value: linkTargetOf(c), label: c.name }))}
							onPick={(target) => writeQuestGivers([...questGiverRecords.map((g) => linkTargetOf(g)), target])}
							action={
								project
									? {
											label: t('project.createEntity.createNewAction', { label: entityLabel('character') }),
											onPick: () =>
												new CreateEntityModal(plugin, 'character', project, {
													onCreated: (created) =>
														writeQuestGivers([...questGiverRecords.map((g) => linkTargetOf(g)), created.basename]),
												}).open(),
										}
									: undefined
							}
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
										removeLabel={t('view.entity.quests.removeQuestGiver')}
									/>
								))}
							</div>
						) : null}
					</div>
					<div className="loom-quest-right">
						<div className="loom-quest-sessions">
							<div className="loom-field">
								<span className="loom-field-label">{t('view.entity.quests.receivedIn', { anchor: questAnchorRole === 'beat' ? beatLabel : anchorLabel })}</span>
								{questReceived && roleOf(questReceived.type) === questAnchorRole ? (
									sessionChip(questReceived, () => setQuestSession('questReceived', null))
								) : (
									<SearchableSelect
										placeholder={t('project.createEntity.pickAnchor', { anchor: questAnchorRole === 'beat' ? beatLabel : anchorLabel })}
										options={questAnchorsSorted.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
										onPick={(name) => setQuestSession('questReceived', name)}
										action={
											project
												? {
														label: t('project.createEntity.createNewAction', {
															label: entityLabel(questAnchorType),
														}),
														onPick: () =>
															new CreateEntityModal(plugin, questAnchorType, project, {
																onCreated: (created) => setQuestSession('questReceived', created.basename),
															}).open(),
													}
												: undefined
										}
									/>
								)}
							</div>
							{record.questOutcome !== '' ? (
								<div className="loom-field">
									<span className="loom-field-label">
										{t('view.entity.quests.outcomeInAnchor', {
											outcome: questOutcomeLabel(record.questOutcome),
											anchor: questAnchorRole === 'beat' ? beatLabel : anchorLabel,
										})}
									</span>
									{questOutcomeSession && roleOf(questOutcomeSession.type) === questAnchorRole ? (
										sessionChip(questOutcomeSession, () => setQuestSession('questOutcomeSession', null))
									) : (
										<SearchableSelect
											placeholder={t('project.createEntity.pickAnchor', { anchor: questAnchorRole === 'beat' ? beatLabel : anchorLabel })}
											options={questAnchorsSorted.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
											onPick={(name) => setQuestSession('questOutcomeSession', name)}
											action={
												project
													? {
															label: t('project.createEntity.createNewAction', {
																label: entityLabel(questAnchorType),
															}),
															onPick: () =>
																new CreateEntityModal(plugin, questAnchorType, project, {
																	onCreated: (created) =>
																		setQuestSession('questOutcomeSession', created.basename),
																}).open(),
														}
													: undefined
											}
										/>
									)}
								</div>
							) : null}
							<label className="loom-field">
								<span className="loom-field-label">{t('view.entity.quests.outcomeSelectLabel')}</span>
								<select value={record.questOutcome} onChange={(e) => setQuestOutcome(e.target.value)}>
									<option value="">{t('view.list.active')}</option>
									{QUEST_OUTCOMES.map((o) => (
										<option key={o} value={o}>
											{questOutcomeLabel(o)}
										</option>
									))}
								</select>
							</label>
						</div>
						<div className="loom-field">
							<span className="loom-field-label">{t('project.createEntity.reward')}</span>
							<MarkdownField
								app={plugin.app}
								value={reward}
								names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
								placeholder={t('common.notSpecified')}
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
						{description === '' ? t('project.createEntity.description') : t('view.entity.items.alternativeDescription')}
					</span>
					<MarkdownField
						app={plugin.app}
						value={description === '' ? copyOriginal?.description ?? '' : description}
						names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
						onOpenLink={openLinkTarget}
						onCreateEntity={createLinkEntity}
						onChange={(v) => {
							setDescription(v);
							saveDescription(v);
						}}
					/>
					{description !== '' ? (
						<details className="loom-orig-desc">
							<summary>{t('view.entity.items.originalDescription')}</summary>
							<MarkdownField
								app={plugin.app}
								value={copyOriginal?.description ?? ''}
								names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
								onOpenLink={openLinkTarget}
								onChange={() => undefined}
								readOnly
							/>
						</details>
					) : null}
				</div>
			) : record.type === 'scene' || record.type === 'act' || record.type === 'chapter' ? (
				// The script/prose body IS the writing — a scene/act/chapter's own
				// blurb field is redundant with it, so this page shows only the
				// freeform Notes section (above, right after the title) instead.
				null
			) : (
		<div className={isSession ? 'loom-field loom-field-sep' : 'loom-field'}>
				<span className="loom-field-label">{t('project.createEntity.description')}</span>
				{showsLifecycle ? (
					<label className="loom-check">
						<input type="checkbox" checked={record.alive} onChange={(e) => setAlive(e.target.checked)} />
						{t('view.entity.common.alive')}
					</label>
				) : null}
				{isPc ? (
					<div className="loom-check-with-info">
						<label className="loom-check">
							<input
								type="checkbox"
								checked={record.active}
								onChange={(e) => setActive(e.target.checked)}
							/>
							{t('view.list.active')}
						</label>
						<InfoIcon text={t('view.entity.common.activeTooltip')} />
					</div>
				) : null}
				{showsLifecycle && !record.alive ? (
					<div className="loom-death-row">
						<span className="loom-field-label">{t('view.entity.common.deathSession')}</span>
						{deathSession && roleOf(deathSession.type) === 'anchor' ? (
							<div className="loom-tag-row">
								<EntityChip
									plugin={plugin}
									record={deathSession}
									label={recordLabel(deathSession, project)}
									onOpen={() => view.openEntity(deathSession.path)}
									onRemove={() => setDeathSession(null)}
									removeLabel={t('view.entity.common.clearDeathSession')}
								/>
							</div>
						) : (
							<SearchableSelect
								placeholder={t('project.createEntity.pickSession')}
								options={sessions
									.slice()
									.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0))
									.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
								onPick={(name) => setDeathSession(name)}
								action={
									project
										? {
												label: t('project.createEntity.createNewAction', { label: entityLabel(anchorType) }),
												onPick: () =>
													new CreateEntityModal(plugin, anchorType, project, {
														onCreated: (created) => setDeathSession(created.basename),
													}).open(),
											}
										: undefined
								}
							/>
						)}
					</div>
				) : null}
				<MarkdownField
					app={plugin.app}
					value={description}
					names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
					onOpenLink={openLinkTarget}
					onCreateEntity={createLinkEntity}
					placeholder={t('view.entity.common.descriptionPlaceholder')}
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
						{t('view.entity.common.anchorGraph', { anchor: entityLabel(anchorType) })}
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

			{record.type === 'act' && scriptMode && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">{t('common.scriptLabel')}</span>
					{actExcerpt !== null
						? (() => {
								// Same box-local placement as the Scene page's own panel —
								// lives inside the editor box's left margin via a sticky
								// wrapper scoped to the box's own scroll, not the page's.
								const actNavPanel =
									actNavTree && actNavTree.items.length > 0 ? (
										<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
											<button
												className="loom-script-nav-toggle"
												aria-label={actNavOpen ? t('view.entity.script.hideNavigation') : t('view.entity.script.showNavigation')}
												onClick={() => openActSidePanel(actNavOpen ? null : 'nav')}
											>
												<Icon name={actNavOpen ? 'panel-left-close' : 'panel-left-open'} fallback="list" />
											</button>
											{actNavOpen ? (
												<aside className="loom-script-nav">
													<div className="loom-script-nav-head">
														{t('view.entity.script.navigate')}
														<button
															className="loom-rel-filter"
															aria-label={t('view.entity.script.hideNavigation')}
															onClick={() => setActNavOpen(false)}
														>
															<Icon name="chevron-left" />
														</button>
													</div>
													{actNavTree.items.map((item) =>
														renderNavTreeItem(item, 1, (line) => {
															// `line` is an ABSOLUTE line in the whole script (from
															// `buildNavTree`) — back out to a line relative to this
															// act's own excerpt (which starts at the act's own `#`
															// line) to match `actBodyPages`' own numbering.
															const excerptLine = line - (actNavSection?.line ?? 0);
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
															const flatEls = actBodyPages.flat();
															const target = flatEls.find((e) => e.line >= excerptLine) ?? flatEls[flatEls.length - 1];
															const container = actScriptPagesRef.current;
															const targetEl = target
																? container?.querySelector(`[data-line="${target.line}"]`)
																: null;
															if (container && targetEl) {
																const containerRect = container.getBoundingClientRect();
																const targetRect = targetEl.getBoundingClientRect();
																const top = container.scrollTop + (targetRect.top - containerRect.top);
																container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
															}
														})
													)}
												</aside>
											) : null}
										</div>
									) : null;
								const actAnnotationSpans = findAnnotationSpans(actExcerpt);
								const actMatches: ScriptSearchMatch[] = [];
								if (actScriptQuery.trim() !== '') {
									const needle = actScriptQuery.toLowerCase();
									const hay = actDraft.toLowerCase();
									for (
										let at = hay.indexOf(needle);
										at !== -1;
										at = hay.indexOf(needle, at + needle.length)
									) {
										actMatches.push({ kind: 'text', offset: at });
									}
									for (const [id, entries] of Object.entries(scriptNotes.comments)) {
										if (entries.some((e) => e.text.toLowerCase().includes(needle))) actMatches.push({ kind: 'comment', id });
									}
									for (const [id, entry] of Object.entries(scriptNotes.altText)) {
										entry.options.forEach((opt, optionIndex) => {
											if (opt.toLowerCase().includes(needle)) actMatches.push({ kind: 'altOption', id, optionIndex });
										});
									}
									const posOf = (m: ScriptSearchMatch) =>
										m.kind === 'text' ? m.offset : (actAnnotationSpans.find((s) => s.id === m.id)?.from ?? Infinity);
									actMatches.sort((a, b) => posOf(a) - posOf(b));
								}
								const gotoActMatch = (index: number) => {
									if (actMatches.length === 0) return;
									const next =
										((index % actMatches.length) + actMatches.length) % actMatches.length;
									setActScriptMatchIndex(next);
									const m = actMatches[next];
									if (m.kind === 'text') {
										setOpenComment(null);
										setHighlightedAnnotationId(null);
										// Only TEXT matches render as a `<mark>` — the Nth one in
										// DOM order is the Nth TEXT match strictly, not the Nth
										// match overall (comment/alt matches interleaved before it
										// in document order don't produce a mark at all).
										const textIndex = actMatches.slice(0, next).filter((x) => x.kind === 'text').length;
										window.requestAnimationFrame(() => {
											const container = actScriptPagesRef.current;
											const mark = container?.querySelectorAll('mark')[textIndex];
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
										return;
									}
									const span = actAnnotationSpans.find((s) => s.id === m.id);
									if (!span) return;
									setHighlightedAnnotationId(m.kind === 'altOption' ? m.id : null);
									window.requestAnimationFrame(() => {
										const container = actScriptPagesRef.current;
										const icon = container?.querySelector(`[data-loom-annotation-id="${m.id}"]`);
										if (!container || !(icon instanceof HTMLElement)) return;
										scrollIntoContainer(container, icon, 'smooth');
										if (m.kind === 'comment') handleOpenComment(m.id, icon.getBoundingClientRect());
									});
								};
								/** Outline is a plain swap either direction — a management
								 *  list, not a reading position to preserve — mirroring the
								 *  main Script view's own `switchMode`. */
								const switchActMode = (next: 'pages' | 'outline') => {
									if (next !== actScriptMode) setActScriptMode(next);
								};
								/** Comments/Alternatives browser panels, scoped to just this
								 *  act's own excerpt — `findAnnotationSpans(actDraft)` rather
								 *  than the whole script, since `actDraft` (heading stripped) is
								 *  the same disk-derived excerpt `PagesPreviewBody` renders
								 *  below, so a span's offsets already line up with its own
								 *  `data-loom-annotation-id` lookup with no line-math conversion
								 *  needed (unlike the nav tree above, which is built from the
								 *  whole document and has to convert absolute lines back to
								 *  excerpt-relative ones). Marker ids are globally unique
								 *  regardless of which slice of the script they're scanned from,
								 *  so `scriptNotes` lookups by id still resolve correctly. */
								const actAnnotationSpansAll = findAnnotationSpans(actDraft);
								const actUnresolvedCommentSpans = actAnnotationSpansAll
									.filter((s) => s.kind === 'comment')
									.map((s) => ({
										span: s,
										unresolvedEntries: (scriptNotes.comments[s.id] ?? []).filter((e) => !e.resolved),
									}))
									.filter((x) => x.unresolvedEntries.length > 0);
								const actUndecidedAltSpans = actAnnotationSpansAll.filter(
									(s) => s.kind === 'alt' && (scriptNotes.altText[s.id]?.acceptedIndex ?? null) === null
								);
								const actExcerptOf = (span: AnnotationSpan): string => {
									const raw = actDraft.slice(span.contentFrom, span.contentTo).replace(/\s+/g, ' ').trim();
									return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
								};
								const jumpToActAnnotation = (span: AnnotationSpan) => {
									openActSidePanel(null);
									switchActMode('pages');
									window.requestAnimationFrame(() => {
										const container = actScriptPagesRef.current;
										const icon = container?.querySelector(`[data-loom-annotation-id="${span.id}"]`);
										if (!container || !(icon instanceof HTMLElement)) return;
										scrollIntoContainer(container, icon, 'smooth');
										if (span.kind === 'comment') {
											setOpenComment(null);
											handleOpenComment(span.id, icon.getBoundingClientRect());
										} else {
											setOpenComment(null);
											setHighlightedAnnotationId(span.id);
										}
									});
								};
								// Same box-local sticky slot as `actNavPanel` above, just
								// rendered only while open (no permanent toggle button of its
								// own inside the slot -- the toolbar's standalone icon buttons
								// are that toggle). Only one of nav/comments/alt is ever open
								// at a time (`openActSidePanel`), so these never actually
								// stack visibly even though all three can be present in the
								// tree.
								const actCommentsAside = actCommentsPanelOpen ? (
									<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
										<aside className="loom-script-nav">
											<div className="loom-script-nav-head">
												{t('view.entity.script.unresolvedComments')}
												<button
													className="loom-rel-filter"
													aria-label={t('view.entity.script.hideComments')}
													onClick={() => setActCommentsPanelOpen(false)}
												>
													<Icon name="chevron-left" />
												</button>
											</div>
											{actUnresolvedCommentSpans.length === 0 ? (
												<div className="loom-script-nav-empty">{t('view.entity.script.noUnresolvedComments')}</div>
											) : (
												actUnresolvedCommentSpans.map(({ span, unresolvedEntries }) => (
													<div key={span.id} className="loom-script-comments-panel-group">
														<button
															className="loom-script-nav-act loom-script-comments-panel-excerpt"
															onClick={() => jumpToActAnnotation(span)}
														>
															{actExcerptOf(span)}
														</button>
														<div className="loom-script-comments-panel-nested">
															{unresolvedEntries.map((entry) => (
																<button
																	key={entry.id + entry.createdAt}
																	className="loom-script-comments-panel-reply"
																	onClick={() => jumpToActAnnotation(span)}
																>
																	{entry.text.trim() === '' ? t('view.entity.script.emptyReply') : entry.text}
																</button>
															))}
														</div>
													</div>
												))
											)}
										</aside>
									</div>
								) : null;
								const actAltAside = actAltPanelOpen ? (
									<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
										<aside className="loom-script-nav">
											<div className="loom-script-nav-head">
												{t('view.entity.script.unfinalizedAlternatives')}
												<button
													className="loom-rel-filter"
													aria-label={t('view.entity.script.hideAlternatives')}
													onClick={() => setActAltPanelOpen(false)}
												>
													<Icon name="chevron-left" />
												</button>
											</div>
											{actUndecidedAltSpans.length === 0 ? (
												<div className="loom-script-nav-empty">{t('view.entity.script.everyAlternativeAccepted')}</div>
											) : (
												actUndecidedAltSpans.map((span) => (
													<button
														key={span.id}
														className="loom-script-nav-act loom-script-comments-panel-excerpt"
														onClick={() => jumpToActAnnotation(span)}
													>
														{actExcerptOf(span)}
													</button>
												))
											)}
										</aside>
									</div>
								) : null;
								/** Scrolls the section into view on every tab click, even a
								 *  re-click of the pane already active — mirrors the main
								 *  Script view's `clickTab`/`scrollTabsIntoView`, so working
								 *  in this section from wherever the page happens to be
								 *  scrolled is one click away. Switches mode FIRST and scrolls
								 *  on the next frame, after the new pane has actually laid
								 *  out — scrolling before the switch used the OLD content's
								 *  height, and Outline is usually much shorter than Script/
								 *  Pages, so the browser clamped the resulting out-of-range
								 *  scroll position back up the page once the content shrank,
								 *  landing well above the tabs instead of on them. */
								const clickActTab = (next: 'pages' | 'outline') => {
									switchActMode(next);
									window.requestAnimationFrame(() => {
										actScriptTabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
									});
								};
								/** Pages preview's right-click "Open this scene" — `line` is
								 *  relative to THIS ACT's own excerpt (`actExcerpt`, fed as
								 *  `PagesPreviewBody`'s `rawText`), so it's converted to an
								 *  absolute script line first (the inverse of the nav panel's
								 *  own conversion above) before resolving via `sceneAtLine`
								 *  and handing off to the target Scene page — mirrors
								 *  script-view.tsx's own `openThisScene` exactly, just with
								 *  this extra excerpt-to-absolute step. */
								const openThisSceneFromAct = (line: number) => {
									if (!scriptParsed || !actNavSection) return;
									const absLine = line + actNavSection.line;
									const scene = sceneAtLine(scriptParsed, absLine);
									if (!scene || scene.loomId === null) return;
									const note = plugin.indexer
										.getAll('scene', record.project)
										.find((s) => s.sceneId === scene.loomId);
									if (!note) return;
									const excerpt = sceneScriptText(scriptText, scene.loomId);
									if (excerpt === null) return;
									const bodyLine = Math.max(0, absLine - scene.line - computeSceneBodyLineOffset(excerpt));
									window.localStorage.setItem(`loom-scene-script-line:${note.path}`, String(bodyLine));
									view.openEntity(note.path);
								};
								return (
									<>
										<div className="loom-writer-tabs" ref={actScriptTabsRef}>
											<button
												className="loom-rel-filter"
												aria-label={t('view.entity.script.focusToolbar')}
												onClick={() =>
													actScriptTabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
												}
											>
												<Icon name="focus" />
											</button>
											{actScriptMode !== 'outline' ? (
												<>
											<div className="loom-search-wrap">
												<input
													className="loom-writer-search"
													type="search"
													placeholder={t('view.entity.script.searchThisAct')}
													value={actScriptQuery}
													onChange={(e) => {
														setActScriptQuery(e.target.value);
														setActScriptMatchIndex(0);
													}}
													onKeyDown={(e) => {
														if (e.key !== 'Enter') return;
														e.preventDefault();
														gotoActMatch(
															e.shiftKey ? actScriptMatchIndex - 1 : actScriptMatchIndex + 1
														);
													}}
												/>
												{actScriptQuery !== '' ? (
													<button
														className="loom-chip-remove loom-search-clear"
														aria-label={t('view.entity.script.clearSearch')}
														onClick={() => {
															setActScriptQuery('');
															setActScriptMatchIndex(0);
														}}
													>
														✕
													</button>
												) : null}
											</div>
											<button
												className="loom-rel-filter"
												aria-label={t('view.entity.script.previousMatch')}
												disabled={actMatches.length === 0}
												onClick={() => gotoActMatch(actScriptMatchIndex - 1)}
											>
												<Icon name="chevron-up" />
											</button>
											<button
												className="loom-rel-filter"
												aria-label={t('view.entity.script.nextMatch')}
												disabled={actMatches.length === 0}
												onClick={() => gotoActMatch(actScriptMatchIndex + 1)}
											>
												<Icon name="chevron-down" />
											</button>
											</>
											) : null}
											<div className="loom-script-side-toggles">
												<button
													className={
														actCommentsPanelOpen ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'
													}
													aria-label={actCommentsPanelOpen ? t('view.entity.script.hideComments') : t('view.entity.script.browseComments')}
													onClick={() => openActSidePanel(actCommentsPanelOpen ? null : 'comments')}
												>
													<Icon name="message-square" />
												</button>
												<button
													className={actAltPanelOpen ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
													aria-label={actAltPanelOpen ? t('view.entity.script.hideAlternatives') : t('view.entity.script.browseAlternatives')}
													onClick={() => openActSidePanel(actAltPanelOpen ? null : 'alt')}
												>
													<Icon name="repeat" fallback="arrow-right-left" />
												</button>
											</div>
											{actScriptMode !== 'outline' ? (
												<span className="loom-writer-stat">
													{actScriptQuery.trim() === ''
														? ''
														: actMatches.length === 0
															? t('view.entity.script.noMatches')
															: t('view.entity.script.matchCount', { current: (actScriptMatchIndex % actMatches.length) + 1, total: actMatches.length })}
												</span>
											) : null}
											<div className="loom-shell-spacer" />
											{/* Deliberately NOT part of the pill Script-mode Act's own
											    Script/Pages toggle used to be — same reasoning as the
											    main Script view's own standalone Outline button
											    (`.loom-writer-outline-btn`). */}
											<button
												className={
													actScriptMode === 'outline'
														? 'loom-writer-outline-btn loom-seg-on'
														: 'loom-writer-outline-btn'
												}
												onClick={() => clickActTab('outline')}
											>
												{t('view.entity.script.outline')}
											</button>
											{actScriptMode !== 'pages' ? (
												<button
													className="loom-rel-add"
													onClick={() => {
														if (!project) return;
														new CreateEntityModal(plugin, 'scene', project, { defaultAct: record }).open();
													}}
												>
													{t('view.entity.script.newSceneAction')}
												</button>
											) : null}
										</div>
										{actScriptMode !== 'outline' ? (
											<div className="loom-screenplay loom-scene-pages" ref={actScriptPagesRef}>
												{actNavPanel}
												{actCommentsAside}
												{actAltAside}
												{actScenes.length === 0 ? (
													<div className="loom-attendance-empty">
														{t('view.entity.script.noScenesYetPre')}<code># {record.name}</code>{t('view.entity.script.noScenesYetPost')}
													</div>
												) : (
													<PagesPreviewBody
														pages={actBodyPages}
														startPageNumber={null}
														query={actScriptQuery}
														rawText={actExcerpt}
														comments={scriptNotes.comments}
														altText={scriptNotes.altText}
														onOpenComment={handleOpenComment}
														onCycleAlt={handleCycleAlt}
														onOpenAltMenu={handleOpenAltMenu}
														onOpenScene={openThisSceneFromAct}
														highlightedAnnotationId={highlightedAnnotationId}
													/>
												)}
											</div>
										) : (
											<div
												className={
													seqDrag?.group === 'act-scenes'
														? 'loom-subloc-list loom-subloc-dragging loom-writer-outline'
														: 'loom-subloc-list loom-writer-outline'
												}
											>
												{actScenes.length === 0 ? (
													<div className="loom-attendance-empty">
														{t('view.entity.script.noScenesYetPre')}<code># {record.name}</code>{t('view.entity.script.noScenesYetPost')}
													</div>
												) : (
													actScenes.map((sc, i) => {
														const grabbed = seqDrag?.group === 'act-scenes' && seqDrag.from === i;
														return (
															<div
																key={sc.path}
																className={
																	grabbed
																		? 'loom-writer-outline-row loom-subloc-row-slide loom-subloc-row-dragging'
																		: 'loom-writer-outline-row loom-subloc-row-slide'
																}
																style={seqRowStyle('act-scenes', i)}
																data-seq-row=""
															>
																{seqGrip('act-scenes', i, actScenes, (reordered) => {
																	if (!project) return;
																	void editScriptAndSync(plugin, project, (raw) =>
																		reorderScenesInSection(
																			raw,
																			record.actId,
																			reordered.map((r) => r.sceneId)
																		)
																	);
																})}
																<span className="loom-writer-row-num">{i + 1}</span>
																<button className="loom-subloc-link" onClick={() => view.openEntity(sc.path)}>
																	{actExcerptParsed?.scenes[i]?.heading ?? sc.name}
																</button>
																<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
																<span className="loom-writer-row-count">{t('view.entity.script.pageAbbrev', { range: actScenePageRange(i) })}</span>
															</div>
														);
													})
												)}
											</div>
										)}
									</>
								);
							})()
						: (
							<div className="loom-attendance-empty">{t('view.entity.script.actNotInScript')}</div>
						)}
				</div>
			) : record.type === 'act' && bookMode && project ? (
				<div className="loom-field loom-field-sep">
					<div className="loom-writer-tabs" ref={actBookTabsRef}>
						<button
							className="loom-rel-filter"
							aria-label={t('view.entity.script.focusToolbar')}
							onClick={() => actBookTabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
						>
							<Icon name="focus" />
						</button>
						{actBookMode !== 'outline' ? (
							<input
								type="search"
								className="loom-writer-search"
								placeholder={t('project.common.searchPlaceholder')}
								value={actBookQuery}
								onChange={(e) => setActBookQuery(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') {
										(window as unknown as { find?: (s: string) => boolean }).find?.(actBookQuery);
									}
								}}
							/>
						) : null}
						<div className="loom-script-side-toggles">
							<button
								className={
									actBookSidePanel === 'comments' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'
								}
								aria-label={
									actBookSidePanel === 'comments'
										? t('view.entity.script.hideComments')
										: t('view.entity.script.browseComments')
								}
								onClick={() => setActBookSidePanel(actBookSidePanel === 'comments' ? null : 'comments')}
							>
								<Icon name="message-square" />
							</button>
							<button
								className={actBookSidePanel === 'alt' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
								aria-label={
									actBookSidePanel === 'alt'
										? t('view.entity.script.hideAlternatives')
										: t('view.entity.script.browseAlternatives')
								}
								onClick={() => setActBookSidePanel(actBookSidePanel === 'alt' ? null : 'alt')}
							>
								<Icon name="repeat" fallback="arrow-right-left" />
							</button>
						</div>
						<div className="loom-shell-spacer" />
						{/* Deliberately NOT part of the pill Book's own Editor/Preview
						    toggle used to be — same reasoning as Script-mode Act's own
						    standalone Outline button. */}
						<button
							className={actBookMode === 'outline' ? 'loom-writer-outline-btn loom-seg-on' : 'loom-writer-outline-btn'}
							onClick={() => clickActBookTab('outline')}
						>
							{t('view.entity.script.outline')}
						</button>
					</div>
					{actBookMode === 'outline' ? (
						<div
							className={
								seqDrag?.group === 'act-chapters'
									? 'loom-subloc-list loom-subloc-dragging loom-writer-outline'
									: 'loom-subloc-list loom-writer-outline'
							}
						>
							{actChapters.length === 0 ? (
								<div className="loom-attendance-empty">
									{t('view.entity.script.noChaptersYetPre')}<code># {record.name}</code>{t('view.entity.script.noChaptersYetPost')}
								</div>
							) : (
								actChapters.map((ch, i) => {
									const grabbed = seqDrag?.group === 'act-chapters' && seqDrag.from === i;
									return (
										<div
											key={ch.path}
											className={
												grabbed
													? 'loom-writer-outline-row loom-subloc-row-slide loom-subloc-row-dragging'
													: 'loom-writer-outline-row loom-subloc-row-slide'
											}
											style={seqRowStyle('act-chapters', i)}
											data-seq-row=""
										>
											{seqGrip('act-chapters', i, actChapters, (reordered) => {
												queueActBookEdit((raw) =>
													reorderBookChaptersInAct(raw, record.actId, reordered.map((r) => r.chapterId))
												);
											})}
											<span className="loom-writer-row-num">{i + 1}</span>
											<button className="loom-subloc-link" onClick={() => view.openEntity(ch.path)}>
												{ch.name}
											</button>
											<span className="loom-writer-outline-leader loom-writer-outline-leader-dashed" aria-hidden="true" />
										</div>
									);
								})
							)}
						</div>
					) : (
						// Same fixed-height (non-resizable) treatment Script-mode's own
						// embedded Act/Scene sections use (`.loom-scene-pages`) — a
						// nested page section, not the main BookView.
						<div className="loom-screenplay loom-scene-pages" ref={actBookPreviewWrapRef}>
							{actBookSidePanel === 'comments' ? (
								<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
									<CommentsBrowserPanel
										rows={actUnresolvedCommentRowsList}
										onJump={jumpToActBookAnnotation}
										onClose={() => setActBookSidePanel(null)}
									/>
								</div>
							) : null}
							{actBookSidePanel === 'alt' ? (
								<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
									<AlternativesBrowserPanel
										rows={actUndecidedAltRowsList}
										onJump={jumpToActBookAnnotation}
										onClose={() => setActBookSidePanel(null)}
									/>
								</div>
							) : null}
							<div className="loom-book-page">
								<ActChapterBlocks
									plugin={plugin}
									bookText={bookText}
									chapters={actChapters}
									names={linkNames}
									linkLabels={linkLabels}
									onOpenLink={openLinkTarget}
									emptyMessage={
										<div className="loom-attendance-empty">
											{t('view.entity.script.noChaptersYetPre')}<code># {record.name}</code>{t('view.entity.script.noChaptersYetPost')}
										</div>
									}
									annotations={bookAnnotations}
									onOpenChapter={openThisChapterFromAct}
								/>
							</div>
						</div>
					)}
				</div>
			) : null}

			{isSession && !scriptMode && project ? (
				(() => {
					const hubTypes = ENTITY_TYPES.filter((et) => hubEntries.some((e) => e.owner.type === et));
					// One group whose type is already the section's own label
					// (in practice always just Events, since quests no longer
					// author session notes) — printing that type's own group
					// label too would just repeat "Events" underneath "Events".
					// A future second type sharing this hub would still get its
					// own label, same as today.
					const showGroupLabel = hubTypes.length > 1 || (hubTypes.length === 1 && hubTypes[0] !== beatType);
					const addEventBtn = (ref?: (el: HTMLButtonElement | null) => void) => (
						<button
							ref={ref}
							className="loom-rel-add"
							onClick={() =>
								new CreateEntityModal(plugin, beatType, project, {
									noteSession: record,
									onCreated: () => {},
								}).open()
							}
						>
							+ {t('view.list.addBeatTitle', { article: /^[aeiou]/.test(beatLabel) ? 'an' : 'a', beat: beatLabel })}
						</button>
					);
					return (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">{entityPlural(beatType)}</span>
							{/* Creation first, as always. The modal's Name field searches
							    existing beats — picking one pins it here instead of
							    creating a duplicate. */}
							<div className="loom-hub-add-row">{addEventBtn((el) => (topAddEventBtnRef.current = el))}</div>
							{hubTypes.map((et) => {
								const entries = hubEntries.filter((e) => e.owner.type === et);
								// Event and quest notes are drag-reorderable by loomSeq (events
								// share it with the timeline); other hub groups keep note order.
								if (roleOf(et) !== 'beat' && et !== 'quest') {
									return (
										<div key={et} className="loom-hub-section">
											{showGroupLabel ? <span className="loom-rel-group-label">{entityPlural(et)}</span> : null}
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
										key={et}
										className={
											seqDrag?.group === et ? 'loom-hub-section loom-subloc-dragging' : 'loom-hub-section'
										}
									>
										{showGroupLabel ? <span className="loom-rel-group-label">{entityPlural(et)}</span> : null}
										{ordered.map((en, i) =>
											hubEntryRow(
												en,
												seqGrip(et, i, owners),
												seqRowStyle(et, i),
												seqDrag?.group === et && seqDrag.from === i,
												i
											)
										)}
									</div>
								);
							})}
							{/* Mirrors the top button once it's scrolled out of view — added
							    so recording events live doesn't mean scrolling back up for
							    every one; hidden while the top button is still visible so
							    the two are never both on screen at once. */}
							{hubEntries.length > 0 && !topAddEventBtnVisible ? (
								<div className="loom-hub-add-row">{addEventBtn()}</div>
							) : null}
						</div>
					);
				})()
			) : null}


			{allTags.length > 0 ? (
				<div className="loom-field">
					<span className="loom-field-label">{t('view.entity.common.tags')}</span>
					<div className="loom-tag-row">
						{allTags.map((tag) => (
							<button
								key={tag}
								className={record.loomTags.includes(tag) ? 'loom-chip loom-chip-on' : 'loom-chip'}
								onClick={() => toggleTag(tag)}
							>
								{record.type === 'quest' ? t(`settings.entities.questTagNames.${tag}` as LocaleKey) : tag}
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
										names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
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
											placeholder={t('view.entity.quests.finishedOn')}
											options={questAnchorsSorted.map((s) => ({
												value: linkTargetOf(s),
												label: recordLabel(s, project),
											}))}
											onPick={(name) => commitSet(idx, { finishedOn: name })}
											action={
												project
													? {
															label: t('project.createEntity.createNewAction', {
																label: entityLabel(questAnchorType),
															}),
															onPick: () =>
																new CreateEntityModal(plugin, questAnchorType, project, {
																	onCreated: (created) => commitSet(idx, { finishedOn: created.basename }),
																}).open(),
														}
													: undefined
											}
										/>
									)}
								</div>
								<button
									className="loom-nav-btn loom-obj-remove"
									aria-label={t('view.entity.quests.removeObjective')}
									onClick={() => del(idx)}
								>
									✕
								</button>
							</div>
						);
					};
					return (
						<div className="loom-field loom-field-sep">
							<span className="loom-field-label">{t('view.entity.quests.objectives')}</span>
							<div className="loom-hub-add-row">
								<button
									className="loom-rel-add"
									onClick={() => setObjectives([...objectives, { name: '', finishedOn: '' }])}
								>
									+ {t('view.entity.quests.addObjective')}
								</button>
							</div>
							<div className="loom-obj-section">
								<span className="loom-rel-group-label">
									{t('view.list.active')}<span className="loom-section-count">{active.length}</span>
								</span>
								<div className={objDrag ? 'loom-obj-list loom-subloc-dragging' : 'loom-obj-list'}>
									{active.map((r, i) =>
										objectiveRow(
											r.idx,
											objGrip(i, activeDrafts, resolvedDrafts),
											objRowStyle(i),
											objDrag?.from === i
										)
									)}
								</div>
							</div>
							{resolved.length > 0 ? (
								<div className="loom-obj-section">
									<span className="loom-rel-group-label">
										{t('view.entity.quests.resolvedHeading')}<span className="loom-section-count">{resolved.length}</span>
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
					<span className="loom-field-label">{t('view.entity.faction.members')}</span>
					<SearchableSelect
						placeholder={t('view.list.addMember') + '…'}
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
										label: t('project.createEntity.createNewAction', { label: entityLabel('character') }),
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
									removeLabel={t('view.entity.faction.removeMember')}
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{record.type === 'character' ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">{membershipRows.length > 1 ? entityPlural('faction') : entityLabel('faction')}</span>
					{factionDraft ? (
						<div className="loom-rel-row loom-member-row">
							<SearchableSelect
								placeholder={t('view.list.pickFaction')}
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
								action={
									project
										? {
												label: t('project.createEntity.createNewAction', { label: entityLabel('faction') }),
												onPick: () =>
													new CreateEntityModal(plugin, 'faction', project, {
														onCreated: (created) => {
															// A fresh faction's `EntityRecord` isn't indexed yet the
															// instant `onCreated` fires — `editFmList` only needs the
															// file's own PATH, so it writes straight through the
															// `TFile` without waiting on the index at all.
															editFmList(created.path, FM.members, (arr) => [...arr, `[[${linkTargetOf(record)}]]`]);
															setFactionDraft(false);
														},
													}).open(),
											}
										: undefined
								}
							/>
							<button
								className="loom-nav-btn"
								aria-label={t('view.entity.faction.cancelAddingFaction')}
								onClick={() => setFactionDraft(false)}
							>
								✕
							</button>
						</div>
					) : (
						<button className="loom-rel-add loom-faction-add" onClick={() => setFactionDraft(true)}>
							+ {t('view.list.addFaction')}
						</button>
					)}
					{membershipRows.map((m) => (
						<div key={m.faction.path + ':' + m.role} className="loom-rel-row loom-member-row">
							<input
								type="text"
								className="loom-rel-type"
								placeholder={t('project.createEntity.memberPlaceholder')}
								defaultValue={m.role}
								onBlur={(e) => {
									if (e.target.value.trim() !== m.role)
										setMembershipField(m.faction, { role: e.target.value });
								}}
							/>
							<span className="loom-member-sep">{t('project.createEntity.ofLabel')}</span>
							<EntityChip
								plugin={plugin}
								record={m.faction}
								onOpen={() => view.openEntity(m.faction.path)}
							/>
							<span className="loom-member-sep">{t('project.createEntity.atLabel')}</span>
							<div className="loom-member-loc">
								{m.location ? (
									<EntityChip
										plugin={plugin}
										record={m.location}
										onOpen={() => m.location && view.openEntity(m.location.path)}
										onRemove={() => setMembershipField(m.faction, { location: null })}
										removeLabel={t('view.entity.faction.clearLocation')}
									/>
								) : (
									<SearchableSelect
										placeholder={t('common.notSpecified')}
										options={membershipLocations
											.slice()
											.sort((a, b) => a.name.localeCompare(b.name))
											.map((l) => ({ value: linkTargetOf(l), label: locationLabel(l, plugin) }))}
										onPick={(name) => setMembershipField(m.faction, { location: name })}
										action={
											project
												? {
														label: t('project.createEntity.createNewAction', { label: entityLabel('location') }),
														onPick: () =>
															new CreateEntityModal(plugin, 'location', project, {
																onCreated: (created) =>
																	setMembershipField(m.faction, { location: created.basename }),
															}).open(),
													}
												: undefined
										}
									/>
								)}
							</div>
							<button
								className="loom-nav-btn"
								aria-label={t('view.entity.faction.removeMembership')}
								onClick={() =>
									new ConfirmModal(
										plugin.app,
										t('view.entity.faction.removeMembershipTitle'),
										t('view.entity.faction.removeMembershipDetail', { name: record.name, faction: m.faction.name }),
										() => removeMemberEntry(m.faction, record),
										t('common.remove')
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

			{/* Acts render this same section right after Display title
			    instead (up near the Title fields) — see below. */}
			{!isSession ? (
<div className="loom-field loom-field-body">
				<span className="loom-field-label">{t('project.notes')}</span>
				<MarkdownField
					app={plugin.app}
					value={body ?? ''}
					names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
					onOpenLink={openLinkTarget}
					onCreateEntity={createLinkEntity}
					placeholder={t('view.entity.common.notesPlaceholder')}
					onChange={(v) => {
						setBody(v);
						saveBody(v);
					}}
				/>
			</div>
			) : null}

			{/* Event planning (GM projects only): status pill, Improvised tick,
			    Decision Point field, and Special Conditions builder, laid out
			    two columns wide — status/decision-point on the left, conditions
			    on the right, since a GM page has the width to spare here and
			    conditions can otherwise run long. Sits above Session notes (the
			    isBeat branch right below) since a GM reads planning state before
			    anything narrative. See ROADMAP.md's "Game Master" entry. */}
			{isEvent && kindFeatures.eventPlanning ? (
				<div className="loom-field loom-field-sep">
					<div className="loom-event-planning-row">
						<div className="loom-event-planning-col">
							<span className="loom-field-label">{t('view.entity.event.statusLabel')}</span>
							{record.eventKind === 'locked' ? (
								<div className="loom-event-status-locked">
									<span className="loom-chip loom-chip-locked">{t('view.entity.event.statusLocked')}</span>
									{record.eventLockReasons.length > 0 ? (
										<ul className="loom-event-lock-reasons">
											{record.eventLockReasons.map((reason, i) => (
												<li key={i}>{lockReasonLabel(reason)}</li>
											))}
										</ul>
									) : null}
								</div>
							) : (
								<div className="loom-seg">
									{(['planned', 'happened', 'lore'] as const).map((k) => (
										<button
											key={k}
											className={
												record.eventKind === k || (record.eventKind === '' && k === 'planned')
													? 'loom-seg-btn loom-seg-on'
													: 'loom-seg-btn'
											}
											onClick={() => setEventStatus(k)}
										>
											{t(
												`view.entity.event.status${k.charAt(0).toUpperCase()}${k.slice(1)}` as LocaleKey
											)}
										</button>
									))}
								</div>
							)}
							<div className="loom-check-with-info">
								<label className="loom-check">
									<input
										type="checkbox"
										checked={record.improvised}
										onChange={(e) => setImprovised(e.target.checked)}
									/>
									{t('view.entity.event.improvisedLabel')}
								</label>
								<InfoIcon text={t('view.entity.event.improvisedTooltip')} />
							</div>
							{record.eventKind !== 'lore' ? (
								<div className="loom-event-planning-sub">
									<span className="loom-field-label">{t('view.entity.event.decisionPointLabel')}</span>
									<div className="loom-region-pick">
										{currentDecisionPoint ? (
											<EntityChip
												plugin={plugin}
												record={currentDecisionPoint}
												onOpen={() => view.openEntity(currentDecisionPoint.path)}
												onRemove={() => setEventDecisionPoint(null)}
												removeLabel={t('view.entity.event.clearDecisionPoint')}
											/>
										) : (
											<SearchableSelect
												placeholder={t('view.entity.event.pickDecisionPointPlaceholder')}
												options={decisionPoints
													.map((r) => ({ value: linkTargetOf(r), label: r.name }))
													.sort((a, b) => a.label.localeCompare(b.label))}
												action={
													project
														? {
																label: t('project.createEntity.createNewAction', { label: entityLabel('decisionPoint') }),
																onPick: () =>
																	new CreateEntityModal(plugin, 'decisionPoint', project, {
																		onCreated: (created) => setEventDecisionPoint(created.basename),
																	}).open(),
															}
														: undefined
												}
												onPick={(target) => setEventDecisionPoint(target)}
											/>
										)}
									</div>
								</div>
							) : null}
						</div>
						{record.eventKind !== 'lore' ? (
							<div className="loom-event-planning-col">
								<span className="loom-field-label">{t('view.entity.event.specialConditionsLabel')}</span>
								{specialConditions.map((group, gi) => (
									<div key={gi}>
										{gi > 0 ? <div className="loom-cond-or-divider">{t('view.entity.event.orDivider')}</div> : null}
										<div className="loom-cond-box">
											{group.conditions.map((cond, ci) => {
												const picker = conditionPickerFor(cond.type);
												const targetRec =
													cond.target !== '' ? plugin.indexer.resolve(cond.target, record.path) : null;
												return (
													<div key={ci} className="loom-cond-row">
														<span className="loom-cond-type">{conditionTypeLabel(cond.type)}</span>
														{targetRec ? (
															<EntityChip
																plugin={plugin}
																record={targetRec}
																onOpen={() => view.openEntity(targetRec.path)}
																onRemove={() => {
																	const next = specialConditions
																		.map((g, i) =>
																			i !== gi ? g : { conditions: g.conditions.filter((_, j) => j !== ci) }
																		)
																		.filter((g) => g.conditions.length > 0);
																	commitSpecialConditions(next);
																}}
																removeLabel={t('view.entity.event.removeCondition')}
															/>
														) : (
															<>
																<SearchableSelect
																	key={`${gi}:${ci}:${cond.target}`}
																	placeholder={picker.placeholder}
																options={picker.list
																	.map((r) => ({ value: linkTargetOf(r), label: r.name }))
																	.sort((a, b) => a.label.localeCompare(b.label))}
																action={
																	project
																		? {
																				label: t('project.createEntity.createNewAction', {
																					label: entityLabel(conditionTargetType(cond.type)),
																				}),
																				onPick: () =>
																					new CreateEntityModal(
																						plugin,
																						conditionTargetType(cond.type),
																						project,
																						{
																							onCreated: (created) => {
																								const next = specialConditions.map((g, i) =>
																									i !== gi
																										? g
																										: {
																												conditions: g.conditions.map((c, j) =>
																													j !== ci
																														? c
																														: { ...c, target: created.basename }
																												),
																											}
																								);
																								commitSpecialConditions(next);
																							},
																						}
																					).open(),
																			}
																		: undefined
																}
																onPick={(target) => {
																	const next = specialConditions.map((g, i) =>
																		i !== gi
																			? g
																			: {
																					conditions: g.conditions.map((c, j) =>
																						j !== ci ? c : { ...c, target }
																					),
																				}
																	);
																	commitSpecialConditions(next);
																}}
															/>
															{/* No target picked yet — nothing to attach the EntityChip's
															    own remove ✕ to, so this row still needs a standalone
															    one to drop the row outright. */}
															<button
																className="loom-rel-filter"
																aria-label={t('view.entity.event.removeCondition')}
																onClick={() => {
																	const next = specialConditions
																		.map((g, i) =>
																			i !== gi ? g : { conditions: g.conditions.filter((_, j) => j !== ci) }
																		)
																		.filter((g) => g.conditions.length > 0);
																	commitSpecialConditions(next);
																}}
															>
																<Icon name="x" />
															</button>
														</>
													)}
												</div>
											);
										})}
											<button
												className="loom-hub-add-row"
												onClick={(e) =>
													openConditionTypeMenu(e, (type) => {
														const next = specialConditions.map((g, i) =>
															i !== gi ? g : { conditions: [...g.conditions, { type, target: '' }] }
														);
														commitSpecialConditions(next);
													})
												}
											>
												{t('view.entity.event.addConditionAction')}
											</button>
										</div>
									</div>
								))}
								<button
									className="loom-hub-add-row"
									onClick={(e) =>
										openConditionTypeMenu(e, (type) =>
											commitSpecialConditions([...specialConditions, { conditions: [{ type, target: '' }] }])
										)
									}
								>
									{specialConditions.length === 0
										? t('view.entity.event.addConditionAction')
										: t('view.entity.event.addAlternativeSetAction')}
								</button>
							</div>
						) : null}
					</div>
				</div>
			) : null}

			{isBeat && scriptMode ? (
				<>
					{/* Mandatory, and re-assignable. Moving is two steps, since a
					    single dropdown pick can't say WHERE in the target act
					    the scene should land: (1) pick the act, (2) drag the
					    scene into position among that act's existing scenes.
					    Either step physically moves the writing in the script, so
					    the note's act link and the script can never drift
					    apart — an act link edited any other way would just be
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
								? 'loom-scene-act-grid loom-scene-act-grid-solo'
								: 'loom-scene-act-grid'
						}
					>
					<div className="loom-scene-act-left">
						<span className="loom-field-label">{entityLabel(anchorType)}</span>
						<div className="loom-tag-row">
							{sceneActRecord ? (
								<EntityChip
									plugin={plugin}
									record={sceneActRecord}
									onOpen={() => view.openEntity(sceneActRecord.path)}
								/>
							) : null}
							{moveTargetAct ? null : (
								<SearchableSelect
									placeholder={
										sceneActRecord
											? t('view.entity.scene.moveToAnother', { anchor: anchorLabel })
											: t('project.createEntity.pickAnchor', { anchor: anchorLabel })
									}
									options={plugin.indexer
										.getAll(anchorType, record.project)
										.filter((c) => c.path !== sceneActRecord?.path)
										.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created))
										.map((c) => ({ value: c.path, label: c.name }))}
									onPick={(path) => {
										const target = plugin.indexer.get(path);
										if (!target) return;
										setMoveTargetAct(target);
										setMovePlaceAt(0);
									}}
								/>
							)}
						</div>
						{sceneActRecord || moveTargetAct ? null : (
							<span className="loom-field-hint">
								{t('view.entity.scene.everySceneBelongsHint')}
							</span>
						)}
						{moveTargetAct && project
							? (() => {
									const siblings = plugin.indexer
										.getAll('scene', record.project)
										.filter(
											(sc) =>
												sc.path !== record.path &&
												sc.sceneAct !== '' &&
												plugin.indexer.resolve(sc.sceneAct, sc.path)?.path === moveTargetAct.path
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
												: moveSceneToSection(raw, record.sceneId, moveTargetAct.actId)
										).then(() => {
											setMoveTargetAct(null);
											setMovePlaceAt(0);
										});
									};
									return (
										<>
											<div className="loom-field-hint">
												{siblings.length === 0
													? t('view.entity.scene.actHasNoScenesYet', { name: moveTargetAct.name })
													: t('view.entity.scene.dragIntoPositionHint', { name: moveTargetAct.name })}
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
																			? 'loom-writer-outline-row loom-subloc-row-slide loom-subloc-row-dragging'
																			: 'loom-writer-outline-row loom-subloc-row-slide'
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
																	<span className="loom-writer-row-num">{i + 1}</span>
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
													{t('view.entity.scene.moveTheScene')}
												</button>
												<button
													className="loom-rel-filter"
													onClick={() => {
														setMoveTargetAct(null);
														setMovePlaceAt(0);
													}}
												>
													{t('project.common.cancel')}
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
						<div className="loom-scene-act-right">
							<span className="loom-field-label">{t('view.entity.scene.entitiesInScene')}</span>
							{(
								[
									['character', sceneCastRecords],
									['faction', sceneFactionRecords],
									['location', sceneMentionedLocationRecords],
									['item', sceneItemRecords],
								] as const
							).map(([type, records]) =>
								records.length === 0 ? null : (
									<div key={type} className="loom-scene-entity-group">
										<span className="loom-field-sublabel">{entityPlural(type)}</span>
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
						<span className="loom-field-label">{t('common.scriptLabel')}</span>
						{sceneExcerpt !== null
							? (() => {
									const sceneAnnotationSpans = findAnnotationSpans(sceneExcerpt);
									const sceneMatches: ScriptSearchMatch[] = [];
									if (sceneScriptQuery.trim() !== '') {
										const needle = sceneScriptQuery.toLowerCase();
										const hay = sceneDraft.toLowerCase();
										for (
											let at = hay.indexOf(needle);
											at !== -1;
											at = hay.indexOf(needle, at + needle.length)
										) {
											sceneMatches.push({ kind: 'text', offset: at });
										}
										for (const [id, entries] of Object.entries(scriptNotes.comments)) {
											if (entries.some((e) => e.text.toLowerCase().includes(needle))) sceneMatches.push({ kind: 'comment', id });
										}
										for (const [id, entry] of Object.entries(scriptNotes.altText)) {
											entry.options.forEach((opt, optionIndex) => {
												if (opt.toLowerCase().includes(needle)) sceneMatches.push({ kind: 'altOption', id, optionIndex });
											});
										}
										const posOf = (m: ScriptSearchMatch) =>
											m.kind === 'text' ? m.offset : (sceneAnnotationSpans.find((s) => s.id === m.id)?.from ?? Infinity);
										sceneMatches.sort((a, b) => posOf(a) - posOf(b));
									}
									const gotoSceneMatch = (index: number) => {
										if (sceneMatches.length === 0) return;
										const next = ((index % sceneMatches.length) + sceneMatches.length) % sceneMatches.length;
										setSceneScriptMatchIndex(next);
										const m = sceneMatches[next];
										if (m.kind === 'text') {
											setOpenComment(null);
											setHighlightedAnnotationId(null);
											if (sceneScriptMode === 'script') {
												sceneScriptEditorRef.current?.selectRange(m.offset, m.offset + sceneScriptQuery.length);
											} else {
												// Pages mode has no offset-to-page mapping to scroll by (this
												// excerpt isn't laid out against the whole document) — the
												// `<mark>`s render in the same reading order as the TEXT
												// matches, so the Nth text match is the Nth `<mark>` in the
												// DOM (comment/alt matches interleaved before it don't
												// render as a mark at all, so they're excluded from this
												// count); wait a frame for the highlight to actually be in
												// the DOM before finding it. Scrolled manually via scrollTop
												// rather than the mark's own `scrollIntoView`, which scrolls
												// EVERY scrollable ancestor needed to bring it into view —
												// including the whole entity page behind this one small
												// preview box, not just the box.
												const textIndex = sceneMatches.slice(0, next).filter((x) => x.kind === 'text').length;
												window.requestAnimationFrame(() => {
													const container = sceneScriptPagesRef.current;
													const mark = container?.querySelectorAll('mark')[textIndex];
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
											return;
										}
										const span = sceneAnnotationSpans.find((s) => s.id === m.id);
										if (!span) return;
										setHighlightedAnnotationId(m.kind === 'altOption' ? m.id : null);
										if (sceneScriptMode === 'script') {
											sceneScriptEditorRef.current?.selectRange(span.contentFrom, span.contentFrom);
											if (m.kind === 'comment') {
												window.requestAnimationFrame(() => {
													const icon = sceneScriptEditorWrapRef.current?.querySelector(
														`[data-loom-annotation-id="${m.id}"]`
													);
													if (icon instanceof HTMLElement) handleOpenComment(m.id, icon.getBoundingClientRect());
												});
											}
										} else {
											window.requestAnimationFrame(() => {
												const container = sceneScriptPagesRef.current;
												const icon = container?.querySelector(`[data-loom-annotation-id="${m.id}"]`);
												if (!container || !(icon instanceof HTMLElement)) return;
												scrollIntoContainer(container, icon, 'smooth');
												if (m.kind === 'comment') handleOpenComment(m.id, icon.getBoundingClientRect());
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
									/** Outline is a plain swap either direction, same reasoning
									 *  as the Act panel's own `switchActMode`. */
									const switchSceneMode = (next: 'script' | 'pages' | 'outline') => {
										if (next === sceneScriptMode) return;
										if (next === 'pages') {
											const topLine =
												sceneScriptMode === 'script' ? sceneScriptEditorRef.current?.getTopLine() : undefined;
											setSceneScriptMode('pages');
											if (topLine !== undefined) {
												const target = scenePageOfLine(topLine);
												window.requestAnimationFrame(() => {
													const container = sceneScriptPagesRef.current;
													const el = container?.querySelector(`[data-page="${target}"]`);
													if (container && el instanceof HTMLElement) {
														scrollIntoContainer(container, el, 'instant');
													}
												});
											}
										} else if (next === 'script' && sceneScriptMode === 'pages') {
											pendingSceneScrollLineRef.current = sceneLineOfPage(currentScenePage());
											setSceneScriptMode('script');
										} else {
											setSceneScriptMode(next);
										}
									};
									/** Same reasoning as the Act panel's own copy of this —
									 *  `findAnnotationSpans(sceneDraft)`, not `sceneExcerpt`, since
									 *  `sceneDraft` (heading stripped) is the EXACT text
									 *  `sceneScriptEditorRef`'s CM6 instance holds, so a span's
									 *  offsets already line up with `selectRange` directly. */
									const sceneAnnotationSpansAll = findAnnotationSpans(sceneDraft);
									const sceneUnresolvedCommentSpans = sceneAnnotationSpansAll
										.filter((s) => s.kind === 'comment')
										.map((s) => ({
											span: s,
											unresolvedEntries: (scriptNotes.comments[s.id] ?? []).filter((e) => !e.resolved),
										}))
										.filter((x) => x.unresolvedEntries.length > 0);
									const sceneUndecidedAltSpans = sceneAnnotationSpansAll.filter(
										(s) => s.kind === 'alt' && (scriptNotes.altText[s.id]?.acceptedIndex ?? null) === null
									);
									const sceneExcerptOf = (span: AnnotationSpan): string => {
										const raw = sceneDraft.slice(span.contentFrom, span.contentTo).replace(/\s+/g, ' ').trim();
										return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
									};
									const jumpToSceneAnnotation = (span: AnnotationSpan) => {
										openSceneSidePanel(null);
										if (sceneScriptMode === 'script') {
											sceneScriptEditorRef.current?.selectRange(span.contentFrom, span.contentTo);
										} else {
											pendingSceneSelectRangeRef.current = { from: span.contentFrom, to: span.contentTo };
											switchSceneMode('script');
										}
									};
									const sceneCommentsAside = sceneCommentsPanelOpen ? (
										<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
											<aside className="loom-script-nav">
												<div className="loom-script-nav-head">
													{t('view.entity.script.unresolvedComments')}
													<button
														className="loom-rel-filter"
														aria-label={t('view.entity.script.hideComments')}
														onClick={() => setSceneCommentsPanelOpen(false)}
													>
														<Icon name="chevron-left" />
													</button>
												</div>
												{sceneUnresolvedCommentSpans.length === 0 ? (
													<div className="loom-script-nav-empty">{t('view.entity.script.noUnresolvedComments')}</div>
												) : (
													sceneUnresolvedCommentSpans.map(({ span, unresolvedEntries }) => (
														<div key={span.id} className="loom-script-comments-panel-group">
															<button
																className="loom-script-nav-act loom-script-comments-panel-excerpt"
																onClick={() => jumpToSceneAnnotation(span)}
															>
																{sceneExcerptOf(span)}
															</button>
															<div className="loom-script-comments-panel-nested">
																{unresolvedEntries.map((entry) => (
																	<button
																		key={entry.id + entry.createdAt}
																		className="loom-script-comments-panel-reply"
																		onClick={() => jumpToSceneAnnotation(span)}
																	>
																		{entry.text.trim() === '' ? t('view.entity.script.emptyReply') : entry.text}
																	</button>
																))}
															</div>
														</div>
													))
												)}
											</aside>
										</div>
									) : null;
									const sceneAltAside = sceneAltPanelOpen ? (
										<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
											<aside className="loom-script-nav">
												<div className="loom-script-nav-head">
													{t('view.entity.script.unfinalizedAlternatives')}
													<button
														className="loom-rel-filter"
														aria-label={t('view.entity.script.hideAlternatives')}
														onClick={() => setSceneAltPanelOpen(false)}
													>
														<Icon name="chevron-left" />
													</button>
												</div>
												{sceneUndecidedAltSpans.length === 0 ? (
													<div className="loom-script-nav-empty">{t('view.entity.script.everyAlternativeAccepted')}</div>
												) : (
													sceneUndecidedAltSpans.map((span) => (
														<button
															key={span.id}
															className="loom-script-nav-act loom-script-comments-panel-excerpt"
															onClick={() => jumpToSceneAnnotation(span)}
														>
															{sceneExcerptOf(span)}
														</button>
													))
												)}
											</aside>
										</div>
									) : null;
									/** Same as the Act panel's `clickActTab` (switch first,
									 *  scroll on the next frame — see its comment for why). */
									const clickSceneTab = (next: 'script' | 'pages' | 'outline') => {
										switchSceneMode(next);
										window.requestAnimationFrame(() => {
											sceneScriptTabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
										});
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
													aria-label={sceneNavOpen ? t('view.entity.script.hideNavigation') : t('view.entity.script.showNavigation')}
													onClick={() => openSceneSidePanel(sceneNavOpen ? null : 'nav')}
												>
													<Icon name={sceneNavOpen ? 'panel-left-close' : 'panel-left-open'} fallback="list" />
												</button>
												{sceneNavOpen ? (
													<aside className="loom-script-nav">
														<div className="loom-script-nav-head">
															{t('view.entity.script.navigate')}
															<button
																className="loom-rel-filter"
																aria-label={t('view.entity.script.hideNavigation')}
																onClick={() => setSceneNavOpen(false)}
															>
																<Icon name="chevron-left" />
															</button>
														</div>
														{sceneNavTree.items.map((item) =>
															renderNavTreeItem(item, 1, (line) => {
																// Same fix as the Act panel's callback: back out the
																// scene's own start line before the body offset, or
																// every click lands at the end of the scene.
																const bodyLine =
																	line - (sceneNavScene?.line ?? 0) - sceneBodyLineOffset;
																if (sceneScriptMode === 'pages') {
																	// Scroll straight to the target's own rendered element
																	// (`data-line`), not just the page it's on — see the
																	// Act panel's identical callback for why (a page can
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
											<div className="loom-writer-tabs" ref={sceneScriptTabsRef}>
												<div className="loom-seg">
													<button
														className={
															sceneScriptMode === 'script' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'
														}
														onClick={() => clickSceneTab('script')}
													>
														{t('common.scriptLabel')}
													</button>
													<button
														className={
															sceneScriptMode === 'pages' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'
														}
														onClick={() => clickSceneTab('pages')}
													>
														{t('view.entity.script.pagesPreview')}
													</button>
												</div>
												{sceneScriptMode === 'outline' ? null : (
												<>
												<div className="loom-search-wrap">
													<input
														className="loom-writer-search"
														type="search"
														placeholder={t('view.entity.script.searchThisScene')}
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
															aria-label={t('view.entity.script.clearSearch')}
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
													aria-label={t('view.entity.script.previousMatch')}
													disabled={sceneMatches.length === 0}
													onClick={() => gotoSceneMatch(sceneScriptMatchIndex - 1)}
												>
													<Icon name="chevron-up" />
												</button>
												<button
													className="loom-rel-filter"
													aria-label={t('view.entity.script.nextMatch')}
													disabled={sceneMatches.length === 0}
													onClick={() => gotoSceneMatch(sceneScriptMatchIndex + 1)}
												>
													<Icon name="chevron-down" />
												</button>
												</>
												)}
												<div className="loom-script-side-toggles">
													<button
														className={
															sceneCommentsPanelOpen ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'
														}
														aria-label={sceneCommentsPanelOpen ? t('view.entity.script.hideComments') : t('view.entity.script.browseComments')}
														onClick={() => openSceneSidePanel(sceneCommentsPanelOpen ? null : 'comments')}
													>
														<Icon name="message-square" />
													</button>
													<button
														className={sceneAltPanelOpen ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
														aria-label={sceneAltPanelOpen ? t('view.entity.script.hideAlternatives') : t('view.entity.script.browseAlternatives')}
														onClick={() => openSceneSidePanel(sceneAltPanelOpen ? null : 'alt')}
													>
														<Icon name="repeat" fallback="arrow-right-left" />
													</button>
												</div>
												{sceneScriptMode === 'outline' ? null : (
													<span className="loom-writer-stat">
														{sceneScriptQuery.trim() === ''
															? ''
															: sceneMatches.length === 0
																? t('view.entity.script.noMatches')
																: t('view.entity.script.matchCount', { current: (sceneScriptMatchIndex % sceneMatches.length) + 1, total: sceneMatches.length })}
													</span>
												)}
												<div className="loom-shell-spacer" />
												{/* Deliberately NOT part of the Script/Pages pill —
												    same reasoning as the main Script view's own
												    standalone Outline button. */}
												<button
													className={
														sceneScriptMode === 'outline'
															? 'loom-writer-outline-btn loom-seg-on'
															: 'loom-writer-outline-btn'
													}
													onClick={() => clickSceneTab('outline')}
												>
													{t('view.entity.script.outline')}
												</button>
											</div>
											{sceneScriptMode === 'script' ? (
												<div className="loom-scene-script" ref={sceneScriptEditorWrapRef}>
													{sceneNavPanel}
													{sceneCommentsAside}
													{sceneAltAside}
													<FountainField
														ref={sceneScriptEditorRef}
														value={sceneDraft}
														onChange={setSceneBody}
														onBlur={() => {
															// Scroll-position memory — see the identical comment
															// on the Act page's own Script section above.
															const top = sceneScriptEditorRef.current?.getTopLine();
															if (top !== undefined) {
																window.localStorage.setItem(`loom-scene-script-line:${record.path}`, String(top));
															}
															if (!project || sceneDraft === sceneBodyOf(sceneExcerpt)) return;
															void editScriptAndSync(plugin, project, (raw) =>
																replaceSceneBody(raw, record.sceneId, sceneDraft)
															).then(() => setSceneBody(null));
														}}
														characters={scriptParsed?.characters ?? []}
														entityOptions={entityOptions}
														ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs}
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
														onOpenAct={() => {
															if (sceneActRecord) view.openEntity(sceneActRecord.path);
														}}
														onOpenEntity={(path) => view.openEntity(path)}
														comments={scriptNotes.comments}
														altText={scriptNotes.altText}
														onCreateComment={(id, text) =>
															handleCreateComment(sceneScriptEditorWrapRef, sceneScriptPagesRef, id, text)
														}
														onCreateAlt={handleCreateAlt}
														onOpenComment={handleOpenComment}
														onCycleAlt={handleCycleAlt}
														onOpenAltMenu={handleOpenAltMenu}
														highlightedAnnotationId={highlightedAnnotationId}
														onGeometryChange={() => setSceneScriptGeometryVersion((v) => v + 1)}
														onCreateBranch={handleCreateBranchDraft}
														onPasteBranchGroup={handlePasteBranchGroupInScene}
														branchClipboardAvailable={getBranchClipboard() !== null}
														// `BranchOverlay`'s own extra-height reservation
														// (`onSpacerNeedsChange` below) is only meaningful for
														// ITS OWN opaque cards — the embedded renderer's chrome
														// is all real document lines with no shortfall to
														// cover, so this is left unset whenever it's active.
														branchSpacers={EMBEDDED_BRANCH_CARDS_SPIKE ? undefined : sceneBranchSpacers}
														embeddedBranchCards={EMBEDDED_BRANCH_CARDS_SPIKE}
														onRenameBranchTitle={handleRenameBranchTitle}
														onSetBranchCombo={handleSetBranchCombo}
														onSetBranchRaw={handleSetBranchRaw}
														onDeleteBranch={handleDeleteBranchInScene}
														onAddBranch={(groupId) => void handleAddBranch(groupId)}
														pendingTitleFocusId={pendingBranchTitleFocusId}
														onTitleFocusConsumed={() => setPendingBranchTitleFocusId(null)}
													/>
													<BranchOverlay
														fieldRef={sceneScriptEditorRef}
														wrapRef={sceneScriptEditorWrapRef}
														text={sceneDraft}
														geometryVersion={sceneScriptGeometryVersion}
														drafts={branchDrafts}
														onDraftField={handleBranchDraftField}
														onDismissDraft={handleDismissBranchDraft}
														onCreateDraft={handleCommitBranchDraft}
														onRenameBranchTitle={handleRenameBranchTitle}
														onSetBranchCombo={handleSetBranchCombo}
														onSetBranchRaw={handleSetBranchRaw}
														onSetBranchBody={handleSetBranchBody}
														onAddBranch={(groupId) => void handleAddBranch(groupId)}
														pendingTitleFocusId={pendingBranchTitleFocusId}
														onTitleFocusConsumed={() => setPendingBranchTitleFocusId(null)}
														onCutBranchGroup={handleCutBranchGroupInScene}
														onCopyBranchGroup={handleCopyBranchGroupInScene}
														onDeleteBranch={handleDeleteBranchInScene}
														characters={scriptParsed?.characters ?? []}
														entityOptions={entityOptions}
														ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs}
														onSpacerNeedsChange={setSceneBranchSpacers}
														renderRealCards={!EMBEDDED_BRANCH_CARDS_SPIKE}
													/>
												</div>
											) : sceneScriptMode === 'pages' ? (
												<div className="loom-screenplay loom-scene-pages" ref={sceneScriptPagesRef}>
													{sceneNavPanel}
													{sceneCommentsAside}
													{sceneAltAside}
													<PagesPreviewBody
														pages={sceneBodyPages}
														startPageNumber={null}
														query={sceneScriptQuery}
														rawText={sceneExcerpt}
														comments={scriptNotes.comments}
														altText={scriptNotes.altText}
														onOpenComment={handleOpenComment}
														onCycleAlt={handleCycleAlt}
														onOpenAltMenu={handleOpenAltMenu}
														highlightedAnnotationId={highlightedAnnotationId}
													/>
												</div>
											) : (
												<div className="loom-subloc-list loom-writer-outline">
													{sceneOutlineTree && sceneOutlineTree.items.length > 0 ? (
														sceneOutlineTree.items.map((item) => renderSceneOutlineItem(item))
													) : (
														<div className="loom-attendance-empty">
															{t('view.entity.script.noBranchStructure')}
														</div>
													)}
												</div>
											)}
										</>
									);
								})()
							: (
								<div className="loom-attendance-empty">{t('view.entity.script.sceneNotInScript')}</div>
							)}
					</div>
				</>
			) : isBeat && bookMode && record.type === 'chapter' ? (
				<div className="loom-field loom-field-sep">
					{/* `.loom-scene-act-left`'s own `flex: 1 1 60%` is meant for a
					    HORIZONTAL two-column split inside `.loom-scene-act-grid` (the
					    Scene page's own usage, which has a right column) — without that
					    row-flex wrapper, that same rule flex-GREW this box vertically
					    inside the page's own column layout instead (`.loom-field` is a
					    column flex container), leaving a large blank gap below "Move to
					    another act…" before the tabs. The "solo" variant (no right
					    column) is exactly this case. */}
					<div
						className={
							chapterCastRecords.length +
								chapterFactionRecords.length +
								chapterMentionedLocationRecords.length +
								chapterItemRecords.length ===
							0
								? 'loom-scene-act-grid loom-scene-act-grid-solo'
								: 'loom-scene-act-grid'
						}
					>
						<div className="loom-scene-act-left">
							<span className="loom-field-label">{entityLabel(anchorType)}</span>
							<div className="loom-tag-row">
								{chapterActRecord ? (
									<EntityChip
										plugin={plugin}
										record={chapterActRecord}
										onOpen={() => view.openEntity(chapterActRecord.path)}
									/>
								) : null}
							</div>
							{project ? (
								<SearchableSelect
									placeholder={
										chapterActRecord
											? t('view.entity.scene.moveToAnother', { anchor: anchorLabel })
											: t('project.createEntity.pickAnchor', { anchor: anchorLabel })
									}
									options={plugin.indexer
										.getAll('act', record.project)
										.filter((a) => a.path !== chapterActRecord?.path)
										.sort((a, b) => (a.seq ?? a.created) - (b.seq ?? b.created))
										.map((a) => ({ value: a.path, label: a.name }))}
									onPick={(path) => {
										const target = plugin.indexer.get(path);
										if (!target || target.actId === '') return;
										void editBookAndSync(plugin, project, (raw) =>
											moveBookChapterToAct(raw, record.chapterId, target.actId)
										);
									}}
								/>
							) : null}
						</div>
						{chapterCastRecords.length +
							chapterFactionRecords.length +
							chapterMentionedLocationRecords.length +
							chapterItemRecords.length ===
						0 ? null : (
							<div className="loom-scene-act-right">
								<span className="loom-field-label">{t('view.entity.scene.entitiesInChapter')}</span>
								{(
									[
										['character', chapterCastRecords],
										['faction', chapterFactionRecords],
										['location', chapterMentionedLocationRecords],
										['item', chapterItemRecords],
									] as const
								).map(([type, records]) =>
									records.length === 0 ? null : (
										<div key={type} className="loom-scene-entity-group">
											<span className="loom-field-sublabel">{entityPlural(type)}</span>
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
					<div className="loom-writer-tabs" ref={chapterTabsRef}>
						<div className="loom-seg">
							<button
								className={chapterEditorMode === 'editor' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'}
								onClick={() => clickChapterTab('editor')}
							>
								{t('view.entity.script.editorLabel')}
							</button>
							<button
								className={chapterEditorMode === 'preview' ? 'loom-seg-btn loom-seg-on' : 'loom-seg-btn'}
								onClick={() => clickChapterTab('preview')}
							>
								{t('view.entity.script.pagesPreview')}
							</button>
						</div>
						<input
							type="search"
							className="loom-writer-search"
							placeholder={t('project.common.searchPlaceholder')}
							value={chapterSearchQuery}
							onChange={(e) => setChapterSearchQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
								// `window.find` is a real, long-standing Chromium/Gecko API
								// (Obsidian runs on Electron/Chromium) with no DOM lib typing.
								(window as unknown as { find?: (s: string) => boolean }).find?.(chapterSearchQuery);
							}
							}}
						/>
						<div className="loom-script-side-toggles">
							<button
								className={
									chapterSidePanel === 'comments' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'
								}
								aria-label={
									chapterSidePanel === 'comments'
										? t('view.entity.script.hideComments')
										: t('view.entity.script.browseComments')
								}
								onClick={() => setChapterSidePanel(chapterSidePanel === 'comments' ? null : 'comments')}
							>
								<Icon name="message-square" />
							</button>
							<button
								className={chapterSidePanel === 'alt' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
								aria-label={
									chapterSidePanel === 'alt'
										? t('view.entity.script.hideAlternatives')
										: t('view.entity.script.browseAlternatives')
								}
								onClick={() => setChapterSidePanel(chapterSidePanel === 'alt' ? null : 'alt')}
							>
								<Icon name="repeat" fallback="arrow-right-left" />
							</button>
						</div>
					</div>
					{chapterExcerpt !== null ? (
						chapterEditorMode === 'editor' ? (
							<div className="loom-scene-script">
								<MarkdownField
									ref={chapterEditorRef}
									app={plugin.app}
									value={chapterExcerpt}
									names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
									onOpenLink={openLinkTarget}
									onCreateEntity={createLinkEntity}
									onChange={(v) => {
										if (!project) return;
										void editBookAndSync(plugin, project, (raw) =>
											replaceBookChapterBody(raw, record.chapterId, v)
										);
									}}
									comments={bookAnnotations.comments}
									altText={bookAnnotations.altText}
									onCreateComment={bookAnnotations.handleCreateComment}
									onCreateAlt={bookAnnotations.handleCreateAlt}
									onOpenComment={bookAnnotations.handleOpenComment}
									onCycleAlt={bookAnnotations.handleCycleAlt}
									onOpenAltMenu={bookAnnotations.handleOpenAltMenu}
									annotationGutter
								/>
							</div>
						) : (
							<div className="loom-screenplay loom-scene-pages" ref={chapterPreviewWrapRef}>
								{chapterSidePanel === 'comments' ? (
									<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
										<CommentsBrowserPanel
											rows={chapterUnresolvedCommentRowsList}
											onJump={jumpToChapterAnnotation}
											onClose={() => setChapterSidePanel(null)}
										/>
									</div>
								) : null}
								{chapterSidePanel === 'alt' ? (
									<div className="loom-script-nav-sticky loom-script-nav-sticky-inset">
										<AlternativesBrowserPanel
											rows={chapterUndecidedAltRowsList}
											onJump={jumpToChapterAnnotation}
											onClose={() => setChapterSidePanel(null)}
										/>
									</div>
								) : null}
								<div className="loom-book-page">
									<MarkdownField
										app={plugin.app}
										value={chapterExcerpt}
										names={linkNames} linkLabels={linkLabels} ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs} ambientExcludeTarget={record ? linkTargetOf(record) : undefined}
										onOpenLink={openLinkTarget}
										readOnly
										plainLinks
										onChange={() => {}}
										comments={bookAnnotations.comments}
										altText={bookAnnotations.altText}
										onOpenComment={bookAnnotations.handleOpenComment}
										onCycleAlt={bookAnnotations.handleCycleAltReadOnly}
										onOpenAltMenu={bookAnnotations.handleOpenAltMenu}
										annotationGutter
									/>
								</div>
							</div>
						)
					) : (
						<div className="loom-attendance-empty">{t('view.entity.script.sceneNotInScript')}</div>
					)}
				</div>
			) : isBeat ? (
				<div className="loom-field loom-field-sep">
					{sessionNotes.length > 0 ? (
						<span className="loom-field-label">{t('view.entity.common.anchorNotes', { anchor: entityLabel(anchorType) })}</span>
					) : null}
					<div className="loom-hub-add-row">
						<button
							className="loom-rel-add"
							onClick={() => setSessionNotes([...sessionNotes, { session: '', text: '', places: [], involved: [], group: [], seq: Date.now(), idx: null }])}
						>
							+ {t('view.list.addAnchorNote', { anchor: anchorLabel })}
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
					<span className="loom-field-label">{entityPlural('character')}</span>
					<div className="loom-hub-add-row">
						<SearchableSelect
							placeholder={t('view.entity.items.addToCharacterPlaceholder')}
							options={plugin.indexer
								.getAll('character', project.root)
								.filter((c) => !holderCharacters.some((h) => h.path === c.path))
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((c) => ({ value: c.path, label: c.name }))}
							onPick={(path) => {
								const c = plugin.indexer.get(path);
								if (c) addItemToHolder(c);
							}}
							action={{
								label: t('project.createEntity.createNewAction', { label: entityLabel('character') }),
								onPick: () =>
									new CreateEntityModal(plugin, 'character', project, {
										onCreated: (f) => {
											// A fresh character isn't indexed yet the instant
											// `onCreated` fires — wait for it, same pattern the
											// Decision Point fields above use.
											void waitForMetadataSync(plugin.app, f).then(() => {
												const c = plugin.indexer.resolve(f.basename, project.loomPath);
												if (c) addItemToHolder(c);
											});
										},
									}).open(),
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
									removeLabel={t('view.entity.items.removeFromCharacter')}
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{showsItemHolders && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">{entityPlural('location')}</span>
					<div className="loom-hub-add-row">
						<SearchableSelect
							placeholder={t('view.entity.items.addToLocationPlaceholder')}
							options={plugin.indexer
								.getAll('location', project.root)
								.filter((l) => !holderLocations.some((h) => h.path === l.path))
								.sort((a, b) => locationLabel(a, plugin).localeCompare(locationLabel(b, plugin)))
								.map((l) => ({ value: l.path, label: locationLabel(l, plugin) }))}
							onPick={(path) => {
								const l = plugin.indexer.get(path);
								if (l) addItemToHolder(l);
							}}
							action={{
								label: t('project.createEntity.createNewAction', { label: entityLabel('location') }),
								onPick: () =>
									new CreateEntityModal(plugin, 'location', project, {
										onCreated: (f) => {
											void waitForMetadataSync(plugin.app, f).then(() => {
												const l = plugin.indexer.resolve(f.basename, project.loomPath);
												if (l) addItemToHolder(l);
											});
										},
									}).open(),
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
									removeLabel={t('view.entity.items.removeFromLocation')}
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
					<span className="loom-field-label">{entityPlural('faction')}</span>
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
					<span className="loom-field-label">{t('view.entity.location.sublocations')}</span>
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
							+ {t('project.createEntity.newSublocationTitle')}
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
										aria-label={t('view.entity.location.detachSublocation')}
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
					<span className="loom-field-label">{entityPlural('scene')}</span>
					{locationScenes.length > 0 ? (
						<div className="loom-subloc-list">
							{locationScenes.map((sc, i) => (
								<div key={sc.path} className="loom-writer-outline-row">
									<span className="loom-writer-row-num">{i + 1}</span>
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
							<span className="loom-field-sublabel">{t('view.entity.location.scenesInSublocations')}</span>
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
											<div key={sc.path} className="loom-writer-outline-row">
												<span className="loom-writer-row-num">{i + 1}</span>
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
					<span className="loom-field-label">{entityPlural('location')}</span>
					<div className="loom-hub-add-row">
						<SearchableSelect
							placeholder={t('view.entity.location.addLocationPlaceholder')}
							options={plugin.indexer
								.getAll('location', project.root)
								// Main locations only — a sublocation inherits its region
								// from its parent (see `currentRegion`'s own doc comment)
								// rather than ever being a direct region member itself.
								.filter((l) => l.parentLocation === null)
								.filter((l) => !regionLocations.some((m) => m.path === l.path))
								.sort((a, b) => locationLabel(a, plugin).localeCompare(locationLabel(b, plugin)))
								.map((l) => ({ value: linkTargetOf(l), label: locationLabel(l, plugin) }))}
							action={{
								label: t('project.createEntity.createNewAction', { label: entityLabel('location') }),
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
									removeLabel={t('view.entity.location.removeFromRegion')}
								/>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{/* Decision Point page: its own Session field — same picker shape as
			    an Event's own birth session. Changing it cascades onto every
			    member event's own session (see `cascadeDecisionPointSession`). */}
			{isDecisionPoint && project ? (
				<div className="loom-field">
					<span className="loom-field-label">{t('view.entity.decisionPoint.sessionLabel')}</span>
					<div className="loom-region-pick">
						{currentDpSession ? (
							<EntityChip
								plugin={plugin}
								record={currentDpSession}
								label={recordLabel(currentDpSession, project)}
								onOpen={() => view.openEntity(currentDpSession.path)}
								onRemove={() => setDecisionPointSession(null)}
								removeLabel={t('view.entity.decisionPoint.clearSession')}
							/>
						) : (
							<SearchableSelect
								placeholder={t('view.entity.decisionPoint.pickSessionPlaceholder')}
								options={sessions
									.slice()
									.sort((a, b) => (b.date?.sortKey ?? 0) - (a.date?.sortKey ?? 0))
									.map((s) => ({ value: linkTargetOf(s), label: recordLabel(s, project) }))}
								action={{
									label: t('project.createEntity.createNewAction', { label: entityLabel(anchorType) }),
									onPick: () =>
										new CreateEntityModal(plugin, anchorType, project, {
											onCreated: (created) => setDecisionPointSession(created.basename),
										}).open(),
								}}
								onPick={(target) => setDecisionPointSession(target)}
							/>
						)}
					</div>
				</div>
			) : null}

			{/* Decision Point page: its member events (an event's own "Decision
			    point" field points here) — mirrors Region's own Locations
			    section above exactly. */}
			{isDecisionPoint && project ? (
				<div className="loom-field loom-field-sep">
					<span className="loom-field-label">{entityPlural('event')}</span>
					<div className="loom-hub-add-row">
						<SearchableSelect
							placeholder={t('view.entity.decisionPoint.addEventPlaceholder')}
							options={plugin.indexer
								.getAll('event', project.root)
								.filter((e) => !decisionPointEvents.some((m) => m.path === e.path))
								.sort((a, b) => recordLabel(a, project).localeCompare(recordLabel(b, project)))
								.map((e) => ({ value: linkTargetOf(e), label: recordLabel(e, project) }))}
							action={{
								label: t('project.createEntity.createNewAction', { label: entityLabel('event') }),
								onPick: () =>
									new CreateEntityModal(plugin, 'event', project, {
										onCreated: (created) => addDecisionPointEvent(created.basename),
									}).open(),
							}}
							onPick={(target) => addDecisionPointEvent(target)}
						/>
					</div>
					{decisionPointEvents.length > 0 ? (
						<div className="loom-tag-row">
							{decisionPointEvents.map((e) => (
								<EntityChip
									key={e.path}
									plugin={plugin}
									record={e}
									label={recordLabel(e, project)}
									onOpen={() => view.openEntity(e.path)}
									onRemove={() => removeDecisionPointEvent(e)}
									removeLabel={t('view.entity.decisionPoint.removeFromDecisionPoint')}
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
				<span className="loom-field-label">{t('view.entity.relationships.sectionLabel')}</span>
				<button
					className="loom-rel-add"
					onClick={() => setRelationships([...relationships, { type: '', target: '' }])}
				>
					{t('project.addRelationship.title')}
				</button>
{ENTITY_TYPES.filter((et) => relEntries.some((e) => e.entityType === et)).map((et) => (
					<div key={et} className="loom-rel-group">
						<span className="loom-rel-group-label">{entityPlural(et)}</span>
						{relEntries.filter((e) => e.entityType === et).map((e) => relRow(e.rel, e.i))}
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
			{openComment ? (
				<CommentPopover
					anchorRect={openComment.rect}
					entries={scriptNotes.comments[openComment.id] ?? []}
					onSaveEntry={(index, text) => handleSaveCommentEntry(openComment.id, index, text)}
					onToggleResolvedEntry={(index) => handleToggleCommentResolved(openComment.id, index)}
					onDeleteEntry={(index) => handleDeleteCommentEntry(openComment.id, index)}
					onAddEntry={(text) => {
						commentsWithNewEntryRef.current.add(openComment.id);
						handleAddCommentReply(openComment.id, text);
					}}
					onClose={handleCloseComment}
				/>
			) : null}
			{bookAnnotations.openComment ? (
				<CommentPopover
					anchorRect={bookAnnotations.openComment.rect}
					entries={bookAnnotations.comments[bookAnnotations.openComment.id] ?? []}
					onSaveEntry={(index, text) =>
						bookAnnotations.handleSaveCommentEntry(bookAnnotations.openComment!.id, index, text)
					}
					onToggleResolvedEntry={(index) =>
						bookAnnotations.handleToggleCommentResolved(bookAnnotations.openComment!.id, index)
					}
					onDeleteEntry={(index) => bookAnnotations.handleDeleteCommentEntry(bookAnnotations.openComment!.id, index)}
					onAddEntry={(text) => bookAnnotations.handleAddCommentReply(bookAnnotations.openComment!.id, text)}
					onClose={bookAnnotations.handleCloseComment}
				/>
			) : null}
		</div>
	);
}
