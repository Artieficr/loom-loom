import { debounce, setIcon, setTooltip } from 'obsidian';
import {
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent,
	ReactNode,
	RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	ENTITY_META,
	ENTITY_TYPES,
	EntityRecord,
	PC_GROUP_ICON,
	PC_GROUP_VALUE,
	VIEW_GRAPH,
	VIEW_GROUP,
	VIEW_LIST,
} from '../types';
import { formatLoomDate, groupNameOf } from '../calendar';
import { ProjectDef } from '../indexer';
import { LoomNavigator } from './react-view';
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

/**
 * Remembers a textarea's resized height per entity file, restoring it on
 * mount and persisting (debounced) on every change — whether resized via
 * `.loom-resize-edge` or the browser's native corner grip.
 */
export function useBoxSizeMemory(
	plugin: LoomLoomPlugin,
	filePath: string,
	fieldKey: string,
	ref: RefObject<HTMLTextAreaElement | null>,
	// On cold Obsidian boot the entity page's first render or two can land
	// before the index has rebuilt, when the textarea isn't mounted yet (the
	// page shows its "not found" placeholder instead). This makes the caller
	// pass a flag that flips once the real form (and the ref) is live, so the
	// effect re-runs and actually finds the element — a plain [ref, ...] dep
	// array never re-fires on that later mount, since the ref object itself
	// never changes identity.
	ready = true
): void {
	const persist = useMemo(
		() =>
			debounce(
				(height: number) => {
					plugin.settings.entityBoxSizes[filePath] = {
						...plugin.settings.entityBoxSizes[filePath],
						[fieldKey]: height,
					};
					void plugin.saveSettings();
				},
				500,
				true
			),
		[plugin, filePath, fieldKey]
	);

	// Boxes always auto-size to content now — nothing to restore or persist.
	void ref;
	void persist;
	void ready;

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
	const wrapRef = useRef<HTMLDivElement>(null);

	// Close on any press outside the component.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('pointerdown', onDown, true);
		return () => document.removeEventListener('pointerdown', onDown, true);
	}, [open]);

	const query = value.trim().toLowerCase();
	const filtered = options.filter((o) => o.toLowerCase().includes(query));

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
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onPointerDown={() => setOpen(true)}
				onBlur={onBlur}
				onKeyDown={(e) => {
					if (e.key === 'Escape') setOpen(false);
					if (e.key === 'Enter') {
						if (open && filtered.length > 0 && filtered[0] !== value) pick(filtered[0]);
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
					{filtered.map((o) => (
						<button key={o} className="loom-combo-item" onClick={() => pick(o)}>
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
}: {
	placeholder: string;
	options: { value: string; label: string }[];
	onPick: (value: string) => void;
	/** Extra fixed entry pinned at the top of the list (e.g. "+ New session…"),
	 *  so it never needs scrolling to reach. */
	action?: { label: string; onPick: () => void };
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const wrapRef = useRef<HTMLDivElement>(null);

	// Close on any press outside the component.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('pointerdown', onDown, true);
		return () => document.removeEventListener('pointerdown', onDown, true);
	}, [open]);

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
					{filtered.length === 0 ? <div className="loom-combo-empty">No matches.</div> : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * User-facing label of a record. Sessions display their date — their file
 * name is managed and never exposed inside the plugin.
 */
export function recordLabel(record: EntityRecord, project: ProjectDef | null): string {
	if (record.type === 'session' && record.date && project) {
		return formatLoomDate(record.date, project.config);
	}
	return record.name;
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
				<button className="loom-chip-remove" aria-label={removeLabel ?? 'Remove'} onClick={onRemove}>
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

/** A quest tag chip: configured tag color + its icon, readable text. */
export function QuestTagChip({ plugin, tag }: { plugin: LoomLoomPlugin; tag: string }) {
	const colors = plugin.settings.questTagColors as Record<string, string>;
	const bg = colors[tag] ?? null;
	return (
		<span
			className="loom-chip loom-quest-tag"
			style={bg !== null ? { background: bg, borderColor: bg, color: readableOn(bg) } : undefined}
		>
			{QUEST_TAG_ICONS[tag] ? <Icon name={QUEST_TAG_ICONS[tag]} /> : null}
			{tag}
		</span>
	);
}

function RailButton({
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
 * navigation. Sits in normal flow, so it never overlaps content.
 * `active` marks the current page ('graph' or an entity type).
 */
export function NavRail({
	navigator,
	project,
	active,
}: {
	navigator: LoomNavigator;
	project: ProjectDef;
	active?: string;
}) {
	return (
		<nav className="loom-rail">
			<RailButton icon="home" label="Home" onClick={() => navigator.openLoomFile(project.loomPath)} />
			<div className="loom-rail-sep" />
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
			{ENTITY_TYPES.map((t) => (
				<RailButton
					key={t}
					icon={ENTITY_META[t].icon}
					label={ENTITY_META[t].plural}
					active={active === t}
					onClick={() => navigator.navigateTo(VIEW_LIST, { project: project.root, entityType: t })}
				/>
			))}
			<div className="loom-rail-sep" />
			<RailButton
				icon="spool"
				label="Loom"
				active={active === 'graph'}
				onClick={() => navigator.navigateTo(VIEW_GRAPH, { project: project.root })}
			/>
		</nav>
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
	return <div className="loom-empty">No project found. Open a project home file (.loom) first.</div>;
}
