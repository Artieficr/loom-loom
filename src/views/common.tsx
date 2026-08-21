import { setIcon, setTooltip } from 'obsidian';
import {
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent,
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
import { formatLoomDate, groupNameOf } from '../calendar';
import { features, projectTypes, roleOf } from '../project-kind';
import { createScriptFile, scriptFilePath as scriptPathOf } from './script-view';
import { createBookFile, findBookFile } from './book-view';
import { QUICK_NOTES_ICON, QuickNotesPanel, useQuickNotesToggle } from './quick-notes';
import { ProjectDef, linkTargetOf } from '../indexer';
import { LoomNavigator } from './react-view';
import { LinkOption } from './link-textarea';
import { CreateEntityModal, EntityTypeSuggestModal } from '../project';
import { LocaleKey, t } from '../i18n';
import type LoomLoomPlugin from '../main';

/** Matches a note's leading frontmatter block (used to split it from the body). */
export const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

/**
 * Lets a textarea be resized by dragging its bottom edge. Pairs with the
 * `.loom-resizable` / `.loom-resize-edge` CSS. Dragging is the manual act
 * that turns auto-grow off for the element (see `autoGrowTextarea`) — only a
 * manually squeezed box can end up smaller than its content and scroll.
 * The smallest manual size is one line of text.
 */
export function startTextareaResize(el: HTMLTextAreaElement | null, e: ReactMouseEvent): void {
	if (!el) return;
	e.preventDefault();
	const startY = e.clientY;
	const startHeight = el.getBoundingClientRect().height;
	const win = el.win;
	const style = win.getComputedStyle(el);
	const minHeight =
		(parseFloat(style.lineHeight) || 24) +
		(parseFloat(style.paddingTop) || 0) +
		(parseFloat(style.paddingBottom) || 0) +
		(el.offsetHeight - el.clientHeight);
	el.dataset.loomManualHeight = '1';
	const onMove = (ev: MouseEvent) => {
		el.style.height = `${Math.max(minHeight, startHeight + (ev.clientY - startY))}px`;
	};
	const onUp = () => {
		win.removeEventListener('mousemove', onMove);
		win.removeEventListener('mouseup', onUp);
	};
	win.addEventListener('mousemove', onMove);
	win.addEventListener('mouseup', onUp);
}

/**
 * Auto-grows a textarea to fit its content so scrolling never occurs
 * naturally: height tracks the content, with the `rows` attribute as the
 * floor. Once the box has been resized manually (drag on the resize edge, or
 * a remembered height from an earlier session), auto-grow stays off for it.
 */
export function autoGrowTextarea(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	// Collapse to the natural (rows-attribute) height to measure the content,
	// then grow to it; the offset/client difference re-adds the borders.
	el.setCssProps({ height: 'auto' });
	el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/** Renders a Lucide icon by name. */
export function Icon({ name, fallback }: { name: string; fallback?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		setIcon(el, name);
		// Lucide renames icons across versions (e.g. shield-question ->
		// shield-question-mark); if the primary name isn't registered, setIcon
		// inserts nothing — fall back to a name the running version does have.
		if (fallback && !el.firstChild) setIcon(el, fallback);
	}, [name, fallback]);
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
		// `delay: 1`, NOT `0` — a real bug in Obsidian's own `setTooltip`
		// (confirmed against the actual 1.13.4 `app.js`): its internal option
		// storage does `delay && el.setAttribute('data-tooltip-delay', …)`,
		// and `0` is falsy, so the attribute never gets written at all —
		// `delay: 0` silently falls back to Obsidian's own DEFAULT delay
		// (reading the missing attribute back finds nothing and substitutes
		// the standard constant), the opposite of what's intended. `1`
		// survives that truthy check (the attribute DOES get set) while
		// still being a single millisecond — imperceptible, functionally
		// instant, without hitting the bug.
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

/** Closes an open dropdown on any pointer press outside `wrapRef` — shared by
 *  `SuggestInput` and `SearchableSelect`. */
function useCloseOnOutsideClick<T extends HTMLElement>(
	wrapRef: RefObject<T | null>,
	open: boolean,
	setOpen: (open: boolean) => void
): void {
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('pointerdown', onDown, true);
		return () => document.removeEventListener('pointerdown', onDown, true);
	}, [open, wrapRef, setOpen]);
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
	useCloseOnOutsideClick(wrapRef, open, setOpen);

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
}: {
	placeholder: string;
	options: { value: string; label: string }[];
	onPick: (value: string) => void;
	/** Extra fixed entry pinned at the top of the list (e.g. "+ New session…"),
	 *  so it never needs scrolling to reach. */
	action?: { label: string; onPick: () => void };
	/** Seeds the search field on mount (e.g. the current value being edited). */
	initialQuery?: string;
	/** Focus (and select) the field on mount, so typing starts immediately. */
	autoFocus?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState(initialQuery ?? '');
	const wrapRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (autoFocus && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [autoFocus]);

	useCloseOnOutsideClick(wrapRef, open, setOpen);

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
						</button>
					))}
					{filtered.length === 0 ? <div className="loom-combo-empty">{t('common.noMatches')}</div> : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * User-facing label of a record. Dated anchors (Sessions) display their date —
 * their file name is managed and never exposed inside the plugin. Acts are
 * named, so they fall through to the name like everything else.
 */
export function recordLabel(record: EntityRecord, project: ProjectDef | null): string {
	if (roleOf(record.type) === 'anchor' && record.date && project) {
		return formatLoomDate(record.date, project.config);
	}
	return record.name;
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

/** Search/display label for a location: a sublocation reads "Secret room,
 *  Tavern, City" (its full ancestry, so same-named places stay distinct). The
 *  `subChipFullAncestry` setting can trim it to just the sublocation's own name. */
export function locationLabel(record: EntityRecord, plugin: LoomLoomPlugin): string {
	if (record.type !== 'location' || record.parentLocation === null) return record.name;
	if (!plugin.settings.subChipFullAncestry) return record.name;
	const parts = [record.name];
	let cur: EntityRecord | null = record;
	const seen = new Set<string>([record.path]);
	for (let guard = 0; guard < 20 && cur?.parentLocation != null; guard++) {
		const parent = plugin.indexer.resolve(cur.parentLocation, cur.path);
		if (parent?.type !== 'location' || seen.has(parent.path)) break;
		parts.push(parent.name);
		seen.add(parent.path);
		cur = parent;
	}
	return parts.join(', ');
}

/** Location picker order: top-level locations before sublocations (so searching
 *  "City" lists City above "Tavern, City"), then alphabetically within each. */
export function mainLocationFirst(a: EntityRecord, b: EntityRecord): number {
	const da = a.parentLocation === null ? 0 : 1;
	const db = b.parentLocation === null ? 0 : 1;
	return da - db || a.name.localeCompare(b.name);
}

/** Formatted date of a record, or empty string. */
export function recordDate(record: EntityRecord, project: ProjectDef | null): string {
	if (!record.date || !project) return record.date?.raw ?? '';
	return formatLoomDate(record.date, project.config);
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
							plugin.openEntityInTab(record.path);
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
	iconFallback,
	label,
	active,
	onClick,
}: {
	icon: string;
	/** Substitute icon for older Obsidian bundles missing `icon` (see Icon). */
	iconFallback?: string;
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
			<Icon name={icon} fallback={iconFallback} />
		</button>
	);
}

/**
 * Icon-only navigation rail on the left of every page except home: home
 * first, then the entity lists, then the graph — the home page's whole
 * navigation. Sits in normal flow, so it never overlaps content — the one
 * exception is the Quick Notes panel it hosts, a SIBLING of the `<nav>`
 * itself (see `.loom-qn-panel-wrap`'s own CSS comment), never a child of it,
 * so the rail's own box and buttons are never implicated in the panel's
 * open/close animation. `active` marks the current page ('graph' or an
 * entity type). `minimal` renders just the Quick Notes trigger with no other
 * buttons/separators — Home's own stand-in rail (home-view.tsx), so its
 * trigger lands in the exact same spot as every other page's without
 * hand-tuning a separate position for it. */
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
			<nav className="loom-rail">
				<div className="loom-rail-buttons">
					{minimal ? null : (
						<>
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
									onClick={() => {
										// Created on demand: a project switched to Writer after
										// setup has no script file yet.
										const path = scriptPathOf(project);
										if (navigator.plugin.app.vault.getFileByPath(path)) navigator.openLoomFile(path);
										else {
											void createScriptFile(navigator.plugin, project).then((f) =>
												navigator.openLoomFile(f.path)
											);
										}
									}}
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
									onClick={() => {
										// Created on demand: a project switched to Writer/Prose after
										// setup has no Book file yet — mirrors the Script button above.
										const bookFile = findBookFile(navigator.plugin, project);
										if (bookFile) navigator.openLoomFile(bookFile.path);
										else
											void createBookFile(navigator.plugin, project).then((f) =>
												navigator.openLoomFile(f.path)
											);
									}}
								/>
							) : null}
							{/* The Group is the party — present only in kinds that have one. */}
							{features(project.config).group ? (
								<RailButton
									icon={PC_GROUP_ICON}
									iconFallback="star"
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
								.filter((et) => et !== 'region')
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
						</>
					)}
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
						iconFallback="sticky-note"
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

/** Formats a record label for missing projects/dates. */
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
export function scrollIntoContainer(container: HTMLElement, target: HTMLElement, behavior: ScrollBehavior): void {
	const containerRect = container.getBoundingClientRect();
	const targetRect = target.getBoundingClientRect();
	const top = container.scrollTop + (targetRect.top - containerRect.top);
	container.scrollTo({ top: Math.max(0, top), behavior });
}
