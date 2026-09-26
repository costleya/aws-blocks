// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError, Scope } from '@aws-blocks/core';
import { getResourceIdentity, requireIdentity, runWithRequestScope } from '@aws-blocks/core/bb-utils';
import { IdentityPool, IdentityPoolErrors } from './index.mock.js';

function context(authorization?: string): BlocksContext {
	const headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return {
		request: {
			headers,
			body: null,
			json: async () => undefined,
			text: async () => '',
			url: new URL('https://example.test/aws-blocks/api'),
			params: {},
		},
		response: { headers: new Headers(), status: 200, send: () => {} },
	};
}

let scopeNumber = 0;

function nextScope(): Scope {
	scopeNumber += 1;
	return new Scope(`mock-app-${scopeNumber}`);
}

function pool() {
	return new IdentityPool(nextScope(), 'identities', {
		provider: {
			name: 'issuer.example.test',
			oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/issuer.example.test',
		},
		mockIdentities: { aliceToken: 'mock:alice', bobToken: 'mock:bob' },
	});
}

function assertUnauthorized(error: unknown): boolean {
	assert.ok(error instanceof ApiError, `expected ApiError, got ${error}`);
	assert.strictEqual(error.status, 401);
	assert.strictEqual(error.name, IdentityPoolErrors.Unauthorized);
	return true;
}

describe('IdentityPool mock', () => {
	test('assumes a guest or mapped bearer identity only when explicitly called', async () => {
		const identities = pool();
		const resource = { fullId: 'test/explicit-mock-resource' };
		for (const [authorization, expected] of [
			[undefined, { authenticated: false }],
			['Bearer aliceToken', { identityId: 'mock:alice', authenticated: true }],
		] as const) {
			const request = context(authorization);
			await runWithRequestScope(request, async () => {
				assert.strictEqual(request.identity, undefined);
				assert.strictEqual(getResourceIdentity(resource), undefined);
				const selected = await identities.assumeForIdentity(request);
				assert.strictEqual(selected.authenticated, expected.authenticated);
				if ('identityId' in expected) assert.strictEqual(selected.identityId, expected.identityId);
				else assert.match(selected.identityId, /^mock:/);
				assert.deepStrictEqual(request.identity, selected);
				assert.strictEqual(getResourceIdentity(resource)?.identityId, selected.identityId);
			});
			assert.strictEqual(request.identity, undefined);
		}
	});

	test('a caught invalid assumption cannot reuse an earlier principal or fall back to system access', async () => {
		const identities = pool();
		const request = context('Bearer aliceToken');
		const resource = { fullId: 'test/failed-mock-resource' };
		await runWithRequestScope(request, async () => {
			await identities.assumeForIdentity(request);
			assert.strictEqual(getResourceIdentity(resource)?.identityId, 'mock:alice');
			request.request.headers.set('authorization', 'Bearer invalid');
			await assert.rejects(identities.assumeForIdentity(request), assertUnauthorized);
			assert.strictEqual(request.identity, undefined);
			assert.throws(() => getResourceIdentity(resource), assertUnauthorized);
		});
	});
	test('maps only configured bearer tokens to authenticated identities', async () => {
		const identities = pool();
		const [alice, bob] = await Promise.all([
			identities.run(context('Bearer aliceToken'), async (user) => {
				assert.deepStrictEqual(user, { identityId: 'mock:alice', authenticated: true });
				assert.strictEqual(requireIdentity(identities.fullId).identityId, 'mock:alice');
				return user.identityId;
			}),
			identities.run(context('Bearer bobToken'), async (user) => {
				assert.deepStrictEqual(user, { identityId: 'mock:bob', authenticated: true });
				assert.strictEqual(requireIdentity(identities.fullId).identityId, 'mock:bob');
				return user.identityId;
			}),
		]);
		assert.deepStrictEqual([alice, bob], ['mock:alice', 'mock:bob']);
	});

	test('creates a fresh unauthenticated guest identity only when the authorization header is absent', async () => {
		const identities = pool();
		const guests = await Promise.all([
			identities.run(context(), async (user) => {
				assert.match(user.identityId, /^mock:/);
				assert.deepStrictEqual(user, { identityId: user.identityId, authenticated: false });
				return user.identityId;
			}),
			identities.run(context(), async (user) => user.identityId),
		]);
		assert.notStrictEqual(guests[0], guests[1], 'guest identities must not be shared between requests');
	});

	test('rejects supplied malformed, empty, oversized, unknown, or inherited tokens before the callback', async () => {
		const identities = pool();
		for (const authorization of [
			'Basic aliceToken',
			'',
			'Bearer ',
			'Bearer unknown',
			'Bearer constructor',
			'Bearer toString',
			'Bearer __proto__',
			`Bearer ${'x'.repeat(16_385)}`,
		]) {
			let callbackCalled = false;
			await assert.rejects(
				identities.run(context(authorization), async () => {
					callbackCalled = true;
					return 'unexpected';
				}),
				assertUnauthorized,
			);
			assert.strictEqual(callbackCalled, false, `callback ran for ${authorization || 'an empty header'}`);
		}
	});

	test('does not manufacture a mock identity when the mapping is omitted', async () => {
		const identities = new IdentityPool(nextScope(), 'identities', {
			provider: {
				name: 'issuer.example.test',
				oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/issuer.example.test',
			},
		});
		await assert.rejects(
			identities.run(context('Bearer asserted-but-unmapped'), async () => 'unexpected'),
			assertUnauthorized,
		);
	});

	test('does not downgrade a supplied bearer token when no provider is configured', async () => {
		const guestsOnly = new IdentityPool(nextScope(), 'identities', {});
		let callbackCalled = false;
		await assert.rejects(
			guestsOnly.run(context('Bearer asserted-token'), async () => {
				callbackCalled = true;
				return 'unexpected';
			}),
			assertUnauthorized,
		);
		assert.strictEqual(callbackCalled, false);
		const guest = await guestsOnly.run(context(), async (user) => user);
		assert.strictEqual(guest.authenticated, false);
	});

	test('propagates a callback exception without translating it to an authentication error', async () => {
		const expected = new Error('callback failed');
		await assert.rejects(
			pool().run(context('Bearer aliceToken'), async () => {
				throw expected;
			}),
			(error: unknown) => error === expected,
		);
	});
});
