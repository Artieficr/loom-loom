import { TFile, normalizePath } from 'obsidian';
import { Dispatch, SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import { ProjectDef } from '../indexer';
import { LoomNavigator } from './react-view';
import { Icon, buildEntityLinkNames, buildLinkTargetLabels, openCreateLinkEntity, openEntityLink } from './common';
import { MarkdownField, MarkdownFieldHandle } from './markdown-field';
import { t } from '../i18n';
import type LoomLoomPlugin from '../main';

/** Substitute icon for older Obsidian/Lucide bundles missing `notebook-pen`. */
export const QUICK_NOTES_ICON = 'notebook-pen';

/**
 * Tracks whatever was last focused OUTSIDE any Quick Notes UI, app-wide, so a
 * panel can hand focus back to it on close. A single `focusin` listener
 * (`focusin` bubbles, unlike `focus`, so one `document`-level handler sees
 * every focus change) rather than one per panel instance — ref-counted so it
 * installs on the first mounted panel and tears down once the last one
 * unmounts, regardless of how many project tabs are open at once.
 *
 * Deliberately NOT a point-in-time capture taken when the trigger is clicked
 * or the toggle command fires: clicking the trigger button itself shifts DOM
 * focus to that button before any of our own code runs, so capturing "the
 * current activeElement" at that moment would just record the trigger —
 * `.loom-qn-panel-wrap`/`.loom-qn-trigger-wrap` (common.tsx) are excluded
 * from every focus event this listener sees, so `lastExternalFocus` always
 * reflects the last REAL field the user was working in, continuously kept up
 * to date rather than snapshotted at a timing-sensitive moment.
 *
 * `document.body`/`documentElement` are ALSO excluded — a real, reported bug
 * this fixes: on macOS specifically, clicking a plain `<button>` does not
 * give it focus at all (unlike Windows/Linux); the previously focused field
 * just blurs with nothing new taking its place, and the browser implicitly
 * parks focus on `<body>`. That still fires a genuine `focusin` for `<body>`,
 * arriving BEFORE React's own `onClick` runs — without this exclusion, that
 * transient "nothing is focused" moment overwrote `lastExternalFocus` the
 * instant the trigger was clicked, so close-to-restore always landed on
 * nothing (or wherever body-focus happened to point) instead of the field
 * the user was actually last working in.
 */
let lastExternalFocus: HTMLElement | null = null;
let focusTrackRefCount = 0;
let untrackFocus: (() => void) | null = null;

function onFocusIn(e: FocusEvent): void {
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;
	if (target === document.body || target === document.documentElement) return;
	if (target.closest('.loom-qn-panel-wrap, .loom-qn-trigger-wrap')) return;
	lastExternalFocus = target;
}

function trackFocus(): () => void {
	focusTrackRefCount++;
	if (focusTrackRefCount === 1) {
		document.addEventListener('focusin', onFocusIn);
		untrackFocus = () => document.removeEventListener('focusin', onFocusIn);
	}
	return () => {
		focusTrackRefCount--;
		if (focusTrackRefCount === 0) {
			untrackFocus?.();
			untrackFocus = null;
			lastExternalFocus = null;
		}
	};
}

/**
 * A fleeting, per-project scratchpad — write here, then copy the useful bits
 * into a proper entity note later. One real `.md` file per project (native
 * sync/search/backlinks, unlike a blob in plugin settings), mirroring
 * `scriptFilePath`/`bookFilePath` (script-view.tsx/book-view.tsx) but as a
 * genuine markdown file, since this one is meant to hold real `[[wikilinks]]`.
 */
export function quickNotesFilePath(project: ProjectDef): string {
	const base = `${project.name} Quick Notes.md`;
	return normalizePath(project.root === '' ? base : `${project.root}/${base}`);
}

export function findQuickNotesFile(plugin: LoomLoomPlugin, project: ProjectDef): TFile | null {
	return plugin.app.vault.getFileByPath(quickNotesFilePath(project));
}

/** Created on demand — nothing is scaffolded until the panel is first opened. */
export async function createQuickNotesFile(plugin: LoomLoomPlugin, project: ProjectDef): Promise<TFile> {
	const existing = findQuickNotesFile(plugin, project);
	if (existing) return existing;
	return plugin.app.vault.create(quickNotesFilePath(project), '');
}

/**
 * Registers this leaf's Quick Notes open/closed state on its own view
 * instance (`LoomNavigator.registerQuickNotesToggle`) so the global
 * `toggle-quick-notes` command (main.ts), which fires outside React, has
 * something to call on whichever leaf is currently active. Returns a plain
 * `useState` tuple — callers toggle via the setter same as any other state.
 */
export function useQuickNotesToggle(view: LoomNavigator): [boolean, Dispatch<SetStateAction<boolean>>] {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		view.registerQuickNotesToggle(() => setOpen((o) => !o));
		return () => view.registerQuickNotesToggle(null);
	}, [view]);
	return [open, setOpen];
}

/**
 * The slide-in panel itself — rendered by `NavRail` as a SIBLING of the
 * `<nav>` element (never nested inside it, so the rail's own box is never
 * affected by the panel's open/close state), and by `home-view.tsx` the same
 * way beside its own minimal stand-in rail. Always mounted (so the CSS width
 * transition on `.loom-qn-panel-wrap` actually animates open/closed instead
 * of appearing/vanishing instantly) — `open` only toggles the `-open` class.
 * Content is loaded lazily on the first open (never eagerly, so a project
 * nobody ever opens Quick Notes on never gets a file) and re-read from disk
 * on every later open too, so two leaves on the same project never show each
 * other stale content. Renders a `.loom-qn-backdrop` sibling too — a subtle,
 * `pointer-events: none` dim over the content behind the panel, fading with
 * the same open state; it never blocks clicks, since this panel is
 * deliberately not close-on-outside-click (the workflow is jot something
 * down, then browse the vault to find what to link back in — see this
 * file's top-level entry in src/views/CLAUDE.md) and the rest of the view
 * has to stay usable while the panel is open. On open, focus lands at the
 * end of the document (`MarkdownField`'s own `focusEnd` imperative handle)
 * so typing can start immediately with no click into the field first. On
 * close, focus returns to wherever it was before the panel opened
 * (`lastExternalFocus`, above) — guarded twice before ever calling `.focus()`
 * on it: `isConnected` (the field may have been unmounted entirely, e.g. the
 * user navigated to a different view on this same leaf while Quick Notes was
 * open — a plain DOM reference to a since-removed node is otherwise inert,
 * never throws, but restoring focus to it would obviously do nothing useful)
 * and same-`.loom-view` containment (never pull focus into a DIFFERENT
 * leaf/pane's field just because it happened to be the last thing focused
 * app-wide — a split-pane user working leaf B's Quick Notes shouldn't have
 * closing it suddenly jump their cursor into leaf A).
 */
export function QuickNotesPanel({
	plugin,
	view,
	project,
	open,
}: {
	plugin: LoomLoomPlugin;
	view: LoomNavigator;
	project: ProjectDef;
	open: boolean;
}) {
	const [value, setValue] = useState<string | null>(null);
	const fileRef = useRef<TFile | null>(null);
	const wasOpenRef = useRef(false);
	const fieldRef = useRef<MarkdownFieldHandle>(null);
	const focusedForOpenRef = useRef(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const wasOpenForRestoreRef = useRef(open);

	useEffect(() => trackFocus(), []);

	// Restore focus to whatever was focused before the panel opened — only on
	// the OPEN→CLOSE transition, and only past both safety checks documented
	// on this component above.
	useEffect(() => {
		const closing = wasOpenForRestoreRef.current && !open;
		wasOpenForRestoreRef.current = open;
		if (!closing) return;
		const el = lastExternalFocus;
		if (!el || !el.isConnected) return;
		const myView = wrapRef.current?.closest('.loom-view');
		// `preventScroll` — a real, reported bug otherwise: the field was
		// already fully visible before Quick Notes opened over it (an
		// overlay, never a layout reflow), but `.focus()`'s browser default
		// is to scroll its target into view regardless, nudging the page up
		// by a few px for no reason on every restore.
		if (myView && myView.contains(el)) el.focus({ preventScroll: true });
	}, [open]);

	useEffect(() => {
		if (!open) {
			wasOpenRef.current = false;
			return;
		}
		if (wasOpenRef.current) return;
		wasOpenRef.current = true;
		let cancelled = false;
		void createQuickNotesFile(plugin, project)
			.then((f) => {
				fileRef.current = f;
				return plugin.app.vault.cachedRead(f);
			})
			.then((data) => {
				if (!cancelled) setValue(data);
			});
		return () => {
			cancelled = true;
		};
	}, [plugin, project, open]);

	// Cursor lands at the end, ready to type, the instant the panel opens —
	// no click into the field needed first. Guarded to fire once per open
	// (not on every keystroke's own `value` update, which would otherwise
	// yank the cursor to the end while typing elsewhere in the document) and
	// gated on `value` actually being loaded (the field isn't mounted, so
	// `fieldRef` isn't attached yet, until the first read completes).
	useEffect(() => {
		if (!open) {
			focusedForOpenRef.current = false;
			return;
		}
		if (focusedForOpenRef.current || value === null) return;
		focusedForOpenRef.current = true;
		fieldRef.current?.focusEnd();
	}, [open, value]);

	const save = useMemo(() => {
		let timer = 0;
		return (v: string) => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				const file = fileRef.current;
				if (file) void plugin.app.vault.process(file, () => v);
			}, 600);
		};
	}, [plugin]);

	const names = useMemo(() => buildEntityLinkNames(plugin, project), [plugin, project]);
	const linkLabels = useMemo(() => buildLinkTargetLabels(plugin, project), [plugin, project]);

	return (
		<>
			<div className={open ? 'loom-qn-backdrop loom-qn-panel-open' : 'loom-qn-backdrop'} />
			<div ref={wrapRef} className={open ? 'loom-qn-panel-wrap loom-qn-panel-open' : 'loom-qn-panel-wrap'}>
			<div className="loom-qn-panel">
				<div className="loom-qn-header">
					<span className="loom-qn-title">{t('common.quickNotes')}</span>
					<button
						className="loom-qn-close"
						aria-label={t('view.quickNotes.close')}
						onClick={() => view.toggleQuickNotesPanel()}
					>
						<Icon name="x" />
					</button>
				</div>
				<div className="loom-qn-body">
					{value === null ? null : (
						<MarkdownField
							ref={fieldRef}
							app={plugin.app}
							value={value}
							onChange={(v) => {
								setValue(v);
								save(v);
							}}
							names={names}
						linkLabels={linkLabels}
						ambientSuggestDismissMs={plugin.settings.ambientLinkSuggestDismissMs}
							onOpenLink={(target, newTab) =>
								openEntityLink(plugin, view, fileRef.current?.path ?? quickNotesFilePath(project), target, newTab)
							}
							onCreateEntity={(entered, insert) => openCreateLinkEntity(plugin, project, entered, insert)}
							placeholder={t('view.quickNotes.placeholder')}
						/>
					)}
				</div>
			</div>
			</div>
		</>
	);
}
