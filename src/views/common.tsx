import { setIcon } from 'obsidian';
import { ReactNode, useEffect, useRef } from 'react';
import { EntityRecord, VIEW_GRAPH, VIEW_TIMELINE } from '../types';
import { formatLoomDate } from '../calendar';
import { ProjectDef } from '../indexer';
import { LoomNavigator } from './react-view';

/** Renders a Lucide icon by name. */
export function Icon({ name }: { name: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (ref.current) setIcon(ref.current, name);
	}, [name]);
	return <span className="loom-icon" ref={ref} />;
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
	toolbar,
	children,
}: {
	view: LoomNavigator;
	project: ProjectDef | null;
	title: string;
	toolbar?: ReactNode;
	children: ReactNode;
}) {
	const state = project ? { project: project.root } : undefined;
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
				<button className="loom-nav-btn" onClick={() => view.navigateTo(VIEW_TIMELINE, state)}>
					Timeline
				</button>
				<button className="loom-nav-btn" onClick={() => view.navigateTo(VIEW_GRAPH, state)}>
					Loom graph
				</button>
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
