import { CachedLicenseState, LicenseTier } from './types';

/**
 * How long a device keeps unlocking unlimited projects after its last
 * successful activate/validate, with no internet required in between. Must
 * not break offline use — see CLAUDE.md's Licensing section for the product
 * reasoning (a month tolerates travel/offline stretches without punishing a
 * paying user, while still re-checking well inside any billing cycle).
 */
export const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The tier a device should be treated as *right now*, purely from its cached
 * state — never makes a network call itself. `verifiedAt` only ever moves
 * forward on a successful check (see provider.ts's ok/thrown distinction), so
 * this naturally goes quiet (no re-verification needed) while offline and
 * naturally reverts to 'free' once the grace window lapses.
 */
export function resolveTier(cache: CachedLicenseState, now: number): LicenseTier {
	if (!cache.activation) return 'free';
	return now - cache.activation.verifiedAt < GRACE_PERIOD_MS ? 'paid' : 'free';
}

/** Epoch ms the current activation's grace period runs out, or null if there
 *  is no activation to expire. Read-model helper for the settings UI. */
export function graceExpiresAt(cache: CachedLicenseState): number | null {
	return cache.activation ? cache.activation.verifiedAt + GRACE_PERIOD_MS : null;
}
