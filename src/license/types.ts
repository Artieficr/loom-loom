/**
 * Freemium licensing types. Dependency-free (no Obsidian imports) so this file
 * and grace.ts/gating.ts stay Node-runnable for standalone verification, the
 * same discipline fountain.ts uses.
 */

export type LicenseTier = 'free' | 'paid';

/** One device's activation of a license key, as recorded by the provider. */
export interface DeviceActivation {
	/** The provider's id for this specific activation (needed to deactivate it). */
	activationId: string;
	/** Epoch ms of the last time this activation was confirmed good — by an
	 *  activate call or a later validate call. The grace period counts down
	 *  from this, and it is only ever moved forward by a *successful* check. */
	verifiedAt: number;
}

/** Everything persisted per-device (never vault-synced — see cache-store.ts). */
export interface CachedLicenseState {
	/** Stable id for this Obsidian installation, generated once. Sent to the
	 *  provider as the activation's device label/id. */
	deviceId: string;
	/** This device's own activation of the currently-entered key, or null if
	 *  never activated (or deactivated since). */
	activation: DeviceActivation | null;
	/** Epoch ms of the last activate/validate attempt, successful or not — used
	 *  only to throttle re-checks, not to decide the tier. */
	lastCheckAt: number | null;
	/** Outcome of that last attempt: true = reached the provider and it said
	 *  yes, false = reached the provider and it said no (a definite rejection —
	 *  revoked immediately, never waits out the grace period), null = never
	 *  reached the provider at all (never checked, or the last attempt
	 *  couldn't connect — the grace period keeps counting down silently). */
	lastCheckOk: boolean | null;
	/** Human-readable reason for the last failure/rejection, for the settings UI. */
	lastError: string | null;
}

export function emptyLicenseState(deviceId: string): CachedLicenseState {
	return { deviceId, activation: null, lastCheckAt: null, lastCheckOk: null, lastError: null };
}

/** Read-model for the settings UI — derived from CachedLicenseState, never stored. */
export interface LicenseStatus {
	tier: LicenseTier;
	deviceId: string;
	activated: boolean;
	/** Epoch ms the current grace period runs out, or null if not activated. */
	graceExpiresAt: number | null;
	lastCheckAt: number | null;
	lastCheckOk: boolean | null;
	lastError: string | null;
}
