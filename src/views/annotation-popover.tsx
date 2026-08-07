import { Menu } from 'obsidian';
import { MouseEvent as ReactMouseEvent, ReactElement, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { CommentEntry } from './script-notes';
import { Icon } from './common';

const POPOVER_W = 320;

/** `Intl.DateTimeFormat` is overkill for a tooltip; this reads close enough
 *  to native "Resolved on …" phrasing without pulling in a date library. */
function formatResolvedAt(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	});
}

/**
 * A comment THREAD's card, anchored with its TOP-RIGHT corner on the icon
 * that opened it. Portalled to `document.body` — same reasoning as
 * `timeline-strip.tsx`'s own tooltip: Obsidian's workspace-leaf DOM applies
 * CSS `contain`, which re-bases `position: fixed` to the leaf instead of the
 * true viewport, so an in-place popover would mis-position the moment the
 * leaf itself scrolls.
 *
 * `entries` is the marker id's full `CommentEntry[]` — a marked range is a
 * thread, not a single note (script-notes.ts's own doc comment on why the
 * array shape exists). Each entry renders as a compact row (text, a
 * resolve-toggle check icon, an ellipsis menu for edit/delete); a reply box
 * at the bottom is always available to append another entry. `entries` is
 * `[]` only transiently, right after a brand-new marker pair is inserted and
 * before the caller's own `mutateScriptNotes` write has landed and
 * re-rendered this with the fresh entry — the reply box alone (no rows yet)
 * covers that case fine, since "opening the popover IS the request to start
 * typing" already holds.
 */
export function CommentPopover({
	anchorRect,
	entries,
	onSaveEntry,
	onToggleResolvedEntry,
	onDeleteEntry,
	onAddEntry,
	onClose,
}: {
	anchorRect: DOMRect;
	entries: CommentEntry[];
	onSaveEntry: (index: number, text: string) => void;
	onToggleResolvedEntry: (index: number) => void;
	onDeleteEntry: (index: number) => void;
	onAddEntry: (text: string) => void;
	onClose: () => void;
}): ReactElement {
	/** Which row (by index) is currently swapped into its own edit textarea —
	 *  at most one at a time, per row rather than for the whole card. */
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [editDraft, setEditDraft] = useState('');
	const [replyDraft, setReplyDraft] = useState('');

	const rootRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onDocMouseDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (rootRef.current?.contains(target)) return;
			// An open row menu's ("Edit"/"Delete") own dropdown renders straight
			// to `document.body` too (Obsidian's `Menu` class), OUTSIDE this
			// popover's root — so clicking "Edit" in it looked exactly like an
			// outside click and closed the whole popover before the menu item's
			// own `onClick` (which needs the popover still mounted to enter edit
			// mode) ever got to run.
			if (target.instanceOf(Element) && target.closest('.menu')) return;
			onClose();
		};
		// Capture phase — a click on the gutter/margin icon that opened this
		// (or a DIFFERENT one) would otherwise reach this listener AFTER
		// React's own onClick has already fired a state update, racing it.
		document.addEventListener('mousedown', onDocMouseDown, true);
		return () => document.removeEventListener('mousedown', onDocMouseDown, true);
	}, [onClose]);

	const left = Math.max(8, Math.min(anchorRect.right - POPOVER_W, window.innerWidth - POPOVER_W - 8));
	const top = Math.max(8, anchorRect.bottom + 4);

	const openRowMenu = (event: ReactMouseEvent, index: number) => {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t('view.script.comment.edit'))
				.setIcon('square-pen')
				.onClick(() => {
					setEditingIndex(index);
					setEditDraft(entries[index]?.text ?? '');
				})
		);
		menu.addItem((item) =>
			item
				.setTitle(t('project.common.delete'))
				.setIcon('trash-2')
				.onClick(() => onDeleteEntry(index))
		);
		menu.showAtMouseEvent(event.nativeEvent);
	};

	return createPortal(
		<div ref={rootRef} className="loom-comment-popover" style={{ left, top, width: POPOVER_W }}>
			{entries.map((entry, i) => (
				<div key={entry.id + i} className="loom-comment-popover-row">
					{editingIndex === i ? (
						<>
							<textarea
								className="loom-comment-popover-text"
								value={editDraft}
								onChange={(e) => setEditDraft(e.target.value)}
								autoFocus
							/>
							<div className="loom-comment-popover-actions">
								<button className="loom-rel-filter" onClick={() => setEditingIndex(null)}>
									{t('project.common.cancel')}
								</button>
								<button
									className="mod-cta"
									disabled={editDraft.trim() === '' || editDraft === entry.text}
									onClick={() => {
										onSaveEntry(i, editDraft);
										setEditingIndex(null);
									}}
								>
									{t('project.common.save')}
								</button>
							</div>
						</>
					) : (
						<div className="loom-comment-popover-row-content">
							<div className="loom-comment-popover-row-text">{entry.text}</div>
							<div className="loom-comment-popover-row-icons">
								<button
									className={
										entry.resolved
											? 'loom-comment-popover-icon-btn loom-comment-popover-icon-btn-resolved'
											: 'loom-comment-popover-icon-btn'
									}
									// Obsidian already renders its own hover tooltip from
									// `aria-label` alone — a `title` attribute on top of that
									// showed the browser's OWN native tooltip at the same time
									// (two overlapping boxes), so the dynamic "Resolved on …"
									// text has to live in `aria-label` too, not a separate prop.
									aria-label={
										entry.resolved
											? entry.resolvedAt
												? t('view.script.comment.resolvedOnAria', { date: formatResolvedAt(entry.resolvedAt) })
												: t('view.script.comment.resolvedAria')
											: t('view.script.comment.resolveThisAria')
									}
									onClick={() => onToggleResolvedEntry(i)}
								>
									<Icon name="check" />
								</button>
								<button
									className="loom-comment-popover-icon-btn"
									aria-label={t('view.script.comment.optionsAria')}
									onClick={(e) => openRowMenu(e, i)}
								>
									<Icon name="ellipsis-vertical" />
								</button>
							</div>
						</div>
					)}
				</div>
			))}
			<div className="loom-comment-popover-reply">
				<textarea
					className="loom-comment-popover-text"
					value={replyDraft}
					onChange={(e) => setReplyDraft(e.target.value)}
					placeholder={t('view.script.comment.leaveCommentPlaceholder')}
					// Opening the popover IS the request to start typing — either the
					// first comment on a brand-new marker, or the next reply.
					autoFocus={entries.length === 0}
				/>
				<button
					className="mod-cta loom-comment-popover-add"
					disabled={replyDraft.trim() === ''}
					onClick={() => {
						onAddEntry(replyDraft);
						setReplyDraft('');
					}}
				>
					{t('view.script.comment.addReply')}
				</button>
			</div>
		</div>,
		document.body
	);
}
