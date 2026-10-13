import { requestUrl } from 'obsidian';
import { t } from '../i18n';
import { ActivateResult, DeactivateResult, LicenseProvider, ValidateResult } from './provider';

/**
 * Polar.sh license-key backend — the active provider. The wire format is
 * cross-checked against Polar's published API docs but still wants one real
 * smoke test (activate/validate/deactivate against a live key; there is no
 * Polar sandbox for this product, so that runs against production with a
 * 100%-off discount code).
 *
 * Uses Obsidian's `requestUrl`, never `fetch` — required on mobile (no CORS
 * layer) and checked by Obsidian's plugin review.
 *
 * **API versioning**: every request pins `Polar-Version: 2026-04`. Polar keeps
 * three versions live (Current, Deprecated, Next) and rotates quarterly
 * (Jan/Apr/Jul/Oct); without the header a request gets whatever is Current
 * at that moment. 2026-04 stays on a stable contract until it's removed at
 * the 2027-01 release — `POLAR_API_VERSION` must move to a newer, tested
 * version before then.
 *
 * **Wire format**: the REST body is snake_case (`organization_id`,
 * `activation_id`); the JS SDK's camelCase is its own translation. `POST
 * .../activate` takes only `key`/`organization_id`/`label` (`label` is the
 * device identifier Polar stores; there's no device-id field) and responds
 * with the activation object itself (`id` at the top level). activate,
 * validate and deactivate need no authentication ("safe on a public client"),
 * so there's no secret in the plugin.
 */

const BASE_URL = 'https://api.polar.sh/v1/customer-portal/license-keys';

/** Pinned API version (see the file-level doc comment above for the rotation
 *  schedule) — bump only after testing against the newer version's contract. */
const POLAR_API_VERSION = '2026-04';

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
			return { ok: false, reason: t('settings.license.noActivationId') };
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
				headers: { 'Polar-Version': POLAR_API_VERSION },
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
				t('settings.license.requestFailed', { status: response.status });
			return { ok: false, reason, status: response.status };
		} catch (e) {
			// requestUrl threw — couldn't reach the server at all (offline/DNS/
			// timeout). Rethrow so LicenseManager treats this as "unreachable",
			// not a definite rejection — see provider.ts.
			throw e instanceof Error ? e : new Error(t('settings.license.unreachable'));
		}
	}
}
