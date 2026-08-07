import en from './locales/en.json';

export type LocaleCode = 'en' | 'ru';

export interface LocaleMeta {
	code: LocaleCode;
	englishName: string;
	nativeName: string;
}

/** Feeds both the Language dropdown's options and `detectSystemLocale`'s match list. */
export const SUPPORTED_LOCALES: LocaleMeta[] = [
	{ code: 'en', englishName: 'English', nativeName: 'English' },
	{ code: 'ru', englishName: 'Russian', nativeName: 'Русский' },
];

/** Recursively flattens a nested string-leaf object type into the union of its
 *  dot-path keys (e.g. `'settings.general.language.name'`) — typed directly
 *  off `en.json`'s own shape, so a typo'd or removed key is a compile error
 *  with no codegen step required to keep this in sync. */
export type FlattenKeys<T, P extends string = ''> = {
	[K in keyof T & string]: T[K] extends string ? `${P}${K}` : FlattenKeys<T[K], `${P}${K}.`>;
}[keyof T & string];

export type LocaleKey = FlattenKeys<typeof en>;
