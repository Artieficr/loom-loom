import { App } from 'obsidian';
import { CachedLicenseState, emptyLicenseState } from './types';

/**
 * Per-device license cache, backed by `App.loadLocalStorage`/`saveLocalStorage`
 * (real `localStorage`) — deliberately NOT `Plugin.saveData()`. `saveData`
 * writes into `<vault>/.obsidian/plugins/loom-loom/data.json`, a file INSIDE
 * the vault folder, and this codebase already treats vault-folder files as
 * synced across the user's own machines (Dropbox, Obsidian Sync — see
 * `docs/ARCHITECTURE.md`'s "Playing nicely with file sync"). A device id or an
 * activation record written there would sync between two machines sharing one
 * vault and corrupt the "3 distinct devices" model instead of representing it.
 * `localStorage` lives in the Electron installation's own local profile, never
 * inside the vault, so it stays genuinely per-device even when the vault itself
 * is shared. `minAppVersion` is 1.13.0 (past this API's `@since 1.8.7`), so
 * these are called directly — no feature-detection/in-memory fallback needed.
 */

const DEVICE_ID_KEY = 'loom-loom/license-device-id';
const CACHE_KEY = 'loom-loom/license-cache';

function readRaw(app: App, key: string): unknown {
	return app.loadLocalStorage(key);
}

function writeRaw(app: App, key: string, value: unknown): void {
	app.saveLocalStorage(key, value);
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
