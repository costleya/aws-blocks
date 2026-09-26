// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { BlocksContext } from '../api.js';
import { ApiError } from '../errors.js';
import {
	assumeRequestIdentity,
	assertResourceIdentityAccess,
	clearRequestIdentity,
	getResourceIdentity,
	type IdentityProvider,
	markSystemIdentityScope,
	type RequestIdentity,
	registerIdentityProvider,
	registerResourceIdentityAccess,
	requireIdentity,
	runWithIdentity,
	runWithRequestIdentity,
	runWithRequestScope,
	withRequestAwsClient,
} from './identity-context.js';

const mockAlice: RequestIdentity = { identityId: 'mock:alice', mode: 'mock', authenticated: true };
const mockBob: RequestIdentity = { identityId: 'mock:bob', mode: 'mock', authenticated: true };
const identityKeyPattern = '${' + 'identityId}#*';
const malformedIdentityKeyPattern = '${' + 'wrong}';

function awsIdentity(expiration: Date): RequestIdentity {
	return {
		identityId: 'ap-northeast-1:12345678-1234-1234-1234-123456789abc',
		mode: 'aws',
		authenticated: true,
		credentials: {
			accessKeyId: 'access-key',
			secretAccessKey: 'secret-key',
			sessionToken: 'session-token',
			expiration,
		},
	};
}

function context(authorization?: string): BlocksContext {
	const headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return {
		request: {
			headers,
			body: null,
			json: async () => undefined,
			text: async () => '',
			url: new URL('https://example.test'),
			params: {},
		},
		response: { headers: new Headers(), status: 200, send: () => {} },
	};
}

function syntheticProvider(fullId: string): IdentityProvider {
	return {
		fullId,
		async run(request, callback) {
			const header = request.request.headers.get('authorization');
			if (header === null)
				return runWithIdentity(
					fullId,
					{ identityId: `${fullId}:guest`, mode: 'mock', authenticated: false },
					callback,
				);
			if (header !== 'Bearer valid')
				throw new ApiError('invalid bearer', 401, { name: 'IdentityPool.Unauthorized' });
			return runWithIdentity(
				fullId,
				{ identityId: `${fullId}:user`, mode: 'mock', authenticated: true },
				callback,
			);
		},
	};
}

describe('identity request context', () => {
	test('uses the fallback client until an identity is explicitly assumed', async () => {
		const request = context('Bearer valid');
		const resource = { fullId: 'test/explicit-fallback' };
		const fallback = { kind: 'lambda', destroy() {} };
		let created = 0;
		await runWithRequestScope(request, async () => {
			assert.strictEqual(request.identity, undefined);
			assert.strictEqual(getResourceIdentity(resource), undefined);
			const before = await withRequestAwsClient(
				resource,
				fallback,
				() => {
					created++;
					return { kind: 'identity', destroy() {} };
				},
				async (client) => client.kind,
			);
			assert.strictEqual(before, 'lambda');
			assert.strictEqual(created, 0);
			const attempt = clearRequestIdentity('test/explicit-pool', request);
			assumeRequestIdentity('test/explicit-pool', request, mockAlice, attempt);
			assert.deepStrictEqual(request.identity, { identityId: 'mock:alice', authenticated: true });
			assert.strictEqual(getResourceIdentity(resource)?.identityId, 'mock:alice');
		});
		assert.strictEqual(request.identity, undefined);
	});

	test('isolates explicit selections in concurrent request scopes', async () => {
		const resource = { fullId: 'test/concurrent-explicit' };
		let releaseAlice: (() => void) | undefined;
		const aliceReady = new Promise<void>((resolve) => {
			releaseAlice = resolve;
		});
		let releaseBob: (() => void) | undefined;
		const bobReady = new Promise<void>((resolve) => {
			releaseBob = resolve;
		});
		const aliceContext = context('Bearer alice');
		const bobContext = context('Bearer bob');
		await Promise.all([
			runWithRequestScope(aliceContext, async () => {
				const attempt = clearRequestIdentity('test/concurrent-pool', aliceContext);
				assumeRequestIdentity('test/concurrent-pool', aliceContext, mockAlice, attempt);
				await bobReady;
				assert.strictEqual(getResourceIdentity(resource)?.identityId, 'mock:alice');
				releaseAlice?.();
			}),
			runWithRequestScope(bobContext, async () => {
				const attempt = clearRequestIdentity('test/concurrent-pool', bobContext);
				assumeRequestIdentity('test/concurrent-pool', bobContext, mockBob, attempt);
				releaseBob?.();
				await aliceReady;
				assert.strictEqual(getResourceIdentity(resource)?.identityId, 'mock:bob');
			}),
		]);
		assert.strictEqual(aliceContext.identity, undefined);
		assert.strictEqual(bobContext.identity, undefined);
	});

	test('a failed new assumption revokes the previous identity and blocks later resource access', async () => {
		const request = context('Bearer invalid');
		const resource = { fullId: 'test/failed-explicit' };
		await runWithRequestScope(request, async () => {
			const firstAttempt = clearRequestIdentity('test/failed-pool', request);
			assumeRequestIdentity('test/failed-pool', request, mockAlice, firstAttempt);
			assert.strictEqual(getResourceIdentity(resource)?.identityId, mockAlice.identityId);
			const nextAttempt = clearRequestIdentity('test/failed-pool', request);
			assert.strictEqual(request.identity, undefined);
			assert.throws(
				() => getResourceIdentity(resource),
				(error: unknown) =>
					error instanceof ApiError && error.status === 401 && error.name === 'IdentityPool.Unauthorized',
			);
			assumeRequestIdentity('test/failed-pool', request, mockBob, nextAttempt);
			assert.strictEqual(getResourceIdentity(resource)?.identityId, mockBob.identityId);
		});
	});

	test('an older overlapping assumption cannot revive identity after a newer attempt fails', async () => {
		const request = context('Bearer invalid');
		const resource = { fullId: 'test/stale-attempt-resource' };
		await runWithRequestScope(request, async () => {
			const olderAttempt = clearRequestIdentity('test/overlap-pool', request);
			clearRequestIdentity('test/overlap-pool', request);
			assert.throws(
				() => assumeRequestIdentity('test/overlap-pool', request, mockAlice, olderAttempt),
				(error: unknown) => error instanceof ApiError && error.name === 'IdentityPool.Unauthorized',
			);
			assert.strictEqual(request.identity, undefined);
			assert.throws(
				() => getResourceIdentity(resource),
				(error: unknown) => error instanceof ApiError && error.name === 'IdentityPool.Unauthorized',
			);
		});
	});

	test('invalidates detached resource work when the explicit request scope ends', async () => {
		const request = context();
		const resource = { fullId: 'test/detached-explicit' };
		let release: (() => void) | undefined;
		const resume = new Promise<void>((resolve) => {
			release = resolve;
		});
		let detached: Promise<void> | undefined;
		await runWithRequestScope(request, async () => {
			const attempt = clearRequestIdentity('test/detached-pool', request);
			assumeRequestIdentity('test/detached-pool', request, mockAlice, attempt);
			detached = (async () => {
				await resume;
				getResourceIdentity(resource);
			})();
		});
		release?.();
		assert.ok(detached);
		await assert.rejects(
			detached,
			(error: unknown) =>
				error instanceof ApiError && error.status === 401 && error.name === 'IdentityPool.Unauthorized',
		);
	});
	test('rejects missing identity bindings', () => {
		assert.throws(() => requireIdentity('app/pool'), /active identity-scoped request/i);
	});

	test('binds a mock identity only for its configured pool', async () => {
		await runWithIdentity('app/pool', mockAlice, async () => {
			assert.deepStrictEqual(requireIdentity('app/pool'), mockAlice);
			assert.throws(() => requireIdentity('app/other-pool'), /active identity-scoped request/i);
		});
		assert.throws(() => requireIdentity('app/pool'), /active identity-scoped request/i);
	});

	test('rejects AWS identities with absent, expired, or near-expiry credentials', async () => {
		const missingCredentials: RequestIdentity = {
			identityId: 'ap-northeast-1:12345678-1234-1234-1234-123456789abc',
			mode: 'aws',
		};
		for (const identity of [
			missingCredentials,
			awsIdentity(new Date(Date.now() - 1)),
			awsIdentity(new Date(Date.now() + 30_000)),
		]) {
			await runWithIdentity('app/pool', identity, async () => {
				assert.throws(() => requireIdentity('app/pool'), /active identity-scoped request/i);
			});
		}
	});

	test('accepts AWS credentials with more than the expiry safety margin remaining', async () => {
		const identity = awsIdentity(new Date(Date.now() + 31_000));
		await runWithIdentity('app/pool', identity, async () => {
			assert.strictEqual(requireIdentity('app/pool'), identity);
		});
	});

	test('isolates concurrent pool bindings and restores an outer nested binding', async () => {
		let releaseAlice: (() => void) | undefined;
		const aliceReady = new Promise<void>((resolve) => {
			releaseAlice = resolve;
		});
		let releaseBob: (() => void) | undefined;
		const bobReady = new Promise<void>((resolve) => {
			releaseBob = resolve;
		});

		const alice = runWithIdentity('app/pool', mockAlice, async () => {
			await bobReady;
			assert.strictEqual(requireIdentity('app/pool'), mockAlice);
			releaseAlice?.();
		});
		const bob = runWithIdentity('app/pool', mockBob, async () => {
			assert.strictEqual(requireIdentity('app/pool'), mockBob);
			releaseBob?.();
			await aliceReady;
			assert.strictEqual(requireIdentity('app/pool'), mockBob);
		});
		await Promise.all([alice, bob]);

		await runWithIdentity('app/pool', mockAlice, async () => {
			await runWithIdentity('app/pool', mockBob, async () => {
				assert.strictEqual(requireIdentity('app/pool'), mockBob);
			});
			assert.strictEqual(requireIdentity('app/pool'), mockAlice);
		});
	});

	test('invalidates work detached from the completed callback', async () => {
		let release: (() => void) | undefined;
		const waitForRelease = new Promise<void>((resolve) => {
			release = resolve;
		});
		let detached: Promise<RequestIdentity> | undefined;

		await runWithIdentity('app/pool', mockAlice, async () => {
			detached = (async () => {
				await waitForRelease;
				return requireIdentity('app/pool');
			})();
		});
		release?.();
		assert.ok(detached, 'the request callback started detached work');
		await assert.rejects(detached, /active identity-scoped request/i);
	});

	test('does not leak a failed warm request into the next request', async () => {
		await assert.rejects(
			runWithIdentity('app/pool', mockAlice, async () => {
				throw new Error('request failed');
			}),
			/request failed/,
		);
		assert.throws(() => requireIdentity('app/pool'), /active identity-scoped request/i);
		await runWithIdentity('app/pool', mockBob, async () => {
			assert.strictEqual(requireIdentity('app/pool'), mockBob);
		});
	});

	test('dispatches no-login, valid, and invalid requests through a registered provider without credentials on context', async () => {
		const provider = syntheticProvider('test/dispatch-provider');
		registerIdentityProvider(provider);
		const guestContext = context();
		assert.strictEqual('credentials' in guestContext, false, 'request context must never carry credentials');
		assert.strictEqual(guestContext.identity, undefined, 'unbound request contexts start without an identity');
		const guest = await runWithRequestIdentity(provider.fullId, guestContext, async () => {
			assert.deepStrictEqual(guestContext.identity, {
				identityId: 'test/dispatch-provider:guest',
				authenticated: false,
			});
			return requireIdentity(provider.fullId);
		});
		assert.deepStrictEqual(guest, {
			identityId: 'test/dispatch-provider:guest',
			mode: 'mock',
			authenticated: false,
		});
		assert.strictEqual(guestContext.identity, undefined, 'guest identity is removed after the callback');
		const authenticatedContext = context('Bearer valid');
		const authenticated = await runWithRequestIdentity(provider.fullId, authenticatedContext, async () => {
			assert.deepStrictEqual(authenticatedContext.identity, {
				identityId: 'test/dispatch-provider:user',
				authenticated: true,
			});
			return requireIdentity(provider.fullId);
		});
		assert.deepStrictEqual(authenticated, {
			identityId: 'test/dispatch-provider:user',
			mode: 'mock',
			authenticated: true,
		});
		assert.strictEqual(
			authenticatedContext.identity,
			undefined,
			'authenticated identity is removed after the callback',
		);
		let callbackCalled = false;
		await assert.rejects(
			runWithRequestIdentity(provider.fullId, context('Bearer invalid'), async () => {
				callbackCalled = true;
				return undefined;
			}),
			(error: unknown) => error instanceof ApiError && error.status === 401,
		);
		assert.strictEqual(callbackCalled, false, 'invalid authentication must not fall back to guest');
	});

	test('rejects duplicate and unknown request identity providers', () => {
		const provider = syntheticProvider('test/duplicate-provider');
		registerIdentityProvider(provider);
		assert.throws(() => registerIdentityProvider(syntheticProvider(provider.fullId)), /already registered/);
		assert.throws(
			() => runWithRequestIdentity('test/no-provider', context(), async () => undefined),
			/No identity provider/,
		);
	});

	test('enforces resource grants with authenticated and guest rules, including identity key interpolation', async () => {
		const scope = { fullId: 'test/resource-grants', compute: { identityProviderFullId: 'test/resource-pool' } };
		registerResourceIdentityAccess(scope, [
			{
				access: 'authenticated',
				operations: ['read', 'write'] as const,
				keyPatterns: [identityKeyPattern, 'shared/*'],
			},
			{ access: 'guest', operations: ['read'] as const, keyPatterns: ['public/*'] },
		]);
		await runWithIdentity(
			'test/resource-pool',
			{ identityId: 'alice', mode: 'mock', authenticated: true },
			async () => {
				assert.strictEqual(assertResourceIdentityAccess(scope, 'read', 'alice#note')?.identityId, 'alice');
				assert.strictEqual(assertResourceIdentityAccess(scope, 'write', 'shared/note')?.identityId, 'alice');
				assert.throws(() => assertResourceIdentityAccess(scope, 'read', 'bob#note'), /not allowed/);
			},
		);
		await runWithIdentity(
			'test/resource-pool',
			{ identityId: 'guest', mode: 'mock', authenticated: false },
			async () => {
				assert.strictEqual(assertResourceIdentityAccess(scope, 'read', 'public/welcome')?.authenticated, false);
				assert.throws(() => assertResourceIdentityAccess(scope, 'write', 'public/welcome'), /not allowed/);
			},
		);
	});

	test('fails malformed grants while preserving ordinary and system resource behavior', async () => {
		assert.throws(
			() =>
				registerResourceIdentityAccess({ fullId: 'test/bad-grant' }, [
					{ access: 'guest', operations: ['read'], keyPatterns: [malformedIdentityKeyPattern] },
				]),
			/Unsupported identity key pattern token/,
		);
		assert.throws(
			() =>
				registerResourceIdentityAccess({ fullId: 'test/question-mark-grant' }, [
					{ access: 'guest', operations: ['read'], keyPatterns: ['private/?'] },
				]),
			/Use \* only/,
		);
		assert.throws(
			() =>
				registerResourceIdentityAccess({ fullId: 'test/leftover-token-grant' }, [
					{ access: 'guest', operations: ['read'], keyPatterns: [identityKeyPattern + '${'] },
				]),
			/Unsupported identity key pattern token/,
		);
		const unbound = { fullId: 'test/unbound-resource' };
		assert.strictEqual(assertResourceIdentityAccess(unbound, 'read'), undefined);
		const bound = { fullId: 'test/bound-resource', compute: { identityProviderFullId: 'test/missing-active' } };
		assert.strictEqual(getResourceIdentity(bound), undefined);
		markSystemIdentityScope(bound);
		assert.strictEqual(getResourceIdentity(bound), undefined);
		const provider = syntheticProvider('test/system-marker-provider');
		registerIdentityProvider(provider);
		const requestIdentity = await runWithRequestIdentity(provider.fullId, context('Bearer valid'), async () =>
			requireIdentity(provider.fullId),
		);
		assert.strictEqual(
			requestIdentity.identityId,
			'test/system-marker-provider:user',
			'system resource marker must not bypass request auth',
		);
	});
});
