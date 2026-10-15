import { preventOrphans } from './fountain';

/**
 * The tutorial's lock over a container (a view's root row, or a modal):
 * everything in it dims except its `[data-tutorial-target]` elements and its
 * cues, and clicks reach only the targets. Plain DOM, so the React views
 * (`TutorialSpotlight`, common.tsx) and the Obsidian modals (project.ts)
 * share it. Returns the teardown.
 *
 * Two layers, both rewritten per animation frame straight in the DOM (not
 * React state, so a hole keeps pace with a hover-scaled button): the visible
 * dim is an SVG `<mask>` with one black path per hole — targets AND cues, each
 * its own shape, so overlapping holes merge (a single even-odd path would
 * re-dim the overlap) — and an invisible click blocker, an even-odd
 * clip-path with holes for the targets only, so a cue looks lifted while
 * what's behind it stays unclickable. With no target in the container
 * nothing dims; the wheel still scrolls whatever is under the pointer.
 */
export function startSpotlight(root: HTMLElement): () => void {
	// The lock is an aid: if building it fails, log it and leave the page
	// usable rather than letting the error take the whole view down.
	try {
		return buildSpotlight(root);
	} catch (err) {
		console.error('Loom Loom: tutorial spotlight failed', err);
		return () => {};
	}
}

function buildSpotlight(root: HTMLElement): () => void {
	const win = root.win;
	const maskId = `loom-tutorial-mask-${Math.random().toString(36).slice(2)}`;
	// An array: `createSvg` adds a string `cls` with classList.add, which
	// throws on a space-separated list (unlike `createEl`'s className).
	const dim = root.createSvg('svg', { cls: ['loom-tutorial-dim', 'loom-tutorial-off'], attr: { 'aria-hidden': 'true' } });
	const mask = dim.createSvg('defs').createSvg('mask', { attr: { id: maskId } });
	mask.createSvg('rect', { attr: { width: '100%', height: '100%', fill: 'white' } });
	const holesEl = mask.createSvg('g');
	dim.createSvg('rect', {
		cls: 'loom-tutorial-dim-fill',
		attr: { width: '100%', height: '100%', mask: `url(#${maskId})` },
	});
	const block = root.createDiv({ cls: 'loom-tutorial-block loom-tutorial-off' });
	block.addEventListener('wheel', (e) => {
		// Scroll whatever scrollable element sits under the lock.
		block.addClass('loom-tutorial-pass');
		let el = block.doc.elementFromPoint(e.clientX, e.clientY);
		block.removeClass('loom-tutorial-pass');
		for (; el && el !== root; el = el.parentElement) {
			if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
				el.scrollBy({ top: e.deltaY, left: e.deltaX });
				return;
			}
		}
	});

	let frame = 0;
	let last = '';
	let revealed = false;
	const tick = () => {
		const box = root.getBoundingClientRect();
		const targets = [...root.querySelectorAll<HTMLElement>('[data-tutorial-target]')];
		// A step's first target may be scrolled out of sight (a section far down
		// a page): bring it into view once, as the step starts.
		if (!revealed && targets.length > 0) {
			revealed = true;
			reveal(targets[0]);
		}
		// Each hole takes its element's own shape: a target's is padded, a
		// cue's cut exactly to it.
		const hole = (el: HTMLElement, pad: number) => {
			const r = litRect(el);
			if (!r) return '';
			const x = r.left - box.left - pad;
			const y = r.top - box.top - pad;
			const w = r.width + pad * 2;
			const h = r.height + pad * 2;
			const radius = isBox(el) ? getComputedStyle(el).borderTopLeftRadius : '0px';
			const round = radius.endsWith('%')
				? parseFloat(radius) >= 50
				: parseFloat(radius) >= Math.min(r.width, r.height) / 2;
			if (round) {
				const rr = Math.max(w, h) / 2;
				const cx = x + w / 2;
				const cy = y + h / 2;
				return `M${cx - rr} ${cy}A${rr} ${rr} 0 1 0 ${cx + rr} ${cy}A${rr} ${rr} 0 1 0 ${cx - rr} ${cy}Z`;
			}
			const k = Math.min((parseFloat(radius) || 0) + pad, w / 2, h / 2);
			return (
				`M${x + k} ${y}H${x + w - k}A${k} ${k} 0 0 1 ${x + w} ${y + k}V${y + h - k}` +
				`A${k} ${k} 0 0 1 ${x + w - k} ${y + h}H${x + k}A${k} ${k} 0 0 1 ${x} ${y + h - k}` +
				`V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`
			);
		};
		const targetHoles = targets.map((el) => hole(el, 6)).filter(Boolean);
		// The click blocker is one even-odd path, where a hole inside another
		// hole fills back in — so a lit element lying within another's lit area
		// (a cue's button in a lit popover) leaves its hole to that one. By
		// area, not by DOM: a cue can hang outside the element it's part of.
		const rects = targets.map((el) => litRect(el));
		const within = (inner: DOMRect, outer: DOMRect) =>
			inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
		const blockHoles = targets
			.filter((el, i) => {
				const r = rects[i];
				return r !== null && !rects.some((o, j) => j !== i && o !== null && within(r, o) && !(within(o, r) && j > i));
			})
			.map((el) => hole(el, 6))
			.filter(Boolean);
		const cueHoles =
			targetHoles.length > 0
				? [...root.querySelectorAll<HTMLElement>('.loom-start-cue')].map((el) => hole(el, 0)).filter(Boolean)
				: [];
		// Always-usable controls (the rail's pause button): undimmed and
		// clickable, but not lit — cut exactly, like a cue.
		const freeHoles =
			targetHoles.length > 0
				? [...root.querySelectorAll<HTMLElement>('[data-tutorial-free]')].map((el) => hole(el, 0)).filter(Boolean)
				: [];
		const key = `${box.width}x${box.height}|${targetHoles.join('')}|${cueHoles.join('')}|${freeHoles.join('')}`;
		if (key !== last) {
			last = key;
			const on = targetHoles.length > 0;
			dim.toggleClass('loom-tutorial-off', !on);
			block.toggleClass('loom-tutorial-off', !on);
			holesEl.empty();
			for (const d of [...targetHoles, ...cueHoles, ...freeHoles]) holesEl.createSvg('path', { attr: { d, fill: 'black' } });
			block.setCssProps({
				'--loom-tutorial-clip': on
					? `path(evenodd, 'M0 0H${box.width}V${box.height}H0Z${blockHoles.join('')}${freeHoles.join('')}')`
					: 'none',
			});
		}
		frame = win.requestAnimationFrame(tick);
	};
	tick();
	return () => {
		win.cancelAnimationFrame(frame);
		dim.remove();
		block.remove();
	};
}

/** Whether an element draws a box of its own — a background, or borders on
 *  both sides (a section's top divider alone doesn't count). Lit as that
 *  whole box; one that doesn't is lit as what's in it (`contentRect`). */
function isBox(el: Element): boolean {
	if (el.matches(ATOMIC)) return true;
	const style = getComputedStyle(el);
	const bg = style.backgroundColor;
	const painted = bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg);
	return painted || (parseFloat(style.borderLeftWidth) > 0 && parseFloat(style.borderRightWidth) > 0);
}

/** The area a lit element is lit as, or null when it shows nothing. */
function litRect(el: HTMLElement): DOMRect | null {
	const r = isBox(el) ? el.getBoundingClientRect() : contentRect(el);
	return r && (r.width > 0 || r.height > 0) ? r : null;
}

/** What a lit element shows as one whole piece: a control, a chip, an
 *  editor, a picker, an icon. */
const ATOMIC =
	'input, select, textarea, button, svg, img, .loom-chip, .cm-editor, .loom-md-field, .loom-combo, .loom-start-cue';

/** The box around what `el` actually shows — its text (measured as text,
 *  not as the stretched block holding it) and its whole controls — or null
 *  when it shows nothing. */
function contentRect(el: HTMLElement): DOMRect | null {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	const add = (r: DOMRect) => {
		if (r.width === 0 && r.height === 0) return;
		left = Math.min(left, r.left);
		top = Math.min(top, r.top);
		right = Math.max(right, r.right);
		bottom = Math.max(bottom, r.bottom);
	};
	const range = el.doc.createRange();
	const walk = (node: Node) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				if (child.textContent?.trim()) {
					range.selectNodeContents(child);
					add(range.getBoundingClientRect());
				}
			} else if (child.nodeType === Node.ELEMENT_NODE) {
				const element = child as Element;
				if (isBox(element)) add(element.getBoundingClientRect());
				else walk(element);
			}
		}
	};
	walk(el);
	return left === Infinity ? null : new DOMRect(left, top, right - left, bottom - top);
}

/** Scrolls `el`'s nearest scrolling ancestor — that one only, never the
 *  ancestors beyond it — so `el` sits a quarter of the way down it, unless
 *  it's already fully in view. */
function reveal(el: HTMLElement): void {
	let box = el.parentElement;
	while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) {
		box = box.parentElement;
	}
	if (!box) return;
	const r = el.getBoundingClientRect();
	const b = box.getBoundingClientRect();
	if (r.top >= b.top && r.bottom <= b.bottom) return;
	box.scrollBy({ top: r.top - b.top - b.height / 4, behavior: 'smooth' });
}

/** The cue arrows' paths: under a button turning up to it (`up`), sideways
 *  pointing left / right. Shared with the React `StartCue` (common.tsx). */
export const CUE_ARROW = {
	up: { viewBox: '0 0 12 24', d: 'M1 12 H5 a3 3 0 0 0 3 -3 V3 M5 6 L8 3 L11 6', cls: 'loom-start-arrow' },
	left: { viewBox: '0 0 24 12', d: 'M23 6 H2 M6 2 L2 6 L6 10', cls: 'loom-start-arrow-side' },
	right: { viewBox: '0 0 24 12', d: 'M1 6 H22 M18 2 L22 6 L18 10', cls: 'loom-start-arrow-side' },
};

/**
 * A cue for plain-DOM surfaces (modals): in the flow right under what it
 * means, no arrow — the React `StartCue`'s `inline` variant. Its text can
 * change as the walk-through moves on.
 */
export function createInlineCue(parent: HTMLElement): { el: HTMLElement; setText: (text: string) => void } {
	const el = parent.createDiv({ cls: 'loom-start-cue loom-start-cue-inline' });
	const label = el.createSpan({ cls: 'loom-start-cue-text' });
	return {
		el,
		setText: (text) => {
			// Short words (articles, prepositions) stay with the word after.
			const shown = preventOrphans(text);
			if (label.getText() === shown) return;
			label.setText(shown);
			// Fade in again, so each new step visibly appears.
			el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: 'ease-out' });
		},
	};
}
