import { useState } from 'react';
import { Connection, ENTITY_META, ENTITY_TYPES, EntityRecord, EntityType } from '../types';

function Section({
	label,
	entries,
	threshold,
	connectionLabel,
	onOpen,
}: {
	label: string;
	entries: Connection[];
	threshold: number;
	connectionLabel: (record: EntityRecord) => string;
	onOpen: (path: string) => void;
}) {
	const [open, setOpen] = useState(entries.length <= threshold);
	return (
		<div className="loom-section">
			<button className="loom-section-header" onClick={() => setOpen(!open)}>
				<span className={open ? 'loom-caret loom-caret-open' : 'loom-caret'}>▸</span>
				{label}
				<span className="loom-section-count">{entries.length}</span>
			</button>
			{open ? (
				<div className="loom-section-body">
					{entries.map((conn) => (
						<button
							key={conn.record.path + conn.relType}
							className="loom-link"
							onClick={() => onOpen(conn.record.path)}
						>
							<span className="loom-link-name">{connectionLabel(conn.record)}</span>
							<span className="loom-link-rel">{conn.relType}</span>
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
	onOpen,
	onClose,
}: {
	record: EntityRecord;
	label: string;
	connections: Connection[];
	connectionLabel: (record: EntityRecord) => string;
	threshold: number;
	onOpen: (path: string) => void;
	onClose: () => void;
}) {
	const groups = new Map<EntityType, Connection[]>();
	for (const conn of connections) {
		const list = groups.get(conn.record.type) ?? [];
		list.push(conn);
		groups.set(conn.record.type, list);
	}

	return (
		<div className="loom-sidepanel">
			<div className="loom-sidepanel-header">
				<button className="loom-link loom-sidepanel-title" onClick={() => onOpen(record.path)}>
					{label}
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
					/>
				))
			)}
		</div>
	);
}
