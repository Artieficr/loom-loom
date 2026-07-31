import { requestUrl } from 'obsidian';
import { ActivateResult, DeactivateResult, LicenseProvider, ValidateResult } from './provider';

/**
 * Real Polar.sh license-key backend. Written now so the seam (`LicenseProvider`)
 * has a concrete non-stub implementation to swap to, but **not yet wired as the
 * active provider** in `main.ts` — there is no Polar organization/product to
 * point it at yet, and the exact wire format below is UNVERIFIED (see the TODO
 * on `body()`). Treat every response shape here as a best guess from Polar's
 * TypeScript SDK, not confirmed against a live request. Smoke-test against a
 * real account before flipping `main.ts` over to this provider.
 *
 * Uses Obsidian's `requestUrl`, never `fetch` — required for mobile (no CORS
 * layer) and it's what Obsidian's own plugin review checks for.
 */

const BASE_URL = 'https://api.polar.sh/v1/customer-portal/license-keys';

export class PolarLicenseProvider implements LicenseProvider {
	constructor(private organizationId: string) {}

	async activate(key: string, deviceId: string, label: string): Promise<ActivateResult> {
		const res = await this.post('activate', { key, organizationId: this.organizationId, label, deviceId });
		if (res.ok) {
			// TODO: confirm the actual field name for the returned activation id
			// (`activation.id`? `id`? `activation_id`?) once this can be tested
			// against a live key.
			const nested = res.body.activation as { id?: unknown } | undefined;
			const activationId = nested?.id ?? res.body.id;
			if (typeof activationId === 'string') return { ok: true, activationId };
			return { ok: false, reason: 'Activated, but the response had no recognizable activation id.' };
		}
		return { ok: false, reason: res.reason };
	}

	async validate(key: string, activationId: string, deviceId: string): Promise<ValidateResult> {
		const res = await this.post('validate', {
			key,
			organizationId: this.organizationId,
			activationId,
			deviceId,
		});
		return res.ok ? { ok: true } : { ok: false, reason: res.reason };
	}

	async deactivate(key: string, activationId: string, deviceId: string): Promise<DeactivateResult> {
		const res = await this.post('deactivate', {
			key,
			organizationId: this.organizationId,
			activationId,
			deviceId,
		});
		return res.ok ? { ok: true } : { ok: false, reason: res.reason };
	}

	/**
	 * TODO (needs a live Polar account to verify): the field names below
	 * (`organizationId`, `activationId`, `deviceId`) follow the camelCase shape
	 * shown in Polar's own `polar-js` TypeScript SDK README — the most concrete
	 * source found without a working account. A third-party integration writeup
	 * showed a snake_case on-disk record instead (`license_key_id`,
	 * `activation_id`), which may mean the raw HTTP JSON body actually wants
	 * snake_case even though the SDK's JS-facing API is camelCase. Don't trust
	 * this until confirmed against the real API (browser network tab or docs)
	 * — if it turns out to be snake_case, this is the one place to change it.
	 */
	private async post(
		endpoint: 'activate' | 'validate' | 'deactivate',
		body: Record<string, unknown>
	): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string }> {
		try {
			const response = await requestUrl({
				url: `${BASE_URL}/${endpoint}`,
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify(body),
				throw: false,
			});
			if (response.status >= 200 && response.status < 300) {
				return { ok: true, body: (response.json ?? {}) as Record<string, unknown> };
			}
			// TODO: confirm Polar's actual error-body shape once live — guessing
			// at a `detail`/`message` field, falling back to the raw status.
			const errBody = response.json as { detail?: unknown; message?: unknown } | undefined;
			const reason =
				(typeof errBody?.detail === 'string' && errBody.detail) ||
				(typeof errBody?.message === 'string' && errBody.message) ||
				`Request failed (HTTP ${response.status}).`;
			return { ok: false, reason };
		} catch (e) {
			// requestUrl threw — couldn't reach the server at all (offline/DNS/
			// timeout). Rethrow so LicenseManager treats this as "unreachable",
			// not a definite rejection — see provider.ts.
			throw e instanceof Error ? e : new Error('Could not reach the license server.');
		}
	}
}
