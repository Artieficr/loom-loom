import { ViewStateResult } from 'obsidian';
import { ReactElement, useMemo, useState } from 'react';
import { EntityRecord, TimelineDef, VIEW_TIMELINE } from '../types';
import { buildColumns } from '../columns';
import { ProjectDef } from '../indexer';
import { TimelineSettingsModal } from '../timeline-settings';
import { LoomReactView } from './react-view';
import { ViewShell, noProjectMessage, recordDate, recordLabel } from './common';
import { resolveProject, useIndexVersion } from './hooks';

export class TimelineView extends LoomReactView {
	projectRoot: string | null = null;

	getViewType(): string {
		return VIEW_TIMELINE;
	}

	getDisplayText(): string {
		return 'Timeline';
	}

	getIcon(): string {
		return 'calendar-range';
	}

	getState(): Record<string, unknown> {
		return { project: this.projectRoot };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as { project?: unknown } | null;
		if (typeof s?.project === 'string') this.projectRoot = s.project;
		await super.setState(state, result);
		this.renderNow();
	}

	protected renderReact(): ReactElement {
		return <Timeline key={this.projectRoot ?? ''} view={this} projectRoot={this.projectRoot} />;
	}
}

interface TooltipState {
	record: EntityRecord;
	x: number;
	y: number;
}

function Bubble({
	record,
	kind,
	label,
	view,
	setTooltip,
}: {
	record: EntityRecord;
	kind: 'session' | 'event';
	label: string;
	view: TimelineView;
	setTooltip: (t: TooltipState | null) => void;
}) {
	return (
		<button
			className={`loom-bubble loom-bubble-${kind}`}
			onClick={() => view.openEntity(record.path)}
			onMouseEnter={(e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				setTooltip({ record, x: rect.left + rect.width / 2, y: rect.bottom });
			}}
			onMouseLeave={() => setTooltip(null)}
		>
			<span className="loom-bubble-name">{label}</span>
		</button>
	);
}

function Timeline({ view, projectRoot }: { view: TimelineView; projectRoot: string | null }) {
	const plugin = view.plugin;
	const version = useIndexVersion(plugin.indexer);
	const [defPath, setDefPath] = useState('');
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);

	const project: ProjectDef | null = resolveProject(plugin.indexer, projectRoot);
	const defs = project ? plugin.indexer.getTimelines(project.root) : [];
	const activeDef: TimelineDef | null = defs.find((d) => d.path === defPath) ?? defs[0] ?? null;

	const columns = useMemo(
		() => (project ? buildColumns(plugin.indexer, activeDef, project.root) : []),
		[plugin.indexer, version, activeDef, project]
	);

	if (!project) {
		return (
			<ViewShell view={view} project={null} title="Timeline">
				{noProjectMessage()}
			</ViewShell>
		);
	}

	const toolbar = (
		<>
			{defs.length > 1 ? (
				<select className="dropdown" value={activeDef?.path ?? ''} onChange={(e) => setDefPath(e.target.value)}>
					{defs.map((d) => (
						<option key={d.path} value={d.path}>
							{d.name}
						</option>
					))}
				</select>
			) : null}
			<div className="loom-shell-spacer" />
			<button onClick={() => new TimelineSettingsModal(plugin, project).open()}>Timeline settings</button>
		</>
	);

	return (
		<ViewShell
			view={view}
			project={project}
			title={activeDef && defs.length > 1 ? `Timeline — ${activeDef.name}` : 'Timeline'}
			toolbar={toolbar}
		>
			{columns.length === 0 ? (
				<div className="loom-empty">No sessions or events yet.</div>
			) : (
				<div className="loom-timeline">
					<div className="loom-timeline-columns">
						{columns.map((col) => {
							const isSession = col.anchor.type === 'session';
							return (
								<div key={col.anchor.path} className="loom-col">
									<div className="loom-col-anchor">
										{/* Sessions show only their date; events show date above the name. */}
										{!isSession ? (
											<div className="loom-col-date">{recordDate(col.anchor, project) || 'No date'}</div>
										) : null}
										<Bubble
											record={col.anchor}
											kind={isSession ? 'session' : 'event'}
											label={isSession ? recordLabel(col.anchor, project) || 'No date' : col.anchor.name}
											view={view}
											setTooltip={setTooltip}
										/>
									</div>
									{col.events.length > 0 ? (
										<div className="loom-col-events">
											{col.events.map((ev) => (
												<Bubble
													key={ev.path}
													record={ev}
													kind="event"
													label={ev.name}
													view={view}
													setTooltip={setTooltip}
												/>
											))}
										</div>
									) : null}
								</div>
							);
						})}
					</div>
				</div>
			)}
			{tooltip && tooltip.record.description !== '' ? (
				<div className="loom-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
					{tooltip.record.description}
				</div>
			) : null}
		</ViewShell>
	);
}
