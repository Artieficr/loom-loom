import { ActivateResult, DeactivateResult, LicenseProvider, ValidateResult } from './provider';

/**
 * In-memory dev/test `LicenseProvider` — no network, no Polar account needed.
 * Exercises the whole stack (gating -> settings UI -> manager -> cache-store ->
 * grace.ts) end to end: the free-tier limit, activation, the 3-device cap, a
 * definite rejection, and — via `setStubNetworkDown` — the "offline, cached
 * verdict keeps ruling until the grace period lapses" path, all without
 * needing `PolarLicenseProvider` to be live. This is the active provider until
 * a real Polar account exists to swap in (see `main.ts`).
 */
export const STUB_VALID_KEY = 'LOOM-STUB-DEV-KEY';
export const STUB_ACTIVATION_LIMIT = 3;

interface StubActivation {
	deviceId: string;
	activationId: string;
}

export class StubLicenseProvider implements LicenseProvider {
	private activations: StubActivation[] = [];
	/** Toggle to simulate "internet unreachable" — every call throws instead of
	 *  resolving, so the grace-period offline path can be exercised on demand. */
	private networkDown = false;

	setNetworkDown(down: boolean): void {
		this.networkDown = down;
	}

	private assertOnline(): void {
		if (this.networkDown) throw new Error('Stub: simulated network failure (no internet).');
	}

	async activate(key: string, deviceId: string, _label: string): Promise<ActivateResult> {
		this.assertOnline();
		if (key !== STUB_VALID_KEY) return { ok: false, reason: 'Invalid license key.' };
		const existing = this.activations.find((a) => a.deviceId === deviceId);
		if (existing) return { ok: true, activationId: existing.activationId };
		if (this.activations.length >= STUB_ACTIVATION_LIMIT) {
			return {
				ok: false,
				reason: `Activation limit reached (${STUB_ACTIVATION_LIMIT}/${STUB_ACTIVATION_LIMIT} devices). Deactivate one first.`,
			};
		}
		const activationId = `stub-activation-${deviceId}`;
		this.activations.push({ deviceId, activationId });
		return { ok: true, activationId };
	}

	async validate(key: string, activationId: string, deviceId: string): Promise<ValidateResult> {
		this.assertOnline();
		if (key !== STUB_VALID_KEY) return { ok: false, reason: 'Invalid license key.' };
		const found = this.activations.find((a) => a.activationId === activationId && a.deviceId === deviceId);
		if (!found) return { ok: false, reason: 'Activation not found — it may have been deactivated elsewhere.' };
		return { ok: true };
	}

	async deactivate(key: string, activationId: string, deviceId: string): Promise<DeactivateResult> {
		this.assertOnline();
		if (key !== STUB_VALID_KEY) return { ok: false, reason: 'Invalid license key.' };
		this.activations = this.activations.filter(
			(a) => !(a.activationId === activationId && a.deviceId === deviceId)
		);
		return { ok: true };
	}
}
