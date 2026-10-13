import { Menu } from 'obsidian';
import { MouseEvent as ReactMouseEvent, ReactElement, ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { CommentEntry, UnresolvedCommentRow, UndecidedAltRow } from './script-notes';
import { AnnotationSpan } from '../fountain';
import { Icon } from './common';

const POPOVER_W = 320;

/**
 * A comment THREAD's card, anchored with its TOP-RIGHT corner on the icon
 * that opened it. Portalled to `document.body`: Obsidian's workspace-leaf DOM
 * applies CSS `contain`, which re-bases `position: fixed` to the leaf.
 *
 * `entries` is the marker id's full `CommentEntry[]` (a marked range is a
 * thread). Each entry is a compact row (text, a resolve check, an ellipsis
 * menu for edit/delete); the reply box at the bottom always appends another.
 * `entries` is `[]` for a brand-new marker, where the reply box alone is the
 * compose surface.
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
		const ownerDoc = rootRef.current?.doc ?? activeDocument;
		ownerDoc.addEventListener('mousedown', onDocMouseDown, true);
		return () => ownerDoc.removeEventListener('mousedown', onDocMouseDown, true);
	}, [onClose]);

	const left = Math.max(8, Math.min(anchorRect.right - POPOVER_W, activeWindow.innerWidth - POPOVER_W - 8));
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
												? t('view.script.comment.resolvedOnAria', { date: new Date(entry.resolvedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) })
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
		// Opened by a click, so the active window is the one it belongs in.
		activeDocument.body
	);
}

/**
 * The "Comments" browse-all side panel — every comment span with at least
 * one still-unresolved reply, grouped with its own unresolved replies
 * underneath. Shared by the Script view's own panel and Book's identical one
 * (script-view.tsx / book-view.tsx) — the two differ only in `onJump`'s own
 * navigation (Script scrolls a Pages-mode page number; Book scrolls to a
 * rendered `[data-loom-annotation-content]` element), which the caller
 * supplies rather than this component knowing about either.
 */
/** The aside shell both browse-all panels share: title + close, then either
 *  the empty message or the rows. */
function BrowserPanel({
	title,
	closeLabel,
	empty,
	onClose,
	children,
}: {
	title: string;
	closeLabel: string;
	empty: string | null;
	onClose: () => void;
	children: ReactNode;
}): ReactElement {
	return (
		<aside className="loom-script-nav">
			<div className="loom-script-nav-head">
				{title}
				<button className="loom-rel-filter" aria-label={closeLabel} onClick={onClose}>
					<Icon name="chevron-left" />
				</button>
			</div>
			{empty !== null ? <div className="loom-script-nav-empty">{empty}</div> : children}
		</aside>
	);
}

export function CommentsBrowserPanel({
	rows,
	onJump,
	onClose,
}: {
	rows: UnresolvedCommentRow[];
	onJump: (span: AnnotationSpan) => void;
	onClose: () => void;
}): ReactElement {
	return (
		<BrowserPanel
			title={t('view.entity.script.unresolvedComments')}
			closeLabel={t('view.entity.script.hideComments')}
			empty={rows.length === 0 ? t('view.entity.script.noUnresolvedComments') : null}
			onClose={onClose}
		>
			{rows.map(({ span, excerpt, unresolvedEntries }) => (
				<div key={span.id} className="loom-script-comments-panel-group">
					<button className="loom-script-nav-act loom-script-comments-panel-excerpt" onClick={() => onJump(span)}>
						{excerpt}
					</button>
					<div className="loom-script-comments-panel-nested">
						{unresolvedEntries.map((entry) => (
							<button
								key={entry.id + entry.createdAt}
								className="loom-script-comments-panel-reply"
								onClick={() => onJump(span)}
							>
								{entry.text.trim() === '' ? t('view.entity.script.emptyReply') : entry.text}
							</button>
						))}
					</div>
				</div>
			))}
		</BrowserPanel>
	);
}

/**
 * The "Alternatives" browse-all side panel — every alt-text span with no
 * ACCEPTED option yet ("still in doubt"). Same sharing reasoning as
 * `CommentsBrowserPanel` above.
 */
export function AlternativesBrowserPanel({
	rows,
	onJump,
	onClose,
}: {
	rows: UndecidedAltRow[];
	onJump: (span: AnnotationSpan) => void;
	onClose: () => void;
}): ReactElement {
	return (
		<BrowserPanel
			title={t('view.entity.script.unfinalizedAlternatives')}
			closeLabel={t('view.entity.script.hideAlternatives')}
			empty={rows.length === 0 ? t('view.entity.script.everyAlternativeAccepted') : null}
			onClose={onClose}
		>
			{rows.map(({ span, excerpt }) => (
				<button
					key={span.id}
					className="loom-script-nav-act loom-script-comments-panel-excerpt"
					onClick={() => onJump(span)}
				>
					{excerpt}
				</button>
			))}
		</BrowserPanel>
	);
}
