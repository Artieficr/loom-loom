import { FountainElement, ParsedScript, TitlePage, elementText, hasTitlePage } from './fountain';

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
const LINES_PER_PAGE = Math.floor((PAGE_H - MARGIN_TOP - MARGIN_BOTTOM) / LINE_H);

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

/**
 * Strips the inline emphasis marks. A PDF could render bold/italic by switching
 * to Courier-Bold/Oblique, but screenplay convention barely uses them and
 * carrying styled runs through the wrapper would double this file's size — so
 * the marks are simply removed rather than rendered as literal asterisks.
 */
function plainText(text: string): string {
	return text
		.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/\*(.+?)\*/g, '$1')
		.replace(/_(.+?)_/g, '$1');
}

/** Escapes a string for a PDF literal and drops anything outside Latin-1. */
function pdfString(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 32;
		if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
		else if (code < 32) out += ' ';
		else if (code < 256) out += ch;
		// Beyond Latin-1 there is no glyph in a standard-encoded Courier, so
		// substitute rather than emit bytes the viewer would render as noise.
		else out += '?';
	}
	return out;
}

/** Wraps to a character count, breaking on words and never mid-word unless the
 *  word alone is longer than the line. */
function wrap(text: string, widthPt: number): string[] {
	const cols = Math.max(1, Math.floor(widthPt / CHAR_W));
	const out: string[] = [];
	for (const paragraph of text.split('\n')) {
		const words = paragraph.split(/\s+/).filter((w) => w !== '');
		if (words.length === 0) {
			out.push('');
			continue;
		}
		let line = '';
		for (const word of words) {
			const candidate = line === '' ? word : `${line} ${word}`;
			if (candidate.length <= cols) {
				line = candidate;
				continue;
			}
			if (line !== '') out.push(line);
			// A single word longer than the column: hard-split it.
			let rest = word;
			while (rest.length > cols) {
				out.push(rest.slice(0, cols));
				rest = rest.slice(cols);
			}
			line = rest;
		}
		if (line !== '') out.push(line);
	}
	return out;
}

/** One positioned line of text on a page. */
interface PdfLine {
	x: number;
	y: number;
	text: string;
}

/** A laid-out page: the positioned text, plus which elements landed on it. */
interface PdfPage {
	lines: PdfLine[];
	elements: FountainElement[];
}

function layoutElement(element: FountainElement, top: number): { lines: PdfLine[]; height: number } {
	const spec = LAYOUT[element.type] ?? LAYOUT.action;
	const text = plainText(elementText(element));
	const upper = element.type === 'scene-heading' || element.type === 'character' || element.type === 'transition';
	const wrapped = wrap(upper ? text.toUpperCase() : text, spec.width);
	const lines: PdfLine[] = [];
	wrapped.forEach((line, i) => {
		let x = MARGIN_LEFT + spec.indent;
		if (spec.align === 'right') x = MARGIN_LEFT + TEXT_W - line.length * CHAR_W;
		else if (spec.align === 'center') x = MARGIN_LEFT + (TEXT_W - line.length * CHAR_W) / 2;
		lines.push({ x, y: top - i * LINE_H, text: line });
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
		const { lines, height } = layoutElement(element, y);
		// Keep a character cue with what follows it.
		let need = height;
		if (isTight(element.type) && i + 1 < flat.length && flat[i + 1].type !== 'page-break') {
			need += layoutElement(flat[i + 1], y).height;
		}
		if (y - need < bottom && current.lines.length > 0) {
			newPage();
			const re = layoutElement(element, y);
			current.lines.push(...re.lines);
			current.elements.push(element);
			y -= re.height + (isTight(element.type) ? 0 : LINE_H);
			continue;
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
	const centre = (text: string, y: number) => {
		const clean = plainText(text);
		lines.push({ x: (PAGE_W - clean.length * CHAR_W) / 2, y, text: clean });
	};
	let y = PAGE_H - 3.5 * 72;
	for (const line of plainText(title.title).split('\n')) {
		centre(line.toUpperCase(), y);
		y -= LINE_H;
	}
	y -= LINE_H * 2;
	for (const field of [title.credit, title.author, title.source]) {
		if (field.trim() === '') continue;
		for (const line of field.split('\n')) {
			centre(line, y);
			y -= LINE_H;
		}
		y -= LINE_H;
	}
	let low = MARGIN_BOTTOM + LINE_H * 3;
	for (const field of [title.copyright, title.contact, title.draftDate]) {
		if (field.trim() === '') continue;
		const parts = plainText(field).split('\n');
		for (let i = parts.length - 1; i >= 0; i--) {
			lines.push({ x: MARGIN_LEFT, y: low, text: parts[i] });
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
	for (const line of lines) {
		if (line.text === '') continue;
		parts.push(`1 0 0 1 ${line.x.toFixed(2)} ${line.y.toFixed(2)} Tm`, `(${pdfString(line.text)}) Tj`);
	}
	parts.push('ET');
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

	// Object 1 = catalog, 2 = pages tree, 3 = font, then page/content pairs.
	const objects: string[] = [];
	const pageObjIds: number[] = [];
	const firstPageObj = 4;
	pages.forEach((_, i) => pageObjIds.push(firstPageObj + i * 2));

	objects.push('<< /Type /Catalog /Pages 2 0 R >>');
	objects.push(
		`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] >>`
	);
	objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

	pages.forEach((page, i) => {
		const contentId = pageObjIds[i] + 1;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
				`/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
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

/** Page count of the typeset PDF — the real one, from the same layout pass. */
export function pdfPageCount(parsed: ParsedScript): number {
	return layoutPages(parsed).length;
}

export { LINES_PER_PAGE };
