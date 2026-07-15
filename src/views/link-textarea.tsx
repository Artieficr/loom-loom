import {
	KeyboardEvent as ReactKeyboardEvent,
	MutableRefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { startTextareaResize } from './common';

/**
 * A textarea with the two most-missed editor behaviors for note-like fields:
 * typing `[[` auto-closes to `[[]]`, and an anchored suggestion popup offers
 * note names while the cursor sits inside an unclosed `[[`. Insertion keeps
 * the caret after the closing brackets, matching the native editor feel.
 */
export function LinkTextarea({
	value,
	onChange,
	names,
	rows,
	placeholder,
	textareaRef,
}: {
	value: string;
	onChange: (value: string) => void;
	names: string[];
	rows?: number;
	placeholder?: string;
	/** Exposes the underlying textarea node to the parent (e.g. for a resize-memory hook). */
	textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
}) {
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const pendingCaret = useRef<number | null>(null);
	const [suggest, setSuggest] = useState<{ query: string; start: number; x: number; y: number } | null>(null);
	const [selected, setSelected] = useState(0);

	useEffect(() => {
		const el = taRef.current;
		if (el && pendingCaret.current !== null) {
			el.setSelectionRange(pendingCaret.current, pendingCaret.current);
			pendingCaret.current = null;
		}
	}, [value]);

	const matches = useMemo(() => {
		if (!suggest) return [];
		const q = suggest.query.toLowerCase();
		const starts = names.filter((n) => n.toLowerCase().startsWith(q));
		const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
		return [...starts, ...contains].slice(0, 8);
	}, [suggest, names]);

	const detect = (text: string, caret: number) => {
		const el = taRef.current;
		const m = /\[\[([^[\]\n]*)$/.exec(text.slice(0, caret));
		if (m && el) {
			const { x, y } = caretCoords(el, text, caret);
			setSuggest({ query: m[1], start: caret - m[1].length, x, y });
			setSelected(0);
		} else {
			setSuggest(null);
		}
	};

	const applyEdit = (next: string, caret: number) => {
		pendingCaret.current = caret;
		onChange(next);
		detect(next, caret);
	};

	const insertName = (name: string) => {
		const el = taRef.current;
		if (!el || !suggest) return;
		const head = value.slice(0, suggest.start) + name;
		const tail = value.slice(el.selectionStart);
		const next = tail.startsWith(']]') ? head + tail : head + ']]' + tail.replace(/^\]/, '');
		applyEdit(next, head.length + 2);
		setSuggest(null);
	};

	const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget;
		if (suggest && matches.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelected((s) => (s + 1) % matches.length);
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelected((s) => (s - 1 + matches.length) % matches.length);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				insertName(matches[selected]);
				return;
			}
			if (e.key === 'Escape') {
				setSuggest(null);
				return;
			}
		}
		const start = el.selectionStart;
		const end = el.selectionEnd;
		if (e.key === '[' && start === end && value[start - 1] === '[' && !value.slice(start).startsWith(']]')) {
			e.preventDefault();
			applyEdit(value.slice(0, start) + '[]]' + value.slice(end), start + 1);
			return;
		}
		if (e.key === ']' && start === end && value[start] === ']') {
			e.preventDefault();
			applyEdit(value, start + 1);
		}
	};

	return (
		<div className="loom-link-textarea">
			<textarea
				ref={(el) => {
					taRef.current = el;
					if (textareaRef) textareaRef.current = el;
				}}
				rows={rows}
				placeholder={placeholder}
				value={value}
				onChange={(e) => {
					onChange(e.target.value);
					detect(e.target.value, e.target.selectionStart);
				}}
				onKeyDown={onKeyDown}
				onClick={(e) => detect(value, e.currentTarget.selectionStart)}
				onBlur={() => setSuggest(null)}
			/>
			<div className="loom-resize-edge" onMouseDown={(e) => startTextareaResize(taRef.current, e)} />
			{suggest && matches.length > 0 ? (
				<div className="suggestion-container loom-suggest" style={{ left: suggest.x, top: suggest.y }}>
					{matches.map((name, i) => (
						<div
							key={name}
							className={i === selected ? 'suggestion-item is-selected' : 'suggestion-item'}
							// mousedown (not click) so the textarea keeps focus
							onMouseDown={(e) => {
								e.preventDefault();
								insertName(name);
							}}
							onMouseMove={() => setSelected(i)}
						>
							{name}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * Pixel position of a caret index inside a textarea, in fixed/viewport
 * coordinates, via the standard hidden-mirror technique.
 */
function caretCoords(el: HTMLTextAreaElement, text: string, index: number): { x: number; y: number } {
	const mirror = el.doc.body.createDiv({ cls: 'loom-caret-mirror' });
	const style = el.win.getComputedStyle(el);
	for (const prop of [
		'font-family',
		'font-size',
		'font-weight',
		'line-height',
		'letter-spacing',
		'padding',
		'border-width',
		'box-sizing',
	] as const) {
		mirror.style.setProperty(prop, style.getPropertyValue(prop));
	}
	mirror.style.setProperty('width', `${el.clientWidth}px`);
	mirror.textContent = text.slice(0, index);
	const marker = mirror.createSpan({ text: '​' });
	const rect = el.getBoundingClientRect();
	const lineHeight = parseFloat(style.lineHeight) || 18;
	const x = rect.left + marker.offsetLeft - el.scrollLeft;
	const y = rect.top + marker.offsetTop - el.scrollTop + lineHeight;
	mirror.remove();
	return { x, y };
}
