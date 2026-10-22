import { getLanguage } from 'obsidian';
import en from './locales/en.json';
import ru from './locales/ru.json';
import { LocaleCode, LocaleKey, SUPPORTED_LOCALES } from './types';

export type { LocaleCode, LocaleKey, LocaleMeta } from './types';
export { SUPPORTED_LOCALES } from './types';

type Catalog = { [k: string]: string | Catalog };

/** Walks a nested locale JSON object into a flat dot-path -> string map, once
 *  per locale at module load — `t()`/`tn()` then do a plain lookup, no
 *  per-call tree walk. */
function flatten(obj: Catalog, prefix = '', out: Record<string, string> = {}): Record<string, string> {
	for (const [k, v] of Object.entries(obj)) {
		const key = prefix ? `${prefix}.${k}` : k;
		if (typeof v === 'string') out[key] = v;
		else flatten(v, key, out);
	}
	return out;
}

const FLAT: Record<LocaleCode, Record<string, string>> = {
	en: flatten(en),
	ru: flatten(ru),
};

let active: LocaleCode = 'en';

export function setLocale(code: LocaleCode): void {
	active = code;
}

/** Short month names (Jan…Dec) in the active UI language, from the system's
 *  own `Intl` data rather than the catalogs. */
export function shortMonthNames(): string[] {
	const fmt = new Intl.DateTimeFormat(active, { month: 'short' });
	return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)));
}

/** Hand-rolled `{varName}` substitution — no ICU MessageFormat dependency,
 *  consistent with this codebase's preference for small hand-rolled parsing
 *  over new dependencies (see `fountain.ts`/`pdf.ts`). */
function interpolate(str: string, vars?: Record<string, string | number>): string {
	if (!vars) return str;
	return str.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Resolves a key against the active locale, falling back to English for any
 *  key that locale hasn't translated yet — the bare key itself is the final
 *  fallback and should never actually surface once `en.json` covers every
 *  key a `t()`/`tn()` call site uses. */
function resolve(key: string): string {
	return FLAT[active][key] ?? FLAT.en[key] ?? key;
}

/** An icon's search words in every language at once (each locale file's
 *  `iconSearch` section) — the map icon picker matches all of them, whatever
 *  the interface language. */
export function iconSearchWords(id: string): string {
	return Object.values(FLAT)
		.map((words) => words[`iconSearch.${id}`] ?? '')
		.join(' ');
}

export function t(key: LocaleKey, vars?: Record<string, string | number>): string {
	return interpolate(resolve(key), vars);
}

/** Picks the plural category via `Intl.PluralRules` (native, locale-aware —
 *  correctly handles Russian's one/few/many/other split vs. English's
 *  one/other) and looks up `${key}_${category}`, falling back to
 *  `${key}_other` if that exact category is missing. `count` is folded into
 *  `vars` automatically for a `{count}` placeholder.
 *
 *  `key` is a plain `string` rather than a `LocaleKey`-derived union — a
 *  pluralized key never appears whole in `en.json` (only its suffixed forms,
 *  `<key>_one`/`<key>_other`, do), so it can't be typo-checked the way `t()`'s
 *  key is. Call sites should still pass a real base key present in `en.json`
 *  as `<key>_other` (and `_one`, and for Russian `_few`/`_many`). */
export function tn(key: string, count: number, vars?: Record<string, string | number>): string {
	const category = new Intl.PluralRules(active).select(count);
	const primary = `${key}_${category}`;
	const fallback = `${key}_other`;
	const raw = FLAT[active][primary] ?? FLAT[active][fallback] ?? FLAT.en[primary] ?? FLAT.en[fallback] ?? key;
	return interpolate(raw, { count, ...vars });
}

/** The English indefinite article for `noun` ("a" / "an") — the value of the
 *  `{article}` placeholder some English templates use; other locales' templates
 *  leave the placeholder out. */
export function article(noun: string): string {
	return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

/** Reads the ISO code Obsidian itself is configured to display its UI in
 *  (`getLanguage()`, `@since 1.8.7` — well below this plugin's `1.13.0`
 *  floor) rather than the OS locale, since that's what "system language"
 *  means from inside the app. */
export function detectSystemLocale(): LocaleCode {
	const normalized = getLanguage().toLowerCase().split('-')[0];
	const match = SUPPORTED_LOCALES.find((l) => l.code === normalized);
	return match ? match.code : 'en';
}

export function resolveActiveLocale(setting: LocaleCode | 'auto'): LocaleCode {
	return setting === 'auto' ? detectSystemLocale() : setting;
}
