import { PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { Connection, ENTITY_META, ENTITY_TYPES, EntityRecord, EntityType } from '../types';
import { Icon, Truncated } from '../views/common';

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

export function GraphSidePanel({
	record,
	label,
	connections,
	connectionLabel,
	threshold,
	width,
	onWidthChange,
	onOpen,
	onClose,
	onCreate,
}: {
	record: EntityRecord;
	label: string;
	connections: Connection[];
	connectionLabel: (record: EntityRecord) => string;
	threshold: number;
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

	const groups = new Map<EntityType, Connection[]>();
	for (const conn of connections) {
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
			{record.description !== '' ? <div className="loom-sidepanel-desc">{record.description}</div> : null}
			{connections.length === 0 ? (
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
}
