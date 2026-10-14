import { addIcon } from 'obsidian';

/**
 * Lucide icons newer than the Lucide build Obsidian bundles, registered under
 * a `loom-` id so `setIcon` / `<Icon>` can use them like any built-in one.
 *
 * Copied from lucide-static 1.56.0 (ISC licence, https://lucide.dev): each is
 * the 24-unit icon body, scaled into the 100-unit box `addIcon` expects. No
 * stroke width is set, so it inherits Obsidian's own icon stroke setting (which
 * the scale then sizes exactly like a bundled icon's).
 *
 * To add one: copy the elements inside its `<svg>` from lucide.dev into ICONS.
 */
const ICONS: Record<string, string> = {
	'loom-vector-polygon':
		'<path d="m12.828 4.813 5.344 2.375"/><path d="m15.769 18.153 3.461-8.306"/><path d="m5.687 14.074 7.625 4.852"/><path d="M9.772 5.579 5.228 11.42"/><circle cx="11" cy="4" r="2"/><circle cx="15" cy="20" r="2"/><circle cx="20" cy="8" r="2"/><circle cx="4" cy="13" r="2"/>',
	'loom-eye-dashed':
		'<path d="M13.054 18.946a11 11 0 0 1-2.11 0"/><path d="M13.054 5.054a11 11 0 0 0-2.11-.001"/><path d="M17.072 6.274a11 11 0 0 1 1.753 1.173"/><path d="M18.825 16.552a11 11 0 0 1-1.753 1.174"/><path d="M2.514 13.303a11 11 0 0 1-.452-.954 1 1 0 0 1 0-.697 11 11 0 0 1 .45-.955"/><path d="M21.485 10.697a11 11 0 0 1 .453.955 1 1 0 0 1 0 .697 11 11 0 0 1-.453.954"/><path d="M5.173 7.448a11 11 0 0 1 1.753-1.174"/><path d="M6.926 17.726a11 11 0 0 1-1.753-1.174"/><circle cx="12" cy="12" r="3"/>',
};

export function registerIcons(): void {
	for (const [id, body] of Object.entries(ICONS)) {
		addIcon(
			id,
			`<g transform="scale(${100 / 24})" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${body}</g>`
		);
	}
}
