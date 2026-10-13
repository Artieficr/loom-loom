import { App, Platform } from 'obsidian';
import { loadCache, saveCache } from './cache-store';
import { graceExpiresAt, resolveTier } from './grace';
import { ActivateResult, DeactivateResult, LicenseProvider } from './provider';
import { CachedLicenseState, LicenseStatus, LicenseTier } from './types';
import { t } from '../i18n';

/** Floor between automatic re-checks, so app launches / the periodic timer in
 *  main.ts can't hammer the provider (`revalidateNow`'s `force` bypasses it). */
const MIN_RECHECK_GAP_MS = 12 * 60 * 60 * 1000;

/**
 * Ties cache-store + a LicenseProvider + grace.ts together behind the one
 * surface the rest of the plugin talks to. Never touches `settings.ts`'s
 * `licenseKey` field itself — the raw key is vault-synced settings data (see
 * CLAUDE.md's Licensing section for why), the manager only ever receives it
 * as a parameter from whoever calls activate/revalidateNow.
 */
export class LicenseManager {
	private cache: CachedLicenseState;
	private inFlight: Promise<void> | null = null;

	constructor(private app: App, private provider: LicenseProvider) {
		this.cache = loadCache(app);
	}

	/** Swaps the active provider (e.g. stub -> real Polar implementation) without
	 *  losing the cached device id / activation state. */
	setProvider(provider: LicenseProvider): void {
		this.provider = provider;
	}

	getTier(): LicenseTier {
		return resolveTier(this.cache, Date.now());
	}

	getStatus(): LicenseStatus {
		return {
			tier: this.getTier(),
			deviceId: this.cache.deviceId,
			activated: this.cache.activation !== null,
			graceExpiresAt: graceExpiresAt(this.cache),
			lastCheckAt: this.cache.lastCheckAt,
			lastCheckOk: this.cache.lastCheckOk,
			lastError: this.cache.lastError,
		};
	}

	private deviceLabel(): string {
		const os = Platform.isMacOS
			? 'macOS'
			: Platform.isWin
				? 'Windows'
				: Platform.isLinux
					? 'Linux'
					: Platform.isIosApp
						? 'iOS'
						: Platform.isAndroidApp
							? 'Android'
							: 'unknown OS';
		return `${this.app.vault.getName()} (${os})`;
	}

	/** Activates `key` for this device. Always makes a network call — driven by
	 *  an explicit button click in the settings UI, never automatically, so a
	 *  vault synced to several machines doesn't silently burn activation slots
	 *  the moment each one opens it. */
	async activate(key: string): Promise<ActivateResult> {
		try {
			const result = await this.provider.activate(key, this.cache.deviceId, this.deviceLabel());
			this.cache.lastCheckAt = Date.now();
			if (result.ok && result.activationId) {
				this.cache.activation = { activationId: result.activationId, verifiedAt: Date.now() };
				this.cache.lastCheckOk = true;
				this.cache.lastError = null;
			} else {
				this.cache.lastCheckOk = false;
				this.cache.lastError = result.reason ?? t('settings.license.activateFailed');
			}
			saveCache(this.app, this.cache);
			return result;
		} catch (e) {
			const reason = e instanceof Error ? e.message : t('settings.license.unreachable');
			this.cache.lastCheckAt = Date.now();
			this.cache.lastCheckOk = null;
			this.cache.lastError = reason;
			saveCache(this.app, this.cache);
			return { ok: false, reason };
		}
	}

	/** Frees this device's slot server-side. An unreachable server is reported
	 *  as `{ok:false, unreachable:true}` and the cached activation is left
	 *  alone, so the user can retry once online. A definite 404 (`notFound` —
	 *  the server has no record of this activation) means there's nothing left
	 *  to free: the local cache is reconciled and this reports success, so the
	 *  device can't get stuck looking activated. */
	async deactivateThisDevice(key: string): Promise<DeactivateResult> {
		const activation = this.cache.activation;
		if (!activation) return { ok: true };
		try {
			const result = await this.provider.deactivate(key, activation.activationId, this.cache.deviceId);
			if (result.ok || result.notFound) {
				this.cache.activation = null;
				this.cache.lastError = null;
				saveCache(this.app, this.cache);
				return { ok: true };
			}
			this.cache.lastError = result.reason ?? t('settings.license.deactivateFailed');
			saveCache(this.app, this.cache);
			return result;
		} catch (e) {
			const reason = e instanceof Error ? e.message : t('settings.license.unreachable');
			this.cache.lastError = reason;
			saveCache(this.app, this.cache);
			return { ok: false, reason, unreachable: true };
		}
	}

	/**
	 * Re-confirms the current activation is still good, throttled to at most
	 * once per `MIN_RECHECK_GAP_MS` (bypass with `force`, e.g. coming back
	 * online). No-ops entirely — no network call at all — when there is no
	 * local activation to check, so a free-tier user with no key never causes
	 * one. A definite rejection revokes immediately; a thrown error (offline)
	 * leaves the cached verdict untouched so the grace period keeps counting
	 * down silently — see provider.ts.
	 */
	async revalidateNow(key: string, force = false): Promise<void> {
		if (!this.cache.activation) return;
		if (this.inFlight) return this.inFlight;
		if (!force && this.cache.lastCheckAt !== null && Date.now() - this.cache.lastCheckAt < MIN_RECHECK_GAP_MS) {
			return;
		}
		this.inFlight = this.doRevalidate(key).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async doRevalidate(key: string): Promise<void> {
		const activation = this.cache.activation;
		if (!activation) return;
		try {
			const result = await this.provider.validate(key, activation.activationId, this.cache.deviceId);
			this.cache.lastCheckAt = Date.now();
			if (result.ok) {
				this.cache.activation = { ...activation, verifiedAt: Date.now() };
				this.cache.lastCheckOk = true;
				this.cache.lastError = null;
			} else {
				// A definite "no" from the server — revoke now rather than waiting
				// out the grace period on a refunded/revoked license.
				this.cache.activation = null;
				this.cache.lastCheckOk = false;
				this.cache.lastError = result.reason ?? t('settings.license.invalid');
			}
		} catch (e) {
			// Couldn't reach the provider at all: leave the cached activation as-is
			// so grace.ts keeps counting down from its last successful check.
			this.cache.lastCheckAt = Date.now();
			this.cache.lastCheckOk = null;
			this.cache.lastError = e instanceof Error ? e.message : t('settings.license.unreachable');
		}
		saveCache(this.app, this.cache);
	}
}
