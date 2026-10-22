import {
	FountainElement,
	ParsedScript,
	TitlePage,
	elementText,
	hasTitlePage,
	stripAnnotationMarkers,
	stripEntityLinksForDisplay,
	withEscapes,
} from './fountain';

/**
 * A minimal PDF writer, just wide enough for a screenplay.
 *
 * Hand-rolled rather than pulling in a PDF library, and that's affordable here
 * for one specific reason: a screenplay is set entirely in Courier, which is one
 * of PDF's 14 standard fonts. No font has to be embedded, no glyph metrics have
 * to be measured (Courier is monospaced at 0.6 em), and every element is plain
 * left-aligned text at a fixed indent. That turns "generate a PDF" into "emit
 * text at computed coordinates", which is a few hundred lines instead of a
 * megabyte of dependency.
 *
 * Everything here works from the PARSE, so no `[[loom:…]]` marker can reach the
 * output — scene-heading elements already carry id-stripped display text.
 */

// US Letter at 72 units per inch — the PDF default user space.
const PAGE_W = 612;
const PAGE_H = 792;
const FONT_SIZE = 12;
/** Courier advance width: 0.6 em, so 12pt Courier is exactly 7.2pt per glyph. */
const CHAR_W = FONT_SIZE * 0.6;
const LINE_H = 12;

const MARGIN_LEFT = 1.5 * 72;
const MARGIN_RIGHT = 1 * 72;
const MARGIN_TOP = 1 * 72;
const MARGIN_BOTTOM = 1 * 72;

const TEXT_W = PAGE_W - MARGIN_LEFT - MARGIN_RIGHT;

/** Indent from the left margin, and text width, per element — in points. */
const LAYOUT: Record<string, { indent: number; width: number; align?: 'right' | 'center' }> = {
	'scene-heading': { indent: 0, width: TEXT_W },
	action: { indent: 0, width: TEXT_W },
	character: { indent: 2.2 * 72, width: TEXT_W - 2.2 * 72 },
	parenthetical: { indent: 1.6 * 72, width: 2 * 72 },
	dialogue: { indent: 1 * 72, width: 3.5 * 72 },
	transition: { indent: 0, width: TEXT_W, align: 'right' },
	centered: { indent: 0, width: TEXT_W, align: 'center' },
	lyrics: { indent: 1 * 72, width: 3.5 * 72 },
	'page-break': { indent: 0, width: TEXT_W },
	section: { indent: 0, width: TEXT_W },
	synopsis: { indent: 0, width: TEXT_W },
};

/** Style bits per character: bold, italic (Courier-Bold/-Oblique/-BoldOblique,
 *  same 0.6 em advance, so wrapping and pagination don't change) and underline
 *  (a drawn line). */
const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;

/** Fountain's emphasis pairs, outermost first, with the style each applies
 *  and its marker length. */
const EMPHASIS: [RegExp, number, number][] = [
	[/\*\*\*(.+?)\*\*\*/g, BOLD | ITALIC, 3],
	[/\*\*(.+?)\*\*/g, BOLD, 2],
	[/\*(.+?)\*/g, ITALIC, 1],
	[/_(.+?)_/g, UNDERLINE, 1],
];

/** A line's printable text with one style value per character. */
interface Styled {
	text: string;
	style: number[];
}

/**
 * The printable text of a source string: comment/alt-text markers and entity
 * links reduced to what they display, emphasis marks turned into per-character
 * styles. A backslash-escaped `\*`, `\_` or `\\` prints as that character
 * (`withEscapes`, shared with `renderInline` in fountain.ts).
 */
function styledText(rawText: string): Styled {
	// Only whichever text currently sits between an alt-text pair's markers
	// exports (that IS the active option); a comment's markers print nothing.
	const src = stripAnnotationMarkers(stripEntityLinksForDisplay(rawText));
	let parsed: Styled = { text: '', style: [] };
	const text = withEscapes(src, (t) => {
		let chars = t.split('');
		let style = chars.map(() => 0);
		for (const [re, bits, mark] of EMPHASIS) {
			const keep = chars.map(() => true);
			for (const m of chars.join('').matchAll(re)) {
				const end = m.index + m[0].length;
				for (let k = 0; k < mark; k++) keep[m.index + k] = keep[end - 1 - k] = false;
				for (let k = m.index + mark; k < end - mark; k++) style[k] |= bits;
			}
			style = style.filter((_, k) => keep[k]);
			chars = chars.filter((_, k) => keep[k]);
		}
		parsed = { text: chars.join(''), style };
		return parsed.text;
	});
	// Each escape placeholder became one character again.
	const style = [...parsed.text.matchAll(/\uE000\d+\uE000|[\s\S]/g)].map((m) => parsed.style[m.index]);
	return { text, style };
}

/** Upper-cases styled text, keeping the styles when the length allows. */
function upperStyled(s: Styled): Styled {
	const text = s.text.toUpperCase();
	return { text, style: text.length === s.text.length ? s.style : text.split('').map(() => 0) };
}

/** The characters WinAnsiEncoding places at 0x80–0x9F (dashes, curly quotes,
 *  ellipsis, …), where Latin-1 has only control codes. */
const WIN_ANSI: Record<string, number> = {
	'€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
	'‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93,
	'”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
	'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

/** Escapes a string for a PDF literal in WinAnsiEncoding; a character the
 *  standard Courier has no glyph for prints as `?`. */
function pdfString(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 32;
		if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
		else if (code < 32) out += ' ';
		else if (code < 0x80 || (code >= 0xa0 && code < 0x100)) out += ch;
		else if (WIN_ANSI[ch] !== undefined) out += String.fromCharCode(WIN_ANSI[ch]);
		else out += '?';
	}
	return out;
}

/** Wraps to a character count, breaking on words and never mid-word unless the
 *  word alone is longer than the line. A joining space takes the style of the
 *  whitespace it replaces, so an underline runs across it. */
function wrap(s: Styled, widthPt: number): Styled[] {
	const cols = Math.max(1, Math.floor(widthPt / CHAR_W));
	const out: Styled[] = [];
	let offset = 0;
	for (const paragraph of s.text.split('\n')) {
		const base = offset;
		offset += paragraph.length + 1;
		let line: Styled = { text: '', style: [] };
		let gap = 0;
		let any = false;
		for (const m of paragraph.matchAll(/\S+/g)) {
			any = true;
			const at = base + m.index;
			let word: Styled = { text: m[0], style: s.style.slice(at, at + m[0].length) };
			if (line.text !== '' && line.text.length + 1 + word.text.length <= cols) {
				line = { text: `${line.text} ${word.text}`, style: [...line.style, gap, ...word.style] };
			} else {
				if (line.text !== '') out.push(line);
				// A single word longer than the column: hard-split it.
				while (word.text.length > cols) {
					out.push({ text: word.text.slice(0, cols), style: word.style.slice(0, cols) });
					word = { text: word.text.slice(cols), style: word.style.slice(cols) };
				}
				line = word;
			}
			gap = s.style[at + m[0].length] ?? 0;
		}
		out.push(any ? line : { text: '', style: [] });
	}
	return out;
}

/** One positioned line of text on a page. */
interface PdfLine {
	x: number;
	y: number;
	text: string;
	style?: number[];
}

/** A laid-out page: the positioned text, plus which elements landed on it. */
interface PdfPage {
	lines: PdfLine[];
	elements: FountainElement[];
}

function layoutElement(element: FountainElement, top: number): { lines: PdfLine[]; height: number } {
	const spec = LAYOUT[element.type] ?? LAYOUT.action;
	const text = styledText(elementText(element));
	const upper = element.type === 'scene-heading' || element.type === 'character' || element.type === 'transition';
	const wrapped = wrap(upper ? upperStyled(text) : text, spec.width);
	const lines: PdfLine[] = [];
	wrapped.forEach((line, i) => {
		let x = MARGIN_LEFT + spec.indent;
		if (spec.align === 'right') x = MARGIN_LEFT + TEXT_W - line.text.length * CHAR_W;
		else if (spec.align === 'center') x = MARGIN_LEFT + (TEXT_W - line.text.length * CHAR_W) / 2;
		lines.push({ x, y: top - i * LINE_H, ...line });
	});
	// Production scene number: right margin, same row as the heading — never
	// part of the wrapped heading text itself. Shown as a plain number (the
	// `#…#` in the source is Fountain markup, not print convention).
	if (element.type === 'scene-heading' && element.sceneNumber) {
		const label = element.sceneNumber;
		lines.push({ x: MARGIN_LEFT + TEXT_W - label.length * CHAR_W, y: top, text: label });
	}
	return { lines, height: wrapped.length * LINE_H };
}

/** Elements that hug the one below them (a cue must not be orphaned from its dialogue). */
function isTight(type: string): boolean {
	return type === 'character' || type === 'parenthetical';
}

/**
 * Lays the script out into pages of positioned lines.
 *
 * Re-flowed here rather than reusing the parser's page numbers: those are an
 * estimate from a line budget, while this is the real typeset geometry, and the
 * two must not disagree inside the file the user actually sends out.
 *
 * Walks `parsed.elements` directly rather than `paginate()` (which drops
 * `page-break` entirely for the soft/estimated pagination) — a `===` line has
 * to force a real page break here, or the syntax would do nothing in the file
 * the user actually exports.
 */
function layoutPages(parsed: ParsedScript): PdfPage[] {
	const pages: PdfPage[] = [];
	let current: PdfPage = { lines: [], elements: [] };
	let y = PAGE_H - MARGIN_TOP;
	const bottom = MARGIN_BOTTOM;

	const newPage = () => {
		pages.push(current);
		current = { lines: [], elements: [] };
		y = PAGE_H - MARGIN_TOP;
	};

	const flat = parsed.elements.filter((e) => e.type !== 'section' && e.type !== 'synopsis');
	for (let i = 0; i < flat.length; i++) {
		const element = flat[i];
		if (element.type === 'page-break') {
			// Forces a break even mid-page; an empty resulting page is dropped
			// by the filter below, same as a page with no content ever gets one.
			if (current.lines.length > 0) newPage();
			continue;
		}
		let { lines, height } = layoutElement(element, y);
		// Keep a character cue with what follows it.
		let need = height;
		if (isTight(element.type) && i + 1 < flat.length && flat[i + 1].type !== 'page-break') {
			need += layoutElement(flat[i + 1], y).height;
		}
		if (y - need < bottom && current.lines.length > 0) {
			newPage();
			({ lines, height } = layoutElement(element, y));
		}
		current.lines.push(...lines);
		current.elements.push(element);
		y -= height + (isTight(element.type) ? 0 : LINE_H);
	}
	pages.push(current);
	return pages.filter((p, i) => p.lines.length > 0 || i === 0);
}

/** The title page: title centred a third of the way down, credits below it,
 *  contact and draft date in the lower left, exactly as a script is submitted. */
function titlePageLines(title: TitlePage): PdfLine[] {
	const lines: PdfLine[] = [];
	const centre = (s: Styled, y: number) => {
		lines.push({ x: (PAGE_W - s.text.length * CHAR_W) / 2, y, ...s });
	};
	let y = PAGE_H - 3.5 * 72;
	for (const line of title.title.split('\n')) {
		centre(upperStyled(styledText(line)), y);
		y -= LINE_H;
	}
	y -= LINE_H * 2;
	for (const field of [title.credit, title.author, title.source]) {
		if (field.trim() === '') continue;
		for (const line of field.split('\n')) {
			centre(styledText(line), y);
			y -= LINE_H;
		}
		y -= LINE_H;
	}
	let low = MARGIN_BOTTOM + LINE_H * 3;
	for (const field of [title.copyright, title.contact, title.draftDate]) {
		if (field.trim() === '') continue;
		const parts = field.split('\n');
		for (let i = parts.length - 1; i >= 0; i--) {
			lines.push({ x: MARGIN_LEFT, y: low, ...styledText(parts[i]) });
			low += LINE_H;
		}
		low += LINE_H;
	}
	return lines;
}

/** Serializes positioned lines into a page content stream. */
function contentStream(lines: PdfLine[], pageNumber: number | null): string {
	const parts = ['BT', `/F1 ${FONT_SIZE} Tf`];
	if (pageNumber !== null) {
		const label = `${pageNumber}.`;
		const x = PAGE_W - MARGIN_RIGHT - label.length * CHAR_W;
		parts.push(`1 0 0 1 ${x.toFixed(2)} ${(PAGE_H - MARGIN_TOP + 24).toFixed(2)} Tm`, `(${label}) Tj`);
	}
	let font = 0;
	const underlines: string[] = [];
	for (const line of lines) {
		const at = (k: number) => line.style?.[k] ?? 0;
		// One Tj per run of the same font: F1 regular, F2 bold, F3 italic, F4 both.
		for (let i = 0, j = 0; i < line.text.length; i = j) {
			const f = at(i) & (BOLD | ITALIC);
			for (j = i + 1; j < line.text.length && (at(j) & (BOLD | ITALIC)) === f; j++);
			if (f !== font) parts.push(`/F${f + 1} ${FONT_SIZE} Tf`);
			font = f;
			const x = line.x + i * CHAR_W;
			parts.push(`1 0 0 1 ${x.toFixed(2)} ${line.y.toFixed(2)} Tm`, `(${pdfString(line.text.slice(i, j))}) Tj`);
		}
		for (let i = 0, j = 0; i < line.text.length; i = j + 1) {
			for (j = i; j < line.text.length && at(j) & UNDERLINE; j++);
			if (j === i) continue;
			const [x0, x1, y] = [line.x + i * CHAR_W, line.x + j * CHAR_W, line.y - 2];
			underlines.push(`${x0.toFixed(2)} ${y.toFixed(2)} m ${x1.toFixed(2)} ${y.toFixed(2)} l`);
		}
	}
	parts.push('ET');
	if (underlines.length > 0) parts.push('0.6 w', ...underlines, 'S');
	return parts.join('\n');
}

/**
 * Renders the script as a PDF file.
 *
 * Returns raw bytes: the xref table records byte offsets, so the document is
 * assembled as Latin-1 text and converted once at the end — building it as a
 * JS string and then UTF-8 encoding would shift every offset and produce a file
 * viewers reject.
 */
export function renderScreenplayPdf(parsed: ParsedScript): Uint8Array {
	const bodyPages = layoutPages(parsed);
	const hasTitle = hasTitlePage(parsed.titlePage);
	const pages: { lines: PdfLine[]; number: number | null }[] = [];
	if (hasTitle) pages.push({ lines: titlePageLines(parsed.titlePage), number: null });
	// Screenplays leave page 1 unnumbered; numbering starts at 2.
	bodyPages.forEach((page, i) => pages.push({ lines: page.lines, number: i === 0 ? null : i + 1 }));

	// Object 1 = catalog, 2 = pages tree, 3–6 = fonts, then page/content pairs.
	const objects: string[] = [];
	const pageObjIds: number[] = [];
	const firstPageObj = 7;
	pages.forEach((_, i) => pageObjIds.push(firstPageObj + i * 2));

	objects.push('<< /Type /Catalog /Pages 2 0 R >>');
	objects.push(
		`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] >>`
	);
	for (const name of ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']) {
		objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
	}

	pages.forEach((page, i) => {
		const contentId = pageObjIds[i] + 1;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
				`/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${contentId} 0 R >>`
		);
		const stream = contentStream(page.lines, page.number);
		objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	});

	let pdf = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefStart = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) {
		pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

	// Latin-1: one byte per code unit, so the recorded offsets stay correct.
	const bytes = new Uint8Array(pdf.length);
	for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
	return bytes;
}

/**
 * The script's elements grouped into REAL typeset pages.
 *
 * The preview renders from this rather than the parser's line-budget estimate,
 * so what's on screen and what's in the exported PDF are the same pagination —
 * two page numbers for the same scene would make the feature worthless.
 */
export function pdfPages(parsed: ParsedScript): FountainElement[][] {
	return layoutPages(parsed).map((p) => p.elements);
}

/** How many source lines a laid-out element covers — only `dialogue` merges
 *  consecutive lines into one element. */
export function elementSpan(el: FountainElement): number {
	return el.type === 'dialogue' ? el.text.split('\n').length : 1;
}

/** `"3"` / `"3–5"`: the pages holding any element whose line falls in
 *  `[from, to)`, numbered from 1 + `shift`; `—` when none does. */
export function pageRange(pages: FountainElement[][], from: number, to: number, shift = 0): string {
	const hits: number[] = [];
	pages.forEach((els, i) => {
		if (els.some((el) => el.line >= from && el.line < to)) hits.push(i + 1 + shift);
	});
	if (hits.length === 0) return '—';
	const first = hits[0];
	const last = hits[hits.length - 1];
	return first === last ? String(first) : `${first}–${last}`;
}

/** The page (numbered from 1 + `shift`) a source line renders on, matching an
 *  element's whole span. A line nothing renders on (a section heading) lands
 *  on the page holding whatever comes after it. */
export function pageOfLine(pages: FountainElement[][], line: number, shift = 0): number {
	const first = 1 + shift;
	for (let i = 0; i < pages.length; i++) {
		if (pages[i].some((el) => line >= el.line && line < el.line + elementSpan(el))) return i + first;
	}
	for (let i = 0; i < pages.length; i++) {
		if (pages[i].some((el) => el.line > line)) return i + first;
	}
	return Math.max(first, pages.length - 1 + first);
}

