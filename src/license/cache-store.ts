import { App } from 'obsidian';
import { CachedLicenseState, emptyLicenseState } from './types';

/**
 * Per-device license cache, backed by `App.loadLocalStorage`/`saveLocalStorage`
 * (real `localStorage`, `@since 1.8.7`) — deliberately NOT `Plugin.saveData()`.
 * `saveData` writes into `<vault>/.obsidian/plugins/loom-loom/data.json`, a file
 * INSIDE the vault folder, and this codebase already treats vault-folder files
 * as synced across the user's own machines (Dropbox, Obsidian Sync — see
 * `docs/ARCHITECTURE.md`'s "Playing nicely with file sync"). A device id or an
 * activation record written there would sync between two machines sharing one
 * vault and corrupt the "3 distinct devices" model instead of representing it.
 * `localStorage` lives in the Electron installation's own local profile, never
 * inside the vault, so it stays genuinely per-device even when the vault itself
 * is shared.
 *
 * `minAppVersion` here is still 1.7.2 (see CLAUDE.md), older than 1.8.7, so
 * every read/write is feature-detected and degrades to an in-memory, session-
 * only cache (never crashes, license state just doesn't persist) rather than
 * assuming the API exists.
 */

const DEVICE_ID_KEY = 'loom-loom/license-device-id';
const CACHE_KEY = 'loom-loom/license-cache';

/**
 * Accessed through an unrelated structural type (not `App &`) rather than
 * `App`'s own declared members — same reason `main.ts`'s
 * `registerTimestampPropertyTypes` casts `this.app` through an anonymous
 * type instead of calling a declared method directly: it's a real, guarded,
 * feature-detected optional call, and going through the typed `App` API
 * would tie it to that API's `@since` version regardless of the runtime
 * guard already covering older Obsidian builds gracefully.
 */
interface LocalStorageApi {
	loadLocalStorage?(key: string): unknown;
	saveLocalStorage?(key: string, data: unknown): void;
}

function localStorageApi(app: App): LocalStorageApi {
	const api: LocalStorageApi = app;
	return api;
}

let warnedNoLocalStorage = false;
/** Session-only fallback for pre-1.8.7 Obsidian, so state at least survives
 *  within one running session instead of erroring. */
const memoryFallback = new Map<string, unknown>();

function readRaw(app: App, key: string): unknown {
	const api = localStorageApi(app);
	if (typeof api.loadLocalStorage === 'function') return api.loadLocalStorage(key);
	if (!warnedNoLocalStorage) {
		warnedNoLocalStorage = true;
		console.warn(
			'Loom Loom: this Obsidian version has no loadLocalStorage/saveLocalStorage (added in 1.8.7) — ' +
				'license state will not persist across restarts.'
		);
	}
	return memoryFallback.get(key) ?? null;
}

function writeRaw(app: App, key: string, value: unknown): void {
	const api = localStorageApi(app);
	if (typeof api.saveLocalStorage === 'function') {
		api.saveLocalStorage(key, value);
		return;
	}
	memoryFallback.set(key, value);
}

function randomId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	// Fallback for a runtime with neither localStorage nor crypto.randomUUID —
	// not cryptographically strong, but this id only needs to be unique enough
	// to tell devices apart, never a security boundary.
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/** Stable id for this Obsidian installation, generated once and cached locally. */
export function getOrCreateDeviceId(app: App): string {
	const existing = readRaw(app, DEVICE_ID_KEY);
	if (typeof existing === 'string' && existing.length > 0) return existing;
	const id = randomId();
	writeRaw(app, DEVICE_ID_KEY, id);
	return id;
}

function isCachedLicenseState(value: unknown): value is CachedLicenseState {
	return typeof value === 'object' && value !== null && typeof (value as { deviceId?: unknown }).deviceId === 'string';
}

export function loadCache(app: App): CachedLicenseState {
	const raw = readRaw(app, CACHE_KEY);
	if (isCachedLicenseState(raw)) return raw;
	return emptyLicenseState(getOrCreateDeviceId(app));
}

export function saveCache(app: App, state: CachedLicenseState): void {
	writeRaw(app, CACHE_KEY, state);
}
