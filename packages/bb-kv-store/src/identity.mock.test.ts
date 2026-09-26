// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';
import { type BlocksContext, Scope } from '@aws-blocks/core';
import {
	assumeRequestIdentity,
	clearRequestIdentity,
	runWithIdentity,
	runWithRequestScope,
} from '@aws-blocks/core/bb-utils';
import { KVStore } from './index.mock.js';

const POOL = 'app/identity-pool';
const OTHER_POOL = 'app/other-identity-pool';
const ALICE = 'eu-west-1:11111111-1111-4111-8111-111111111111';
const BOB = 'eu-west-1:22222222-2222-4222-8222-222222222222';

beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

function boundScope() {
	return new Scope('app', { compute: { identityProviderFullId: POOL } });
}

function authenticated(identityId: string) {
	return { identityId, mode: 'mock' as const, authenticated: true };
}

function guest(identityId: string) {
	return { identityId, mode: 'mock' as const, authenticated: false };
}

function requestContext(): BlocksContext {
	return {
		request: {
			headers: new Headers(),
			body: null,
			json: async () => undefined,
			text: async () => '',
			url: new URL('https://example.test/aws-blocks/api'),
			params: {},
		},
		response: { headers: new Headers(), status: 200, send: () => {} },
	};
}

function assertError(status: number, name: string) {
	return (error: unknown): boolean => {
		assert.ok(error instanceof Error);
		assert.strictEqual(error.name, name);
		assert.strictEqual(Reflect.get(error, 'status'), status);
		return true;
	};
}

const assertForbidden = assertError(403, 'IdentityPool.Forbidden');

describe('KVStore identity access declarations (mock)', () => {
	test('an unbound compute preserves ordinary KVStore behavior', async () => {
		const store = new KVStore<string>(new Scope('app'), 'ordinary');
		await store.put('any-key', 'value');
		assert.strictEqual(await store.get('any-key'), 'value');
		await store.delete('any-key');
		assert.strictEqual(await store.get('any-key'), null);
	});

	test('an explicitly assumed identity cannot use an unbound store without an identity grant', async () => {
		const store = new KVStore<string>(new Scope('ordinary-app'), 'unbound-store');
		await store.put('ordinary-key', 'system value');
		const request = requestContext();
		await runWithRequestScope(request, async () => {
			const attempt = clearRequestIdentity(POOL, request);
			assumeRequestIdentity(POOL, request, authenticated(ALICE), attempt);
			await assert.rejects(() => store.get('ordinary-key'), assertForbidden);
			await assert.rejects(() => store.put('ordinary-key', 'identity write'), assertForbidden);
		});
		assert.strictEqual(await store.get('ordinary-key'), 'system value');
	});

	test('a compute-bound store uses ordinary access until an identity is assumed, then denies without a grant', async () => {
		const store = new KVStore<string>(boundScope(), 'default-deny');
		await store.put('note', 'system value');
		assert.strictEqual(await store.get('note'), 'system value');
		await assert.rejects(() => runWithIdentity(POOL, guest(ALICE), () => store.get('note')), assertForbidden);
		await assert.rejects(
			() => runWithIdentity(POOL, authenticated(ALICE), () => store.get('note')),
			assertForbidden,
		);
	});

	test("a selected identity from another pool cannot use this pool's matching key grant", async () => {
		const store = new KVStore<string>(boundScope(), 'two-pool-notes', {
			identityAccess: [
				{ access: 'authenticated', operations: ['put', 'get'], keyPatterns: [`notes/\${identityId}/*`] },
			],
		});
		const key = `notes/${ALICE}/one`;
		const otherRequest = requestContext();
		await runWithRequestScope(otherRequest, async () => {
			const attempt = clearRequestIdentity(OTHER_POOL, otherRequest);
			assumeRequestIdentity(OTHER_POOL, otherRequest, authenticated(ALICE), attempt);
			await assert.rejects(() => store.put(key, 'wrong pool'), assertForbidden);
			await assert.rejects(() => store.get(key), assertForbidden);
		});
		const matchingRequest = requestContext();
		await runWithRequestScope(matchingRequest, async () => {
			const attempt = clearRequestIdentity(POOL, matchingRequest);
			assumeRequestIdentity(POOL, matchingRequest, authenticated(ALICE), attempt);
			await store.put(key, 'right pool');
			assert.strictEqual(await store.get(key), 'right pool');
		});
	});

	test('authenticated grant matches identity-id patterns for get, put, delete, conditions, and TTL', async () => {
		const store = new KVStore<string>(boundScope(), 'notes', {
			identityAccess: [
				{
					access: 'authenticated',
					operations: ['get', 'put', 'delete'],
					keyPatterns: [`notes/\${identityId}/*`],
				},
			],
		});
		const aliceKey = `notes/${ALICE}/one`;
		const bobKey = `notes/${BOB}/one`;

		await Promise.all([
			runWithIdentity(POOL, authenticated(ALICE), () =>
				store.put(aliceKey, 'alice', { ifNotExists: true, ttlSeconds: 60 }),
			),
			runWithIdentity(POOL, authenticated(BOB), () => store.put(bobKey, 'bob', { ifNotExists: true })),
		]);
		await runWithIdentity(POOL, authenticated(ALICE), async () => {
			assert.strictEqual(await store.get(aliceKey), 'alice');
			await assert.rejects(() => store.get(bobKey), assertForbidden);
			await assert.rejects(() => store.put(bobKey, 'overwrite'), assertForbidden);
			await assert.rejects(() => store.delete(bobKey), assertForbidden);
			await store.delete(aliceKey, { ifValueEquals: 'alice' });
			assert.strictEqual(await store.get(aliceKey), null);
		});
	});

	test('guest access requires its own explicit grant', async () => {
		const store = new KVStore<string>(boundScope(), 'guest-notes', {
			identityAccess: [{ access: 'guest', operations: ['put', 'get'], keyPatterns: [`guest/\${identityId}`] }],
		});
		const key = `guest/${ALICE}`;
		await runWithIdentity(POOL, guest(ALICE), async () => {
			await store.put(key, 'guest value');
			assert.strictEqual(await store.get(key), 'guest value');
		});
		await assert.rejects(() => runWithIdentity(POOL, authenticated(ALICE), () => store.get(key)), assertForbidden);
	});

	test('scan is denied for bounded grants and succeeds only with an explicit unrestricted scan grant', async () => {
		const bounded = new KVStore<string>(boundScope(), 'bounded-scan', {
			identityAccess: [
				{ access: 'authenticated', operations: ['scan'], keyPatterns: [`notes/\${identityId}/*`] },
			],
		});
		await assert.rejects(
			() =>
				runWithIdentity(POOL, authenticated(ALICE), async () => {
					for await (const _ of bounded.scan()) void _;
				}),
			assertForbidden,
		);

		const unrestricted = new KVStore<string>(boundScope(), 'unrestricted-scan', {
			identityAccess: [
				{ access: 'authenticated', operations: ['put'], keyPatterns: ['*'] },
				{ access: 'authenticated', operations: ['scan'] },
			],
		});
		await runWithIdentity(POOL, authenticated(ALICE), async () => {
			await unrestricted.put('visible', 'yes');
			const entries: Array<{ key: string; value: string }> = [];
			for await (const entry of unrestricted.scan()) entries.push(entry);
			assert.deepStrictEqual(entries, [{ key: 'visible', value: 'yes' }]);
		});
	});

	test('invalid grant patterns reject at construction before data access', () => {
		assert.throws(
			() =>
				new KVStore(boundScope(), 'empty-pattern', {
					identityAccess: [{ access: 'authenticated', operations: ['get'], keyPatterns: [''] }],
				}),
			/Identity key patterns must not be empty/,
		);
		assert.throws(
			() =>
				new KVStore(boundScope(), 'unsupported-pattern', {
					identityAccess: [
						{ access: 'authenticated', operations: ['get'], keyPatterns: [`notes/\${userId}`] },
					],
				}),
			/Unsupported identity key pattern token/,
		);
	});
});
