import { requestUrl } from 'obsidian';
import { ActivateResult, DeactivateResult, LicenseProvider, ValidateResult } from './provider';

/**
 * Real Polar.sh license-key backend — the active provider as of 2026-08-06, once
 * a real Polar organization/product existed to point it at. The wire format
 * below is cross-checked against Polar's published API docs (not just the SDK
 * README — see below), but still wants one real smoke test (activate/validate/
 * deactivate against a live key — there is no Polar sandbox environment for
 * this product, so that first test happens against production with a
 * 100%-off discount code) before being fully trusted.
 *
 * Uses Obsidian's `requestUrl`, never `fetch` — required for mobile (no CORS
 * layer) and it's what Obsidian's own plugin review checks for.
 *
 * **Wire format**: the raw REST body is snake_case (`organization_id`,
 * `activation_id`) even though Polar's own JS SDK exposes camelCase — the SDK
 * translates at its own boundary, we're calling the HTTP API directly. `POST
 * .../activate` requires only `key`/`organization_id`/`label` (no device-id
 * field exists on Polar's side — `label` IS the human-readable device
 * identifier Polar stores against the activation) and its response body IS the
 * activation object itself (`id` at the top level, not nested under an
 * `activation` key) — confirmed against Polar's docs, not just the SDK types,
 * so the old `res.body.activation?.id ?? res.body.id` fallback is gone. Both
 * `activate` and `validate`/`deactivate` are unauthenticated by design (Polar's
 * docs: "doesn't require authentication ... safe on a public client"), which is
 * what lets this run straight from the plugin with no secret to protect.
 */

const BASE_URL = 'https://api.polar.sh/v1/customer-portal/license-keys';

/** Loom Loom's Polar.sh organization — every License Keys API call needs it. */
export const POLAR_ORGANIZATION_ID = 'd732a90d-0029-4e4b-910f-56fbf6b1a469';

/** No-code Checkout Link for the license-key product (the "License Keys"
 *  benefit is attached with a 3-device activation limit, matching the product
 *  rules described throughout `src/license/`). This is a purchase URL only —
 *  distinct from, and unrelated to, the License Keys API this file calls. */
export const POLAR_CHECKOUT_URL = 'https://buy.polar.sh/polar_cl_okV0ZoNy6PppAKysH5AavACnliJu3XvKFDA4S2NPmGb';

export class PolarLicenseProvider implements LicenseProvider {
	constructor(private organizationId: string) {}

	async activate(key: string, deviceId: string, label: string): Promise<ActivateResult> {
		const res = await this.post('activate', { key, organization_id: this.organizationId, label });
		if (res.ok) {
			const activationId = res.body.id;
			if (typeof activationId === 'string') return { ok: true, activationId };
			return { ok: false, reason: 'Activated, but the response had no recognizable activation id.' };
		}
		return { ok: false, reason: res.reason };
	}

	async validate(key: string, activationId: string, deviceId: string): Promise<ValidateResult> {
		const res = await this.post('validate', {
			key,
			organization_id: this.organizationId,
			activation_id: activationId,
		});
		return res.ok ? { ok: true } : { ok: false, reason: res.reason };
	}

	async deactivate(key: string, activationId: string, deviceId: string): Promise<DeactivateResult> {
		const res = await this.post('deactivate', {
			key,
			organization_id: this.organizationId,
			activation_id: activationId,
		});
		if (res.ok) return { ok: true };
		// Confirmed against Polar's own SDK source (customerPortalLicenseKeysDeactivate):
		// success is 204 No Content, and a 404 specifically means "no such
		// activation" (their ResourceNotFound error) — never a network problem.
		return { ok: false, reason: res.reason, notFound: res.status === 404 };
	}

	private async post(
		endpoint: 'activate' | 'validate' | 'deactivate',
		body: Record<string, unknown>
	): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string; status: number }> {
		try {
			const response = await requestUrl({
				url: `${BASE_URL}/${endpoint}`,
				method: 'POST',
				contentType: 'application/json',
				body: JSON.stringify(body),
				throw: false,
			});
			// `response.json` parses `response.text` lazily and THROWS on an empty
			// body — which is exactly what a successful 204 No Content response
			// is (confirmed for deactivate; activate/validate return real JSON).
			// Reading it unconditionally inside the outer try meant a genuinely
			// successful empty-body response landed in the catch block below and
			// was misreported as "couldn't reach the server" — parsed separately
			// and defensively here so a body-parsing failure can never masquerade
			// as a network failure.
			let parsed: Record<string, unknown> | null = null;
			try {
				parsed = (response.json ?? {}) as Record<string, unknown>;
			} catch {
				parsed = null;
			}
			if (response.status >= 200 && response.status < 300) {
				return { ok: true, body: parsed ?? {} };
			}
			// TODO: confirm Polar's actual error-body shape once live — guessing
			// at a `detail`/`message` field, falling back to the raw status.
			const errBody = parsed as { detail?: unknown; message?: unknown } | null;
			const reason =
				(typeof errBody?.detail === 'string' && errBody.detail) ||
				(typeof errBody?.message === 'string' && errBody.message) ||
				`Request failed (HTTP ${response.status}).`;
			return { ok: false, reason, status: response.status };
		} catch (e) {
			// requestUrl threw — couldn't reach the server at all (offline/DNS/
			// timeout). Rethrow so LicenseManager treats this as "unreachable",
			// not a definite rejection — see provider.ts.
			throw e instanceof Error ? e : new Error('Could not reach the license server.');
		}
	}
}
