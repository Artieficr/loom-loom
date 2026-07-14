import { CalendarId, LoomDate } from './types';

/**
 * Calendar & date-format model.
 *
 * Every project has a `ProjectConfig` (stored in its .loom file) holding the
 * display format and an optional custom in-game calendar. Sessions always
 * track real-world (Gregorian) dates; events and everything else use the
 * project's calendar. A `LoomDate` carries its own `calendar` id so the
 * formatter always knows which month names apply.
 */

export interface MonthDef {
	/** Empty string means "use the default" (Month N). */
	name: string;
	short: string;
}

export interface CustomCalendarConfig {
	enabled: boolean;
	monthCount: number;
	months: MonthDef[];
	useShortNames: boolean;
}

export const DATE_FORMATS = [
	'MMM Do, YYYY',
	'MMMM Do, YYYY',
	'MMM Do',
	'MMMM Do',
	'YYYY.MM.DD',
	'MM.DD',
	'DD.MM',
] as const;

export type DateFormat = (typeof DATE_FORMATS)[number];

export interface ProjectConfig {
	dateFormat: DateFormat;
	customCalendar: CustomCalendarConfig;
}

export function defaultProjectConfig(): ProjectConfig {
	return {
		dateFormat: 'MMM Do, YYYY',
		customCalendar: { enabled: false, monthCount: 12, months: [], useShortNames: false },
	};
}

/** Tolerantly parses a .loom file's JSON content into a ProjectConfig. */
export function parseProjectConfig(text: string): ProjectConfig {
	const config = defaultProjectConfig();
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return config;
	}
	if (typeof data !== 'object' || data === null) return config;
	const d = data as Partial<ProjectConfig>;
	if (typeof d.dateFormat === 'string' && (DATE_FORMATS as readonly string[]).includes(d.dateFormat)) {
		config.dateFormat = d.dateFormat;
	}
	const cc = d.customCalendar;
	if (typeof cc === 'object' && cc !== null) {
		if (typeof cc.enabled === 'boolean') config.customCalendar.enabled = cc.enabled;
		if (typeof cc.useShortNames === 'boolean') config.customCalendar.useShortNames = cc.useShortNames;
		if (typeof cc.monthCount === 'number' && cc.monthCount >= 1 && cc.monthCount <= 100) {
			config.customCalendar.monthCount = Math.floor(cc.monthCount);
		}
		if (Array.isArray(cc.months)) {
			config.customCalendar.months = cc.months.map((m) => ({
				name: typeof m?.name === 'string' ? m.name : '',
				short: typeof m?.short === 'string' ? m.short : '',
			}));
		}
	}
	return config;
}

export function serializeProjectConfig(config: ProjectConfig): string {
	return JSON.stringify({ version: 1, ...config }, null, '\t');
}

// --- Parsing ---------------------------------------------------------------

const DATE_RE = /^(\d{1,4})-(\d{1,2})-(\d{1,2})(?!\d)/;

/**
 * Parses a raw frontmatter date value in year-month-day form. `calendar`
 * decides validation bounds: Gregorian months are 1–12 / days 1–31, custom
 * calendars validate against the configured month count.
 */
export function parseLoomDate(raw: unknown, calendar: CalendarId, config: ProjectConfig): LoomDate | null {
	if (typeof raw !== 'string' || raw.trim() === '') return null;
	const m = DATE_RE.exec(raw.trim());
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const maxMonth = calendar === 'custom' ? config.customCalendar.monthCount : 12;
	const maxDay = calendar === 'custom' ? 99 : 31;
	if (month < 1 || month > maxMonth || day < 1 || day > maxDay) return null;
	return {
		raw: raw.trim(),
		sortKey: year * 10000 + month * 100 + day,
		year,
		month,
		day,
		calendar,
	};
}

/** Today as a raw Gregorian date string (YYYY-MM-DD, local time). */
export function todayRaw(): string {
	const now = new Date();
	return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// --- Formatting ------------------------------------------------------------

const GREGORIAN_FULL = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December',
];
const GREGORIAN_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function ordinal(day: number): string {
	const mod100 = day % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
	switch (day % 10) {
		case 1: return `${day}st`;
		case 2: return `${day}nd`;
		case 3: return `${day}rd`;
		default: return `${day}th`;
	}
}

function monthName(date: LoomDate, config: ProjectConfig, short: boolean): string {
	if (date.calendar === 'gregorian') {
		const names = short ? GREGORIAN_SHORT : GREGORIAN_FULL;
		return names[date.month - 1] ?? String(date.month);
	}
	const def = config.customCalendar.months[date.month - 1];
	const full = def?.name.trim() !== '' && def ? def.name : `Month ${date.month}`;
	if (!short) return full;
	return def?.short.trim() !== '' && def ? def.short : full;
}

/** Formats a LoomDate per the project's display format. */
export function formatLoomDate(date: LoomDate, config: ProjectConfig): string {
	switch (config.dateFormat) {
		case 'MMM Do, YYYY':
			return `${monthName(date, config, true)} ${ordinal(date.day)}, ${date.year}`;
		case 'MMMM Do, YYYY':
			return `${monthName(date, config, false)} ${ordinal(date.day)}, ${date.year}`;
		case 'MMM Do':
			return `${monthName(date, config, true)} ${ordinal(date.day)}`;
		case 'MMMM Do':
			return `${monthName(date, config, false)} ${ordinal(date.day)}`;
		case 'YYYY.MM.DD':
			return `${date.year}.${pad2(date.month)}.${pad2(date.day)}`;
		case 'MM.DD':
			return `${pad2(date.month)}.${pad2(date.day)}`;
		case 'DD.MM':
			return `${pad2(date.day)}.${pad2(date.month)}`;
	}
}

/**
 * Formats available for a project. Short-month formats are only offered when
 * the custom calendar either is off (Gregorian shorts always exist) or has
 * short names enabled.
 */
export function availableDateFormats(config: ProjectConfig): DateFormat[] {
	if (config.customCalendar.enabled && !config.customCalendar.useShortNames) {
		return DATE_FORMATS.filter((f) => !f.startsWith('MMM '));
	}
	return [...DATE_FORMATS];
}
