import { App } from 'obsidian';
import { PointerEvent as ReactPointerEvent, memo, useRef, useState } from 'react';
import { Connection, ENTITY_META, ENTITY_TYPES, EntityRecord, EntityType } from '../types';
import { Icon, Truncated } from '../views/common';
import { MarkdownField } from '../views/markdown-field';
import type { LinkOption } from '../views/link-textarea';

/** The panel's original fixed width — resizing can only widen it. */
export const PANEL_MIN = 260;
export const PANEL_MAX = 640;

function Section({
	label,
	entries,
	threshold,
	connectionLabel,
	onOpen,
	onCreate,
}: {
	label: string;
	entries: Connection[];
	threshold: number;
	connectionLabel: (record: EntityRecord) => string;
	onOpen: (path: string) => void;
	onCreate: () => void;
}) {
	const [open, setOpen] = useState(entries.length <= threshold);
	return (
		<div className="loom-section">
			<div className="loom-section-head">
				<button className="loom-section-header" onClick={() => setOpen(!open)}>
					<span className={open ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
					{label}
					<span className="loom-section-count">{entries.length}</span>
				</button>
				<button
					className="loom-section-add"
					aria-label={`New connected ${label.toLowerCase()}`}
					onClick={onCreate}
				>
					<Icon name="plus" />
				</button>
			</div>
			{open ? (
				<div className="loom-section-body">
					{entries.map((conn) => (
						<button
							key={conn.record.path + conn.relType}
							className="loom-link"
							onClick={() => onOpen(conn.record.path)}
						>
							<Truncated className="loom-link-name" text={connectionLabel(conn.record)} />
							<Truncated className="loom-link-rel" text={conn.relType} />
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

// Memoized so a graph drag/spring frame (which re-renders the graph) doesn't
// re-render the whole connections list while a node is selected — the parent
// passes stable, memoized props (connections array + callbacks) so the shallow
// compare skips it until the selection or index actually changes.
export const GraphSidePanel = memo(function GraphSidePanel({
	app,
	record,
	label,
	connections,
	connectionLabel,
	threshold,
	names,
	onOpenLink,
	width,
	onWidthChange,
	onOpen,
	onClose,
	onCreate,
}: {
	app: App;
	record: EntityRecord;
	label: string;
	connections: Connection[];
	connectionLabel: (record: EntityRecord) => string;
	threshold: number;
	/** Link vocabulary for the read-only description's rendered links. */
	names: LinkOption[];
	/** Opens a wikilink target from the rendered description. */
	onOpenLink: (target: string, newTab?: boolean) => void;
	/** Current panel width (px), owned by the graph view so it persists. */
	width: number;
	onWidthChange: (width: number) => void;
	onOpen: (path: string) => void;
	onClose: () => void;
	/** Create a new entity of the given type, connected to `record`. */
	onCreate: (type: EntityType) => void;
}) {
	const resize = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
	const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		resize.current = { pointerId: e.pointerId, startX: e.clientX, startW: width };
	};
	const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = resize.current;
		if (!drag || drag.pointerId !== e.pointerId) return;
		const next = drag.startW + (drag.startX - e.clientX);
		onWidthChange(Math.max(PANEL_MIN, Math.min(PANEL_MAX, next)));
	};
	const onHandlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (resize.current?.pointerId === e.pointerId) resize.current = null;
	};

	// Reciprocal typed relationships collapse to what THIS node declares: if the
	// selected node has an outgoing connection to a target, its incoming ones to
	// the same target are dropped (A→B "husband" hides B→A "wife" on A's panel).
	// Targets the node only receives connections from keep those as-is.
	const byTarget = new Map<string, Connection[]>();
	for (const conn of connections) {
		const list = byTarget.get(conn.record.path) ?? [];
		list.push(conn);
		byTarget.set(conn.record.path, list);
	}
	const deduped: Connection[] = [];
	for (const list of byTarget.values()) {
		const outgoing = list.filter((c) => c.direction === 'outgoing');
		deduped.push(...(outgoing.length > 0 ? outgoing : list));
	}

	const groups = new Map<EntityType, Connection[]>();
	for (const conn of deduped) {
		const list = groups.get(conn.record.type) ?? [];
		list.push(conn);
		groups.set(conn.record.type, list);
	}

	return (
		<div className="loom-sidepanel" style={{ width }}>
			<div
				className="loom-sidepanel-handle"
				onPointerDown={onHandlePointerDown}
				onPointerMove={onHandlePointerMove}
				onPointerUp={onHandlePointerUp}
			/>
			<div className="loom-sidepanel-scroll">
			<div className="loom-sidepanel-header">
				<button className="loom-link loom-sidepanel-title" onClick={() => onOpen(record.path)}>
					<Truncated className="loom-sidepanel-title-text" text={label} />
				</button>
				<button className="loom-nav-btn" onClick={onClose} aria-label="Close panel">
					✕
				</button>
			</div>
			{record.description !== '' ? (
				<div className="loom-sidepanel-desc">
					<MarkdownField
						app={app}
						value={record.description}
						names={names}
						onOpenLink={onOpenLink}
						onChange={() => undefined}
						readOnly
					/>
				</div>
			) : null}
			{deduped.length === 0 ? (
				<div className="loom-empty">No connections.</div>
			) : (
				// key on record.path so open/collapsed state resets per selection
				ENTITY_TYPES.filter((t) => groups.has(t)).map((t) => (
					<Section
						key={record.path + t}
						label={ENTITY_META[t].plural}
						entries={groups.get(t) ?? []}
						threshold={threshold}
						connectionLabel={connectionLabel}
						onOpen={onOpen}
						onCreate={() => onCreate(t)}
					/>
				))
			)}
			</div>
		</div>
	);
});
