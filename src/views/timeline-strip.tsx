import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { EntityRecord, TimelineDef } from '../types';
import { buildColumns } from '../columns';
import { ProjectDef } from '../indexer';
import { LoomNavigator } from './react-view';
import { recordDate, recordLabel } from './common';
import { useIndexVersion } from './hooks';

/** Longest description shown in the hover tooltip, in words. */
const TOOLTIP_MAX_WORDS = 30;

function truncateWords(text: string, max: number): string {
	const words = text.split(/\s+/).filter((w) => w !== '');
	return words.length <= max ? text : words.slice(0, max).join(' ') + ' …';
}

interface TooltipState {
	record: EntityRecord;
	x: number;
	y: number;
	/** Rendered above the chip when there's no room below it. */
	above: boolean;
	/** Portal target — the chip's own document (supports pop-out windows). */
	body: HTMLElement;
}

function Bubble({
	record,
	kind,
	label,
	navigator,
	setTooltip,
}: {
	record: EntityRecord;
	kind: 'session' | 'event';
	label: string;
	navigator: LoomNavigator;
	setTooltip: (t: TooltipState | null) => void;
}) {
	return (
		<button
			className={`loom-bubble loom-bubble-${kind}`}
			onClick={() => navigator.openEntity(record.path)}
			onMouseEnter={(e) => {
				const el = e.currentTarget;
				const rect = el.getBoundingClientRect();
				// Flip above the chip when a below-tooltip would leave the window
				// (the drawer sits at the bottom of the screen).
				const above = rect.bottom + 200 > el.win.innerHeight;
				setTooltip({
					record,
					x: rect.left + rect.width / 2,
					y: above ? rect.top : rect.bottom,
					above,
					body: el.doc.body,
				});
			}}
			onMouseLeave={() => setTooltip(null)}
		>
			<span className="loom-bubble-name">{label}</span>
		</button>
	);
}

/**
 * The chronological session/event strip — the timeline's whole body, shared
 * between the standalone timeline view and the graph's bottom drawer.
 */
export function TimelineStrip({
	navigator,
	project,
	def,
}: {
	navigator: LoomNavigator;
	project: ProjectDef;
	def: TimelineDef | null;
}) {
	const indexer = navigator.plugin.indexer;
	const version = useIndexVersion(indexer);
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);

	const columns = useMemo(
		() => buildColumns(indexer, def, project.root),
		[indexer, version, def, project]
	);

	if (columns.length === 0) {
		return <div className="loom-empty">No sessions or events yet.</div>;
	}

	return (
		<div className="loom-timeline">
			<div className="loom-timeline-columns">
				{columns.map((col) => {
					const isSession = col.anchor.type === 'session';
					return (
						<div key={col.anchor.path} className="loom-col">
							{/* Fixed-height header band: session bubbles and the date
							    labels of sessionless events share one line, so the
							    events below all start on the same line too. */}
							<div className={isSession ? 'loom-col-header' : 'loom-col-header loom-col-header-date'}>
								{isSession ? (
									<Bubble
										record={col.anchor}
										kind="session"
										label={recordLabel(col.anchor, project) || 'No date'}
										navigator={navigator}
										setTooltip={setTooltip}
									/>
								) : (
									<div className="loom-col-date">{recordDate(col.anchor, project) || 'No date'}</div>
								)}
							</div>
							{isSession ? (
								col.events.length > 0 ? (
									<div className="loom-col-events">
										{col.events.map((ev) => (
											<Bubble
												key={ev.path}
												record={ev}
												kind="event"
												label={ev.name}
												navigator={navigator}
												setTooltip={setTooltip}
											/>
										))}
									</div>
								) : null
							) : (
								<div className="loom-col-events loom-col-events-root">
									<Bubble
										record={col.anchor}
										kind="event"
										label={col.anchor.name}
										navigator={navigator}
										setTooltip={setTooltip}
									/>
								</div>
							)}
						</div>
					);
				})}
			</div>
			{tooltip && tooltip.record.description !== ''
				? // Portalled to the body: inside the workspace leaf, `contain`
					// re-bases position:fixed and the tooltip lands away from the chip.
					createPortal(
						<div
							className={tooltip.above ? 'loom-tooltip loom-tooltip-above' : 'loom-tooltip'}
							style={{ left: tooltip.x, top: tooltip.y }}
						>
							{truncateWords(tooltip.record.description, TOOLTIP_MAX_WORDS)}
						</div>,
						tooltip.body
					)
				: null}
		</div>
	);
}
