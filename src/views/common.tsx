import { setIcon, setTooltip } from 'obsidian';
import { KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { EntityRecord } from '../types';
import { formatLoomDate } from '../calendar';
import { ProjectDef } from '../indexer';
import { LoomNavigator } from './react-view';

/** Matches a note's leading frontmatter block (used to split it from the body). */
export const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

/** Renders a Lucide icon by name. */
export function Icon({ name }: { name: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (ref.current) setIcon(ref.current, name);
	}, [name]);
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
}: {
	className?: string;
	placeholder?: string;
	value: string;
	options: string[];
	onChange: (value: string) => void;
	/** A suggestion was chosen — commit it (onChange is not called for picks). */
	onPick: (value: string) => void;
	onBlur?: () => void;
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
			{open && filtered.length > 0 ? (
				// preventDefault keeps focus in the input, so picking a
				// suggestion isn't raced by the blur commit.
				<div className="loom-combo-menu" onMouseDown={(e) => e.preventDefault()}>
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

/** Formatted date of a record, or empty string. */
export function recordDate(record: EntityRecord, project: ProjectDef | null): string {
	if (!record.date || !project) return record.date?.raw ?? '';
	return formatLoomDate(record.date, project.config);
}

/**
 * Shared chrome for list/timeline/graph views: title row with navigation
 * back to the project home and across to the other top-level views.
 */
export function ViewShell({
	view,
	project,
	title,
	titleExtra,
	toolbar,
	children,
}: {
	view: LoomNavigator;
	project: ProjectDef | null;
	title: string;
	/** Rendered on the right side of the title row (view-specific actions). */
	titleExtra?: ReactNode;
	toolbar?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="loom-shell">
			<div className="loom-shell-header">
				{project ? (
					<button className="loom-nav-btn" onClick={() => view.openLoomFile(project.loomPath)}>
						Home
					</button>
				) : null}
				<h2 className="loom-shell-title">{title}</h2>
				<div className="loom-shell-spacer" />
				{titleExtra}
			</div>
			{toolbar ? <div className="loom-toolbar">{toolbar}</div> : null}
			<div className="loom-shell-body">{children}</div>
		</div>
	);
}

/** Formats a record label for missing projects/dates. */
export function noProjectMessage(): ReactNode {
	return <div className="loom-empty">No project found. Open a project home file (.loom) first.</div>;
}
