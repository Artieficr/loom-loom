/**
 * The seam between the plugin and whichever license-key backend actually
 * issues/checks keys. Nothing outside this file (and each concrete provider)
 * ever needs to know that shape — manager.ts talks only to this interface, so
 * swapping the backend later (or testing against StubLicenseProvider) never
 * touches gating.ts, cache-store.ts, settings.ts or project.ts.
 *
 * Every method returns a result rather than throwing for a *definite* answer
 * from the server (key invalid, activation limit reached, key deactivated,
 * activation not found, …) — `ok: false` with a `reason`. A thrown error means
 * the server was never reached at all (offline, DNS, timeout, 5xx). That
 * distinction is load-bearing: manager.ts must revoke immediately on a
 * definite "no", but must leave the cached verdict untouched — and let the
 * 30-day grace period keep running — on a thrown error. See grace.ts.
 */

export interface ActivateResult {
	ok: boolean;
	/** Present when ok is true. */
	activationId?: string;
	/** Present when ok is false — why the provider refused (e.g. "invalid key",
	 *  "activation limit reached (3/3)", "key expired"). */
	reason?: string;
}

export interface ValidateResult {
	ok: boolean;
	reason?: string;
}

export interface DeactivateResult {
	ok: boolean;
	reason?: string;
	/** True when `ok` is false specifically because the server couldn't be
	 *  reached at all (offline/DNS/timeout) — set by `LicenseManager.
	 *  deactivateThisDevice`, which is the one place in this seam that
	 *  catches a provider's thrown "unreachable" error itself rather than
	 *  letting it propagate, so the distinction has to be re-surfaced here
	 *  for the settings UI to act on (e.g. showing "Can't reach the server"
	 *  instead of a generic failure message). */
	unreachable?: boolean;
	/** True when `ok` is false because the server has no record of this
	 *  activation any more (a definite 404, not a network issue) — the
	 *  device is, as far as the license server is concerned, already not
	 *  activated. `LicenseManager.deactivateThisDevice` treats this as
	 *  success and reconciles the local cache to match, rather than leaving
	 *  the device stuck looking activated forever with no way to recover
	 *  (this cache/server mismatch is exactly what a stale/incorrectly
	 *  parsed activation id from a much earlier bug would produce). */
	notFound?: boolean;
}

export interface LicenseProvider {
	/** Activates `key` for this device, labeled `label` (e.g. a human-readable
	 *  device name) so it's identifiable in the provider's own dashboard. */
	activate(key: string, deviceId: string, label: string): Promise<ActivateResult>;
	/** Confirms an existing activation is still good. */
	validate(key: string, activationId: string, deviceId: string): Promise<ValidateResult>;
	/** Frees this device's activation slot. */
	deactivate(key: string, activationId: string, deviceId: string): Promise<DeactivateResult>;
}
