import { setIcon, setTooltip } from 'obsidian';
import {
	CSSProperties,
	KeyboardEvent as ReactKeyboardEvent,
	ReactNode,
	RefObject,
	useEffect,
	useRef,
	useState,
} from 'react';
import {
	BOOK_ICON,
	ENTITY_META,
	EntityRecord,
	MAPS_ICON,
	SCRIPT_ICON,
	PC_GROUP_ICON,
	PC_GROUP_VALUE,
	VIEW_GRAPH,
	VIEW_GROUP,
	VIEW_LIST,
	VIEW_MAP,
	bookLabel,
	entityPlural,
	mapsLabel,
	scriptLabel,
} from '../types';
import { groupNameOf } from '../calendar';
import { features, projectRoleType, projectTypes } from '../project-kind';
import { createScriptFile } from './script-buffer';
import { createBookFile } from './book-view';
import { QUICK_NOTES_ICON, QuickNotesPanel, useQuickNotesToggle } from './quick-notes';
import { ProjectDef, linkTargetOf } from '../indexer';
import { LoomNavigator } from './react-view';
import type { LinkOption } from './markdown-field';
import { CreateEntityModal, EntityTypeSuggestModal } from '../project';
import { recordLabel } from '../display';
import { LocaleKey, t } from '../i18n';
import type LoomLoomPlugin from '../main';



/** Renders a Lucide icon by name. */
/**
 * Pointer-driven drag-reorder for a vertical list. Rows are siblings under one
 * parent, each carrying `rowAttr`; every row's center is snapshotted at grab
 * time and the target index is the count of centers the cursor has passed, so
 * rows of varying height work. Neighbours slide by the grabbed row's own height
 * + the 8px inter-card gap. `group` keys independent lists sharing one hook.
 */
export function useSeqDrag(rowAttr = 'data-seq-row') {
	const [drag, setDrag] = useState<{ group: string; from: number; over: number; dy: number } | null>(null);
	const dragRef = useRef<{ startY: number; slot: number; mids: number[] } | null>(null);
	const rowStyle = (group: string, i: number): CSSProperties | undefined => {
		if (!drag || drag.group !== group) return undefined;
		if (drag.from === i) return { transform: `translateY(${drag.dy}px)`, position: 'relative', zIndex: 2 };
		const slot = dragRef.current?.slot ?? 40;
		const { from, over } = drag;
		const sh = from < i && i <= over ? -1 : over <= i && i < from ? 1 : 0;
		return sh !== 0 ? { transform: `translateY(${sh * slot}px)` } : undefined;
	};
	const end = (group: string, commit: boolean, onDrop: (from: number, over: number) => void) => {
		dragRef.current = null;
		const d = drag;
		setDrag(null);
		if (commit && d && d.group === group && d.from !== d.over) onDrop(d.from, d.over);
	};
	/** The 6-dot grab handle; `fallbackHeight` sizes the slide if the row
	 *  element can't be found. */
	const grip = (
		group: string,
		i: number,
		length: number,
		onDrop: (from: number, over: number) => void,
		fallbackHeight = 40
	) => (
		<span
			className="loom-subloc-grip"
			onPointerDown={(e) => {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const rowEl = e.currentTarget.closest(`[${rowAttr}]`);
				const row = rowEl instanceof HTMLElement ? rowEl : null;
				const rows = row?.parentElement ? [...row.parentElement.querySelectorAll(`:scope > [${rowAttr}]`)] : [];
				const mids = rows.map((r) => {
					const b = r.getBoundingClientRect();
					return b.top + b.height / 2;
				});
				dragRef.current = { startY: e.clientY, slot: (row?.offsetHeight ?? fallbackHeight) + 8, mids };
				setDrag({ group, from: i, over: i, dy: 0 });
			}}
			onPointerMove={(e) => {
				const start = dragRef.current;
				if (!start) return;
				const dy = e.clientY - start.startY;
				const over = Math.max(0, Math.min(length - 1, start.mids.filter((m) => m < e.clientY).length));
				setDrag((cur) => (cur && cur.group === group && (cur.over !== over || cur.dy !== dy) ? { ...cur, over, dy } : cur));
			}}
			onPointerUp={() => end(group, true, onDrop)}
			onPointerCancel={() => end(group, false, onDrop)}
		>
			<Icon name="grip-vertical" />
		</span>
	);
	return { drag, rowStyle, grip };
}

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
	const next = [...list];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/** The writer views' search box (✕ clears) + previous/next match buttons.
 *  `onQuery` also gets '' on clear; `onEnter` runs on Enter. */
export function SearchNav({
	placeholder,
	query,
	onQuery,
	onEnter,
	matchCount,
	onPrev,
	onNext,
}: {
	placeholder: string;
	query: string;
	onQuery: (q: string) => void;
	onEnter: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
	matchCount: number;
	onPrev: () => void;
	onNext: () => void;
}) {
	return (
		<>
			<div className="loom-search-wrap">
				<input
					className="loom-writer-search"
					type="search"
					placeholder={placeholder}
					value={query}
					onChange={(e) => onQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') onEnter(e);
					}}
				/>
				{query !== '' ? (
					<button
						className="loom-chip-remove loom-search-clear"
						aria-label={t('view.entity.script.clearSearch')}
						onClick={() => onQuery('')}
					>
						✕
					</button>
				) : null}
			</div>
			<button
				className="loom-rel-filter"
				aria-label={t('view.entity.script.previousMatch')}
				disabled={matchCount === 0}
				onClick={onPrev}
			>
				<Icon name="chevron-up" />
			</button>
			<button
				className="loom-rel-filter"
				aria-label={t('view.entity.script.nextMatch')}
				disabled={matchCount === 0}
				onClick={onNext}
			>
				<Icon name="chevron-down" />
			</button>
		</>
	);
}

/** "3 of 7" / "No matches" beside a `SearchNav`; empty while there's no query. */
export function MatchStat({ query, count, index }: { query: string; count: number; index: number }) {
	return (
		<span className="loom-writer-stat">
			{query.trim() === ''
				? ''
				: count === 0
					? t('view.entity.script.noMatches')
					: t('view.entity.script.matchCount', { current: (index % count) + 1, total: count })}
		</span>
	);
}

/** The Comments / Alternatives browse-panel toggle pair. */
export function AnnotationPanelToggles({
	open,
	onToggle,
}: {
	open: 'comments' | 'alt' | null;
	onToggle: (next: 'comments' | 'alt' | null) => void;
}) {
	return (
		<div className="loom-script-side-toggles">
			<button
				className={open === 'comments' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
				aria-label={open === 'comments' ? t('view.entity.script.hideComments') : t('view.entity.script.browseComments')}
				onClick={() => onToggle(open === 'comments' ? null : 'comments')}
			>
				<Icon name="message-square" />
			</button>
			<button
				className={open === 'alt' ? 'loom-rel-filter loom-filter-active' : 'loom-rel-filter'}
				aria-label={open === 'alt' ? t('view.entity.script.hideAlternatives') : t('view.entity.script.browseAlternatives')}
				onClick={() => onToggle(open === 'alt' ? null : 'alt')}
			>
				<Icon name="repeat" />
			</button>
		</div>
	);
}

export function Icon({ name }: { name: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (ref.current) setIcon(ref.current, name);
	}, [name]);
	return <span className="loom-icon" ref={ref} />;
}

/** A small `info` glyph carrying an explanatory hover tooltip — Obsidian's own
 *  styled tooltip (`setTooltip`, same as every other tooltip in this codebase),
 *  never a raw `title=` attribute, which renders the browser's own unstyled
 *  black/white tooltip instead of matching the plugin's theme. Meant to sit
 *  right after a label whose meaning isn't obvious from the label text alone,
 *  rather than putting the explanation on the label/control itself where a
 *  user has to hover the CONTROL (easy to trigger by accident while trying to
 *  click it) to learn what it means. */
export function InfoIcon({ text }: { text: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		setIcon(el, 'info');
		// `delay: 1`, NOT `0`: Obsidian's `setTooltip` only writes
		// `data-tooltip-delay` when `delay` is truthy, so `0` falls back to the
		// default delay. 1ms is effectively instant.
		setTooltip(el, text, { delay: 1 });
	}, [text]);
	return <span className="loom-info-icon" ref={ref} />;
}

/**
 * Single-line text that truncates with an ellipsis; only when actually cut
 * off does hovering reveal the full text as a tooltip. The className must
 * apply `overflow: hidden` + `text-overflow: ellipsis` for the cut to happen.
 */
export function Truncated({ text, className }: { text: string; className: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		setTooltip(el, el.scrollWidth > el.clientWidth ? text : '');
	}, [text]);
	return (
		<span className={className} ref={ref}>
			{text}
		</span>
	);
}

/** Calls `close` on any press outside `inside` while `open` — a ref'd
 *  wrapper element, or a CSS selector any of the "inside" elements match.
 *  Defaults to a capture-phase `pointerdown`. */
export function useCloseOnOutsideClick(
	inside: RefObject<HTMLElement | null> | string,
	open: boolean,
	close: () => void,
	{ event = 'pointerdown', capture = true }: { event?: 'pointerdown' | 'mousedown'; capture?: boolean } = {}
): void {
	const closeRef = useRef(close);
	closeRef.current = close;
	useEffect(() => {
		if (!open) return;
		const onDown = (e: Event) => {
			const target = e.target as Node | null;
			const isInside =
				typeof inside === 'string'
					? (target as HTMLElement | null)?.closest?.(inside) != null
					: inside.current?.contains(target) === true;
			if (!isInside) closeRef.current();
		};
		// The window the guarded element lives in (a popout has its own document).
		const ownerDoc = (typeof inside === 'string' ? null : inside.current?.doc) ?? activeDocument;
		ownerDoc.addEventListener(event, onDown, capture);
		return () => ownerDoc.removeEventListener(event, onDown, capture);
	}, [open, inside, event, capture]);
}

/** The ▸ caret + label (+ count) button heading a collapsible section. */
export function SectionHeader({
	open,
	onToggle,
	label,
	count,
}: {
	open: boolean;
	onToggle: () => void;
	label: ReactNode;
	count?: ReactNode;
}) {
	return (
		<button className="loom-section-header" onClick={onToggle}>
			<span className={open ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
			{label}
			{count !== undefined ? <span className="loom-section-count">{count}</span> : null}
		</button>
	);
}

/**
 * A text input with its own suggestion dropdown (a native <datalist> only
 * shows its list on the second click). The list opens on the first press,
 * typing filters it, Enter takes the top suggestion, Escape closes.
 */
export function SuggestInput({
	className,
	placeholder,
	value,
	options,
	onChange,
	onPick,
	onBlur,
	action,
}: {
	className?: string;
	placeholder?: string;
	value: string;
	options: string[];
	onChange: (value: string) => void;
	/** A suggestion was chosen — commit it (onChange is not called for picks). */
	onPick: (value: string) => void;
	onBlur?: () => void;
	/** Extra fixed entry pinned at the top of the list (e.g. "+ Create entity…"),
	 *  shown even when nothing matches the current text. */
	action?: { label: string; onPick: () => void };
}) {
	const [open, setOpen] = useState(false);
	// Keyboard highlight into the filtered list — Arrow Down/Up move it, Enter
	// takes whichever entry is highlighted (defaults to the top match).
	const [active, setActive] = useState(0);
	const wrapRef = useRef<HTMLDivElement>(null);
	useCloseOnOutsideClick(wrapRef, open, () => setOpen(false));

	const query = value.trim().toLowerCase();
	const filtered = options.filter((o) => o.toLowerCase().includes(query));
	const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));

	const pick = (v: string) => {
		setOpen(false);
		onPick(v);
	};

	return (
		<div className={className ? `loom-combo ${className}` : 'loom-combo'} ref={wrapRef}>
			<input
				type="text"
				placeholder={placeholder}
				value={value}
				onChange={(e) => {
					onChange(e.target.value);
					setActive(0);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onPointerDown={() => setOpen(true)}
				onBlur={onBlur}
				onKeyDown={(e) => {
					if (e.key === 'Escape') setOpen(false);
					else if (e.key === 'ArrowDown') {
						e.preventDefault();
						setOpen(true);
						setActive((a) => Math.min(filtered.length - 1, a + 1));
					} else if (e.key === 'ArrowUp') {
						e.preventDefault();
						setActive((a) => Math.max(0, a - 1));
					} else if (e.key === 'Enter') {
						if (open && filtered.length > 0 && filtered[activeIndex] !== value) pick(filtered[activeIndex]);
						else setOpen(false);
					}
				}}
			/>
			{open && (filtered.length > 0 || action) ? (
				// preventDefault keeps focus in the input, so picking a
				// suggestion isn't raced by the blur commit.
				<div className="loom-combo-menu" onMouseDown={(e) => e.preventDefault()}>
					{action ? (
						<button
							className="loom-combo-item loom-combo-action"
							onClick={() => {
								setOpen(false);
								action.onPick();
							}}
						>
							{action.label}
						</button>
					) : null}
					{filtered.map((o, i) => (
						<button
							key={o}
							className={i === activeIndex ? 'loom-combo-item loom-combo-item-active' : 'loom-combo-item'}
							onMouseEnter={() => setActive(i)}
							onClick={() => pick(o)}
						>
							{o}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * A dropdown with a search box: typing filters the options, Enter picks the
 * first match. Used where a plain <select> would grow unwieldy (e.g. linking
 * one of many sessions).
 */
export function SearchableSelect({
	placeholder,
	options,
	onPick,
	action,
	initialQuery,
	autoFocus,
	onQueryChange,
}: {
	placeholder: string;
	/** `hint` is optional secondary text shown faded after the label (e.g. the
	 *  kind of thing a result is); it isn't searched. */
	options: { value: string; label: string; hint?: string }[];
	onPick: (value: string) => void;
	/** Extra fixed entry pinned at the top of the list (e.g. "+ New session…"),
	 *  so it never needs scrolling to reach. */
	action?: { label: string; onPick: () => void };
	/** Seeds the search field on mount (e.g. the current value being edited). */
	initialQuery?: string;
	/** Focus (and select) the field on mount, so typing starts immediately. */
	autoFocus?: boolean;
	/** Reports the typed query as it changes (e.g. to filter a list elsewhere). */
	onQueryChange?: (query: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQueryState] = useState(initialQuery ?? '');
	const setQuery = (q: string) => {
		setQueryState(q);
		onQueryChange?.(q);
	};
	const wrapRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (autoFocus && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [autoFocus]);

	useCloseOnOutsideClick(wrapRef, open, () => setOpen(false));

	const filtered = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));

	const pick = (value: string) => {
		setQuery('');
		setOpen(false);
		onPick(value);
	};

	const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter' && filtered.length > 0) pick(filtered[0].value);
		if (e.key === 'Escape') setOpen(false);
	};

	return (
		<div className="loom-combo" ref={wrapRef}>
			<input
				ref={inputRef}
				type="text"
				placeholder={placeholder}
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				// Focus alone misses clicks on an already-focused field (and the
				// first click in a freshly activated pane) — open on the press too.
				onPointerDown={() => setOpen(true)}
				onKeyDown={onKeyDown}
			/>
			{open ? (
				<div className="loom-combo-menu">
					{action ? (
						<button
							className="loom-combo-item loom-combo-action"
							onClick={() => {
								setQuery('');
								setOpen(false);
								action.onPick();
							}}
						>
							{action.label}
						</button>
					) : null}
					{filtered.map((o) => (
						<button key={o.value} className="loom-combo-item" onClick={() => pick(o.value)}>
							{o.label}
							{o.hint ? <span className="loom-combo-hint">{o.hint}</span> : null}
						</button>
					))}
					{filtered.length === 0 ? <div className="loom-combo-empty">{t('common.noMatches')}</div> : null}
				</div>
			) : null}
		</div>
	);
}


/**
 * `[[` autocomplete vocabulary for a markdown-field-style editor: every entity
 * in the given project, searched/shown by its short display label (a session
 * by its date), inserted as `target|label` so the raw link resolves AND reads
 * well. Each entity's native `aliases` frontmatter is offered too, alongside
 * the primary label, resolving to the same target. Shared by every
 * `MarkdownField` consumer that needs project-scoped entity linking — see
 * `openEntityLink`/`openCreateLinkEntity` below for the matching open/create
 * handlers.
 */
export function buildEntityLinkNames(plugin: LoomLoomPlugin, project: ProjectDef): LinkOption[] {
	return plugin.indexer
		.getAll(undefined, project.root)
		.flatMap((r) => {
			const target = linkTargetOf(r);
			const label = recordLabel(r, project);
			const opts: LinkOption[] = [{ label, insert: target === label ? label : `${target}|${label}` }];
			const f = plugin.app.vault.getFileByPath(r.path);
			const aliases = f ? (plugin.app.metadataCache.getFileCache(f)?.frontmatter?.aliases as unknown) : undefined;
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
}

/**
 * `linkTargetOf(record) -> recordLabel(record, project)`, one entry per
 * record — unlike `buildEntityLinkNames`'s alias-fan-out/sorted `LinkOption[]`
 * (which loses the primary-name mapping once aliases and sorting are mixed
 * in), this is the plain target->clean-label lookup a wikilink-rendering
 * consumer needs. Feeds `MarkdownField`'s `linkLabels` prop (markdown-field.tsx)
 * — see that field's own doc comment for why resolution happens here, once
 * per relevant render, rather than inside the field's own decoration code.
 */
export function buildLinkTargetLabels(plugin: LoomLoomPlugin, project: ProjectDef): Map<string, string> {
	const map = new Map<string, string>();
	for (const r of plugin.indexer.getAll(undefined, project.root)) {
		map.set(linkTargetOf(r), recordLabel(r, project));
	}
	return map;
}

/**
 * Opens a wikilink target from a markdown-field-style editor: a resolvable
 * loom entity gets its structured entity page (via `view.openEntity`),
 * anything else falls back to Obsidian's normal link opening.
 */
export function openEntityLink(
	plugin: LoomLoomPlugin,
	view: LoomNavigator,
	sourcePath: string,
	target: string,
	newTab = false
): void {
	const resolved = plugin.indexer.resolve(target, sourcePath);
	if (resolved) view.openEntity(resolved.path, newTab);
	else void plugin.app.workspace.openLinkText(target, sourcePath, newTab ? 'tab' : false);
}

/**
 * `[[` "+ Create …" flow: type picker → creation modal with the short name
 * prefilled; the finished entity links back into the editor in place.
 */
export function openCreateLinkEntity(
	plugin: LoomLoomPlugin,
	project: ProjectDef,
	entered: string,
	insert: (linkInsert: string) => void
): void {
	new EntityTypeSuggestModal(plugin, (type) =>
		new CreateEntityModal(plugin, type, project, {
			initialName: entered,
			onCreated: (created) => {
				// Short name = managed basename minus its prefix (the index
				// may not have caught the new file yet).
				const prefix = `${project.name} ${ENTITY_META[type].label} `;
				const label = created.basename.startsWith(prefix) ? created.basename.slice(prefix.length) : entered;
				insert(created.basename === label ? label : `${created.basename}|${label}`);
			},
		}).open(),
		project
	).open();
}




/**
 * THE entity tag. Every entity reference rendered as a tag — involved
 * entities, faction members, quest givers, memberships, session links — uses
 * this one component so they all read identically: a pill tinted with the
 * entity's node color, the name clickable when `onOpen` is given, an optional
 * ✕. Session tags keep their special sizing via `className` overrides
 * (`loom-note-session` / `loom-quest-sessions` containers) but share the
 * coloring. Don't hand-roll chip spans — extend this.
 */
export function EntityChip({
	plugin,
	record,
	label,
	onOpen,
	onRemove,
	removeLabel,
}: {
	plugin: LoomLoomPlugin;
	/** null = unresolved link; renders the label uncolored. */
	record: EntityRecord | null;
	/** Display text; defaults to the record name (pass recordLabel() for sessions). */
	label?: string;
	onOpen?: () => void;
	onRemove?: () => void;
	removeLabel?: string;
}) {
	const text = label ?? record?.name ?? '';
	// The virtual Group is its own entity color-wise (stub records carry the
	// sentinel path); everything real colors by its type.
	const color = record
		? record.path === PC_GROUP_VALUE
			? plugin.settings.groupColor
			: plugin.settings.nodeColors[record.type]
		: null;
	return (
		<span
			className="loom-chip loom-session-chip loom-entity-chip"
			style={color !== null ? { background: color + '40', borderColor: color } : undefined}
		>
			{onOpen && record ? (
				<button
					className="loom-subloc-link"
					onClick={onOpen}
					onAuxClick={(e) => {
						// Middle click opens the linked entity in a new tab.
						if (e.button === 1) {
							e.preventDefault();
							plugin.openEntityFile(record.path);
						}
					}}
				>
					{text}
				</button>
			) : (
				text
			)}
			{onRemove ? (
				<button className="loom-chip-remove" aria-label={removeLabel ?? t('common.remove')} onClick={onRemove}>
					✕
				</button>
			) : null}
		</span>
	);
}

/** Lucide icon per quest tag (session-page cards, quest list). */
export const QUEST_TAG_ICONS: Record<string, string> = {
	main: 'star',
	important: 'triangle-alert',
	side: 'shapes',
};

/** Black or white, whichever reads better on the given #rrggbb background. */
export function readableOn(hex: string): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
	if (!m) return 'var(--text-normal)';
	const n = parseInt(m[1], 16);
	const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
	return lum > 0.6 ? '#000000' : '#ffffff';
}

/** A quest tag chip: configured tag color + its icon, readable text. `tag` is
 *  the stored English key ('main'/'important'/'side') — displayed through the
 *  same locale strings the Settings quest-tag-color rows use. */
export function QuestTagChip({ plugin, tag }: { plugin: LoomLoomPlugin; tag: string }) {
	const colors = plugin.settings.questTagColors as Record<string, string>;
	const bg = colors[tag] ?? null;
	return (
		<span
			className="loom-chip loom-quest-tag"
			style={bg !== null ? { background: bg, borderColor: bg, color: readableOn(bg) } : undefined}
		>
			{QUEST_TAG_ICONS[tag] ? <Icon name={QUEST_TAG_ICONS[tag]} /> : null}
			{t(`settings.entities.questTagNames.${tag}` as LocaleKey)}
		</span>
	);
}

export function RailButton({
	icon,
	label,
	active,
	onClick,
}: {
	icon: string;
	/** Substitute icon for older Obsidian bundles missing `icon` (see Icon). */
	label: string;
	active?: boolean;
	onClick: () => void;
}) {
	const ref = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (ref.current) setTooltip(ref.current, label, { placement: 'right' });
	}, [label]);
	return (
		<button
			ref={ref}
			className={active ? 'loom-rail-btn loom-rail-btn-active' : 'loom-rail-btn'}
			aria-label={label}
			onClick={onClick}
		>
			<Icon name={icon} />
		</button>
	);
}

/**
 * Icon-only navigation rail on the left of every page except home: home
 * first, then the entity lists, then the graph. Sits in normal flow, so it
 * never overlaps content; the Quick Notes panel it hosts is a SIBLING of the
 * `<nav>` (see `.loom-qn-panel-wrap`), so the rail's box isn't part of the
 * panel's open/close animation. `active` marks the current page ('graph' or
 * an entity type). `minimal` (Home's stand-in rail) still renders the full
 * button set — `.loom-rail-minimal` hides it with CSS — so the Quick Notes
 * trigger sits in exactly the same position as on a real rail. */
export function NavRail({
	navigator,
	project,
	active,
	minimal,
}: {
	navigator: LoomNavigator;
	project: ProjectDef;
	active?: string;
	minimal?: boolean;
}) {
	const [quickNotesOpen, setQuickNotesOpen] = useQuickNotesToggle(navigator);
	return (
		<>
			<nav className={minimal ? 'loom-rail loom-rail-minimal' : 'loom-rail'}>
				<div className="loom-rail-buttons">
					<RailButton
						icon="home"
						label={t('common.home')}
						onClick={() => navigator.openLoomFile(project.loomPath)}
					/>
					<div className="loom-rail-sep" />
					{/* The script leads, in the slot the Group takes in the other kinds,
					    so every entity button below keeps its usual position. */}
					{features(project.config).script ? (
						<RailButton
							icon={SCRIPT_ICON}
							label={scriptLabel()}
							active={active === 'script'}
							// Created on demand: a project switched to Writer after
							// setup has no script file yet.
							onClick={() =>
								void createScriptFile(navigator.plugin, project).then((f) => navigator.openLoomFile(f.path))
							}
						/>
					) : null}
					{/* Writer/Prose's own rail entry, mirroring Script's above (mutually
					    exclusive, same slot) — an additional whole-book entry point;
					    Chapters keep their own normal entry in the generic loop below too. */}
					{project.config.kind === 'writer' && project.config.writerMode === 'prose' ? (
						<RailButton
							icon={BOOK_ICON}
							label={bookLabel()}
							active={active === 'book'}
							onClick={() =>
								void createBookFile(navigator.plugin, project).then((f) => navigator.openLoomFile(f.path))
							}
						/>
					) : null}
					{/* Writer's own anchor/beat pair (Act, then Scene/Chapter) sits right
					    after Script/Book — the script/book → act → scene/chapter reading
					    order — rather than falling wherever they land in the generic
					    entity-type loop below, which is filtered to skip them here. */}
					{project.config.kind === 'writer'
						? ([projectRoleType(project.config, 'anchor'), projectRoleType(project.config, 'beat')] as const).map(
								(et) => (
									<RailButton
										key={et}
										icon={ENTITY_META[et].icon}
										label={entityPlural(et)}
										active={active === et}
										onClick={() => navigator.navigateTo(VIEW_LIST, { project: project.root, entityType: et })}
									/>
								)
							)
						: null}
					{/* The Group is the party — present only in kinds that have one. */}
					{features(project.config).group ? (
						<RailButton
							icon={PC_GROUP_ICON}
							label={groupNameOf(project.config)}
							active={active === 'group'}
							onClick={() => {
								// Navigators are views — record where the Group page was
								// opened from so its Back button can return there.
								const nav = navigator as LoomNavigator &
									Partial<{ getViewType: () => string; getState: () => Record<string, unknown> }>;
								const origin =
									typeof nav.getViewType === 'function' && typeof nav.getState === 'function'
										? { type: nav.getViewType(), state: nav.getState() }
										: undefined;
								navigator.navigateTo(VIEW_GROUP, { project: project.root, origin });
							}}
						/>
					) : null}
					{projectTypes(project.config)
						.filter(
							(et) =>
								et !== 'region' &&
								et !== 'decisionPoint' &&
								et !== 'act' &&
								et !== 'scene' &&
								et !== 'chapter'
						)
						.flatMap((et) => {
							const btn = (
								<RailButton
									key={et}
									icon={ENTITY_META[et].icon}
									label={entityPlural(et)}
									active={active === et}
									onClick={() => navigator.navigateTo(VIEW_LIST, { project: project.root, entityType: et })}
								/>
							);
							// Maps sits right after Locations, matching the home wheel order.
							if (et === 'location') {
								return [
									btn,
									<RailButton
										key="maps"
										icon={MAPS_ICON}
										label={mapsLabel()}
										active={active === 'map'}
										onClick={() => navigator.navigateTo(VIEW_MAP, { project: project.root })}
									/>,
								];
							}
							return [btn];
						})}
					<div className="loom-rail-sep" />
					<RailButton
						icon="spool"
						label={t('common.loomGraph')}
						active={active === 'graph'}
						onClick={() => navigator.navigateTo(VIEW_GRAPH, { project: project.root })}
					/>
				</div>
				<div className="loom-rail-spacer" />
				{/* `.loom-qn-trigger-wrap` (`display: contents`, no layout effect of
				    its own) marks this button as Quick-Notes UI for the focus
				    tracker in quick-notes.tsx — clicking it shifts DOM focus to the
				    button itself before our own state update even runs, and without
				    this the tracker would wrongly treat that as "the field the user
				    was just working in" instead of ignoring it. */}
				<span className="loom-qn-trigger-wrap">
					<RailButton
						icon={QUICK_NOTES_ICON}
						label={t('common.quickNotes')}
						active={quickNotesOpen}
						onClick={() => setQuickNotesOpen((o) => !o)}
					/>
				</span>
			</nav>
			<QuickNotesPanel plugin={navigator.plugin} view={navigator} project={project} open={quickNotesOpen} />
		</>
	);
}

/**
 * Shared chrome for list/graph views: the nav rail on the left plus a title
 * row; `railActive` marks the current page in the rail.
 */
export function ViewShell({
	view,
	project,
	title,
	railActive,
	titleExtra,
	toolbar,
	children,
}: {
	view: LoomNavigator;
	project: ProjectDef | null;
	title: string;
	railActive?: string;
	/** Rendered on the right side of the title row (view-specific actions). */
	titleExtra?: ReactNode;
	toolbar?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="loom-shell-row">
			{project ? <NavRail navigator={view} project={project} active={railActive} /> : null}
			<div className="loom-shell">
				<div className="loom-shell-header">
					<h2 className="loom-shell-title">{title}</h2>
					<div className="loom-shell-spacer" />
					{titleExtra}
				</div>
				{toolbar ? <div className="loom-toolbar">{toolbar}</div> : null}
				<div className="loom-shell-body">{children}</div>
			</div>
		</div>
	);
}

/** The empty-state shown when a view has no project to render. */
export function noProjectMessage(): ReactNode {
	return <div className="loom-empty">{t('common.noProjectFound')}</div>;
}

/**
 * Scrolls `target` into view within `container` ONLY — never `Element.
 * scrollIntoView`, which cascades through every scrollable ancestor by
 * default. A small self-scrolling box (a Scene/Act Script section's own
 * preview, the main Script view's Pages scroller) nested inside the page's
 * own much bigger outer scroll would otherwise drag that outer scroll along
 * too on every jump — a search next/previous match, a nav click — which
 * could scroll the whole page far enough to carry the surrounding UI (tabs,
 * toolbar) off-screen along with it.
 */
export function scrollIntoContainer(
	container: HTMLElement,
	target: Element,
	behavior: ScrollBehavior,
	align: 'start' | 'center' = 'start'
): void {
	const containerRect = container.getBoundingClientRect();
	const targetRect = target.getBoundingClientRect();
	let top = container.scrollTop + (targetRect.top - containerRect.top);
	if (align === 'center') top += targetRect.height / 2 - container.clientHeight / 2;
	container.scrollTo({ top: Math.max(0, top), behavior });
}
