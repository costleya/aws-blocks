// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BlocksContext, BlocksRequestIdentity } from '../api.js';
import { ApiError } from '../errors.js';
import {
	type IdentityResourceGrant,
	matchesIdentityKeyPattern,
	validateIdentityKeyPattern,
} from './identity-access.js';

export {
	type IdentityAccess,
	type IdentityResourceGrant,
	interpolateIdentityKeyPatternForIam,
} from './identity-access.js';

/** Temporary AWS credentials issued for an identity-scoped request. */
export interface IdentityCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
	expiration: Date;
}

/**
 * The identity available to Building Blocks during an explicitly scoped request.
 *
 * AWS identities must include unexpired temporary credentials. Mock identities
 * intentionally do not require credentials so local development stays account-free.
 */
export interface RequestIdentity {
	identityId: string;
	mode: 'mock' | 'aws';
	/** Whether the request used an authenticated identity. Omitted identities remain authenticated for compatibility. */
	authenticated?: boolean;
	credentials?: IdentityCredentials;
}

/** A provider that validates a request and runs its callback with an identity. */
export interface IdentityProvider {
	readonly fullId: string;
	run<T>(context: BlocksContext, callback: () => Promise<T>): Promise<T>;
}

/** Structural compute data that can travel through runtime scopes without CDK dependencies. */
export interface IdentityComputeHandle {
	readonly identityProviderFullId?: string;
}

/** The resource shape used to resolve a compute's identity binding. */
export interface IdentityResourceScope {
	readonly fullId: string;
	readonly compute?: IdentityComputeHandle;
	systemIdentity?: boolean;
}

interface ActiveRequestIdentity {
	identity: RequestIdentity;
	active: boolean;
}

interface RequestScope {
	readonly context: BlocksContext;
	readonly identities: Map<string, ActiveRequestIdentity>;
	selectedPoolFullId?: string;
	active: boolean;
	poisoned: boolean;
	attempt: number;
}

const identityStore = new AsyncLocalStorage<Map<string, ActiveRequestIdentity>>();
const requestStore = new AsyncLocalStorage<RequestScope>();
const identityProviders = new Map<string, IdentityProvider>();
const resourceIdentityAccess = new WeakMap<IdentityResourceScope, readonly IdentityResourceGrant[]>();
const IDENTITY_UNAUTHORIZED = 'IdentityPool.Unauthorized';
const CREDENTIAL_EXPIRY_SKEW_MS = 30_000;

function unauthorized(): never {
	throw new ApiError('An active identity-scoped request is required.', 401, { name: IDENTITY_UNAUTHORIZED });
}

function forbidden(): never {
	throw new ApiError('The active identity is not allowed to perform this resource operation.', 403, {
		name: 'IdentityPool.Forbidden',
	});
}

/** Keep explicit identity selection inside one HTTP request and invalidate it when dispatch finishes. */
export async function runWithRequestScope<T>(context: BlocksContext, callback: () => Promise<T>): Promise<T> {
	const scope: RequestScope = { context, identities: new Map(), active: true, poisoned: false, attempt: 0 };
	const previousIdentity = context.identity;
	return requestStore.run(scope, async () => {
		try {
			return await callback();
		} finally {
			scope.active = false;
			for (const entry of scope.identities.values()) entry.active = false;
			scope.identities.clear();
			if (previousIdentity) context.identity = previousIdentity;
			else delete context.identity;
		}
	});
}

function requireRequestScope(context: BlocksContext): RequestScope {
	const scope = requestStore.getStore();
	if (!scope?.active || scope.context !== context) unauthorized();
	return scope;
}

/** Revoke any prior selection before a new identity exchange begins, including failed exchanges. */
export function clearRequestIdentity(_poolFullId: string, context: BlocksContext): number {
	const scope = requireRequestScope(context);
	scope.attempt++;
	scope.poisoned = true;
	for (const previous of scope.identities.values()) previous.active = false;
	scope.identities.clear();
	scope.selectedPoolFullId = undefined;
	delete context.identity;
	return scope.attempt;
}

/** Select a validated identity for all subsequent Block operations in this request. */
export function assumeRequestIdentity(
	poolFullId: string,
	context: BlocksContext,
	identity: RequestIdentity,
	attempt: number,
): void {
	const scope = requireRequestScope(context);
	if (scope.attempt !== attempt || !scope.poisoned) unauthorized();
	if (identity.mode === 'aws') validateAwsCredentials(identity);
	for (const previous of scope.identities.values()) previous.active = false;
	scope.identities.clear();
	scope.identities.set(poolFullId, { identity, active: true });
	scope.selectedPoolFullId = poolFullId;
	scope.poisoned = false;
	context.identity = { identityId: identity.identityId, authenticated: identity.authenticated !== false };
}

/** Register the request identity provider selected by a compute. */
export function registerIdentityProvider(provider: IdentityProvider): void {
	const existing = identityProviders.get(provider.fullId);
	if (existing && existing !== provider) {
		throw new Error(`Identity provider "${provider.fullId}" is already registered.`);
	}
	identityProviders.set(provider.fullId, provider);
}

/** Run a request through the provider selected for its compute. */
export function runWithRequestIdentity<T>(
	providerFullId: string,
	context: BlocksContext,
	callback: () => Promise<T>,
): Promise<T> {
	const provider = identityProviders.get(providerFullId);
	if (!provider) {
		throw new Error(`No identity provider is registered for compute binding "${providerFullId}".`);
	}
	const previousIdentity = context.identity;
	return provider.run(context, async () => {
		const identity = requireIdentity(providerFullId);
		const requestIdentity: BlocksRequestIdentity = {
			identityId: identity.identityId,
			authenticated: identity.authenticated !== false,
		};
		context.identity = requestIdentity;
		try {
			return await callback();
		} finally {
			if (previousIdentity) context.identity = previousIdentity;
			else delete context.identity;
		}
	});
}

/**
 * Run a callback with an identity bound to one Identity Pool.
 *
 * The binding is visible only to async work created by `callback`. It is
 * invalidated as soon as the callback settles, so detached work cannot reuse
 * request credentials after the request boundary has closed.
 */
export async function runWithIdentity<T>(
	poolFullId: string,
	identity: RequestIdentity,
	callback: () => Promise<T>,
): Promise<T> {
	const bindings = new Map(identityStore.getStore());
	const activeIdentity: ActiveRequestIdentity = { identity, active: true };
	bindings.set(poolFullId, activeIdentity);

	return identityStore.run(bindings, async () => {
		try {
			return await callback();
		} finally {
			activeIdentity.active = false;
		}
	});
}

function validateAwsCredentials(identity: RequestIdentity): void {
	const credentials = identity.credentials;
	if (
		!credentials?.accessKeyId ||
		!credentials.secretAccessKey ||
		!credentials.sessionToken ||
		!(credentials.expiration instanceof Date) ||
		!Number.isFinite(credentials.expiration.getTime()) ||
		credentials.expiration.getTime() <= Date.now() + CREDENTIAL_EXPIRY_SKEW_MS
	) {
		unauthorized();
	}
}

/**
 * Return the active identity for an Identity Pool.
 *
 * AWS credentials are accepted only while present and valid for more than 30
 * seconds. Call this immediately before creating a request-scoped AWS SDK
 * client so credential expiry cannot silently fall back to system identity.
 */
export function requireIdentity(poolFullId: string): RequestIdentity {
	const request = requestStore.getStore();
	if (request && (!request.active || request.poisoned)) unauthorized();
	const activeIdentity =
		(request?.active ? request.identities.get(poolFullId) : undefined) ?? identityStore.getStore()?.get(poolFullId);
	if (!activeIdentity?.active) unauthorized();

	const { identity } = activeIdentity;
	if (identity.mode === 'aws') validateAwsCredentials(identity);

	return identity.authenticated === undefined ? { ...identity, authenticated: true } : identity;
}

/**
 * Return the explicit request identity for an ordinary Block operation.
 *
 * Without an explicit selection, a legacy compute-bound callback may still
 * provide an identity. Otherwise the Block uses its normal system client.
 */
export function getResourceIdentity(scope: IdentityResourceScope): RequestIdentity | undefined {
	const request = requestStore.getStore();
	if (request && !request.active) unauthorized();
	if (scope.systemIdentity) return undefined;
	if (request?.active && request.poisoned) unauthorized();
	if (request?.active && request.selectedPoolFullId) return requireIdentity(request.selectedPoolFullId);
	const providerFullId = scope.compute?.identityProviderFullId;
	if (!providerFullId) return undefined;
	const legacyIdentity = identityStore.getStore()?.get(providerFullId);
	if (legacyIdentity && !legacyIdentity.active) unauthorized();
	return legacyIdentity ? requireIdentity(providerFullId) : undefined;
}

/** Use fresh identity credentials for one AWS operation, or the existing Lambda-role client. */
export async function withRequestAwsClient<Client extends { destroy(): void }, Result>(
	scope: IdentityResourceScope,
	fallbackClient: Client,
	createIdentityClient: (credentials: IdentityCredentials) => Client,
	operation: (client: Client) => Promise<Result>,
): Promise<Result> {
	const identity = getResourceIdentity(scope);
	if (!identity) return operation(fallbackClient);
	if (identity.mode !== 'aws') unauthorized();
	const credentials = identity.credentials;
	if (!credentials) unauthorized();
	const client = createIdentityClient(credentials);
	try {
		return await operation(client);
	} finally {
		client.destroy();
	}
}

/** Pin a deferred operation to the request and identity that created it. */
export function captureRequestIdentity(scope: IdentityResourceScope): () => void {
	const request = requestStore.getStore();
	const selectedPoolFullId = request?.selectedPoolFullId;
	const selectedEntry = selectedPoolFullId ? request?.identities.get(selectedPoolFullId) : undefined;
	const legacyBindings = identityStore.getStore();
	const providerFullId = scope.compute?.identityProviderFullId;
	const legacyEntry = providerFullId ? legacyBindings?.get(providerFullId) : undefined;
	const systemIdentity = scope.systemIdentity;
	const identity = getResourceIdentity(scope);

	return () => {
		const currentRequest = requestStore.getStore();
		if (
			(request &&
				(currentRequest !== request ||
					!request.active ||
					request.poisoned ||
					request.selectedPoolFullId !== selectedPoolFullId ||
					(selectedPoolFullId && request.identities.get(selectedPoolFullId) !== selectedEntry))) ||
			(!request && currentRequest?.active) ||
			scope.systemIdentity !== systemIdentity ||
			(legacyEntry &&
				(identityStore.getStore() !== legacyBindings ||
					!legacyEntry.active ||
					(providerFullId && legacyBindings?.get(providerFullId) !== legacyEntry)))
		) {
			unauthorized();
		}
		const current = getResourceIdentity(scope);
		if (
			current?.identityId !== identity?.identityId ||
			current?.mode !== identity?.mode ||
			current?.authenticated !== identity?.authenticated ||
			current?.credentials !== identity?.credentials
		) {
			unauthorized();
		}
	};
}

/**
 * Return the identity provider bound to a resource scope without requiring an
 * active request identity.
 *
 * System-marked framework scopes intentionally report no provider so their
 * private resources retain the ordinary system SDK identity.
 */
export function getComputeIdentityProvider(scope: IdentityResourceScope): string | undefined {
	return scope.systemIdentity ? undefined : scope.compute?.identityProviderFullId;
}

/**
 * Mark a private framework scope and its descendants to retain system identity.
 *
 * This is for framework internals that must run before application identity is
 * established, such as auth session storage. It does not bypass request
 * authentication or alter the request dispatcher.
 */
export function markSystemIdentityScope(scope: IdentityResourceScope): void {
	scope.systemIdentity = true;
}

/**
 * Construct a direct private child with system identity without changing its
 * full ID or permanently marking its parent.
 *
 * The callback must construct the child synchronously. The marker is restored
 * before this function returns, including when construction throws.
 */
export function withSystemIdentityScope<T>(scope: IdentityResourceScope, callback: () => T): T {
	const systemIdentity = scope.systemIdentity;
	scope.systemIdentity = true;
	try {
		return callback();
	} finally {
		scope.systemIdentity = systemIdentity;
	}
}

/** Register a resource's explicit identity access declaration for local enforcement. */
export function registerResourceIdentityAccess<Operation extends string>(
	scope: IdentityResourceScope,
	grants: readonly IdentityResourceGrant<Operation>[],
): void {
	for (const grant of grants) {
		if (grant.operations.length === 0 || grant.operations.some((operation) => !operation)) {
			throw new Error('Identity resource grants must declare at least one operation.');
		}
		for (const pattern of grant.keyPatterns ?? []) validateIdentityKeyPattern(pattern);
	}
	if (resourceIdentityAccess.has(scope)) {
		throw new Error(`Identity resource access is already registered for "${scope.fullId}".`);
	}
	resourceIdentityAccess.set(scope, grants);
}

/**
 * Require an active identity to be granted a resource operation and optional key.
 *
 * Returns `undefined` unchanged for an unbound compute so ordinary system-SDK
 * resources retain their existing behavior.
 */
export function assertResourceIdentityAccess<Operation extends string>(
	scope: IdentityResourceScope,
	operation: Operation,
	key?: string,
): RequestIdentity | undefined {
	const identity = getResourceIdentity(scope);
	if (identity?.mode === 'aws') return identity;
	if (scope.systemIdentity) return undefined;
	const providerFullId = scope.compute?.identityProviderFullId;
	if (!providerFullId) {
		if (identity) forbidden();
		return undefined;
	}
	const selectedPoolFullId = requestStore.getStore()?.selectedPoolFullId;
	if (selectedPoolFullId && selectedPoolFullId !== providerFullId) forbidden();
	if (!selectedPoolFullId) {
		let activeLegacyPoolFullId: string | undefined;
		for (const [poolFullId, entry] of identityStore.getStore() ?? []) {
			if (entry.active && entry.identity.mode === 'mock') activeLegacyPoolFullId = poolFullId;
		}
		if (activeLegacyPoolFullId && activeLegacyPoolFullId !== providerFullId) forbidden();
	}
	if (!identity) return undefined;
	const access = identity.authenticated === false ? 'guest' : 'authenticated';
	const grants = resourceIdentityAccess.get(scope) ?? [];
	const allowed = grants.some((grant) => {
		if (grant.access !== access || !grant.operations.includes(operation)) return false;
		if (!grant.keyPatterns) return true;
		return (
			key !== undefined &&
			grant.keyPatterns.some((pattern) => matchesIdentityKeyPattern(pattern, identity.identityId, key))
		);
	});
	if (!allowed) forbidden();
	return identity;
}
