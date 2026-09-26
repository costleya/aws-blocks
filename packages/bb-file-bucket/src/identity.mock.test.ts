// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { runWithIdentity } from '@aws-blocks/core/bb-utils';
import { FileBucket } from './index.mock.js';

const POOL = 'app/identities';
const ALICE = 'eu-west-1:11111111-1111-4111-8111-111111111111';
const BOB = 'eu-west-1:22222222-2222-4222-8222-222222222222';

function identityScope(id: string) {
	return new Scope(id, { compute: { identityProviderFullId: POOL } });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}

function assertError(status: number, name: string) {
	return (error: unknown): boolean => {
		assert.ok(error instanceof Error);
		assert.strictEqual(error.name, name);
		assert.ok('status' in error);
		assert.strictEqual(error.status, status);
		return true;
	};
}

const assertForbidden = assertError(403, 'IdentityPool.Forbidden');

beforeEach(() => {
	for (const fullId of [
		'legacy-uploads',
		'default-deny-uploads',
		'identity-grants-uploads',
		'invalid-list-uploads',
		'unrestricted-list-uploads',
		'exact-url-uploads',
	]) {
		rmSync(join('.bb-data', fullId), { recursive: true, force: true });
	}
});

describe('FileBucket identity access in the local mock', () => {
	test('requires safe slash-delimited prefixes for get existence probes and scoped list grants', () => {
		for (const [index, identityAccess] of [
			[{ access: 'authenticated' as const, operations: ['get'] as const }],
			[{ access: 'authenticated' as const, operations: ['get'] as const, keyPatterns: ['foo'] }],
			[{ access: 'authenticated' as const, operations: ['get'] as const, keyPatterns: ['foo*'] }],
			[{ access: 'authenticated' as const, operations: ['scan'] as const, keyPatterns: ['foo'] }],
			[{ access: 'authenticated' as const, operations: ['listVersions'] as const, keyPatterns: ['foo*'] }],
		].entries()) {
			assert.throws(
				() => new FileBucket(identityScope(`invalid-list-${index}`), 'uploads', { identityAccess }),
				/slash-delimited (?:key )?prefixes ending in \/\*/,
			);
		}
	});

	test('permits an explicit unrestricted scan and listVersions grant', async () => {
		const bucket = new FileBucket(identityScope('unrestricted-list'), 'uploads', {
			identityAccess: [{ access: 'authenticated', operations: ['put', 'scan', 'listVersions'] }],
		});
		await runWithIdentity(POOL, { identityId: ALICE, mode: 'mock' }, async () => {
			await bucket.put('foo/first.txt', 'first');
			await bucket.put('foobar/second.txt', 'second');
			assert.deepStrictEqual((await collect(bucket.scan())).map((file) => file.path).sort(), [
				'foo/first.txt',
				'foobar/second.txt',
			]);
			assert.strictEqual((await bucket.listVersions('foobar/second.txt')).length, 1);
		});
	});

	test('get requires a safe prefix, while getUrl and getFileHandle allow an exact key', async () => {
		const bucket = new FileBucket(identityScope('exact-url'), 'uploads', {
			identityAccess: [
				{ access: 'authenticated', operations: ['get'], keyPatterns: ['foo/*'] },
				{ access: 'authenticated', operations: ['getUrl', 'getFileHandle'], keyPatterns: ['foo'] },
			],
		});
		await runWithIdentity(POOL, { identityId: ALICE, mode: 'mock' }, async () => {
			assert.strictEqual(await bucket.get('foo/missing.txt'), null);
			assert.ok((await bucket.getUrl('foo')).includes('foo'));
			assert.ok((await bucket.getFileHandle('foo')).getUrl().includes('foo'));
			await assert.rejects(() => bucket.get('foobar/missing.txt'), assertForbidden);
			await assert.rejects(() => bucket.getUrl('foobar'), assertForbidden);
			await assert.rejects(() => bucket.getFileHandle('foobar'), assertForbidden);
		});
	});

	test('uses ordinary access until assumption, then denies every ungranted bucket operation', async () => {
		const legacy = new FileBucket(new Scope('legacy'), 'uploads');
		await legacy.put('unrestricted.txt', 'legacy');
		assert.strictEqual((await legacy.get('unrestricted.txt'))?.body.toString(), 'legacy');

		const bucket = new FileBucket(identityScope('default-deny'), 'uploads');
		await bucket.put(`${ALICE}/object.txt`, 'system value');
		assert.strictEqual((await bucket.get(`${ALICE}/object.txt`))?.body.toString(), 'system value');
		await runWithIdentity(POOL, { identityId: ALICE, mode: 'mock' }, async () => {
			await assert.rejects(() => bucket.put(`${ALICE}/object.txt`, 'denied'), assertForbidden);
			await assert.rejects(() => bucket.get(`${ALICE}/object.txt`), assertForbidden);
			await assert.rejects(() => bucket.delete(`${ALICE}/object.txt`), assertForbidden);
			await assert.rejects(() => bucket.deleteBatch([`${ALICE}/object.txt`]), assertForbidden);
			await assert.rejects(() => bucket.getUrl(`${ALICE}/object.txt`), assertForbidden);
			await assert.rejects(() => bucket.putUrl(`${ALICE}/object.txt`), assertForbidden);
			await assert.rejects(() => bucket.getFileHandle(`${ALICE}/object.txt`), assertForbidden);
			await assert.rejects(() => bucket.createUploadHandle(`${ALICE}/object.txt`), assertForbidden);
			await assert.rejects(async () => collect(bucket.scan({ prefix: `${ALICE}/` })), assertForbidden);
			await assert.rejects(() => bucket.listVersions(`${ALICE}/object.txt`), assertForbidden);
			await assert.rejects(() => bucket.restoreVersion(`${ALICE}/object.txt`, 'v1'), assertForbidden);
		});
	});

	test('applies guest public-prefix and authenticated identity-prefix grants to every object operation', async () => {
		const bucket = new FileBucket(identityScope('identity-grants'), 'uploads', {
			identityAccess: [
				{
					access: 'guest',
					operations: ['get', 'getUrl', 'getFileHandle', 'scan'],
					keyPatterns: ['public/*'],
				},
				{
					access: 'authenticated',
					operations: [
						'put',
						'get',
						'delete',
						'deleteBatch',
						'getUrl',
						'putUrl',
						'getFileHandle',
						'createUploadHandle',
						'scan',
						'listVersions',
						'restoreVersion',
					],
					// biome-ignore lint/suspicious/noTemplateCurlyInString: identity access patterns use this documented token.
					keyPatterns: ['${identityId}/*'],
				},
			],
		});

		await runWithIdentity(POOL, { identityId: ALICE, mode: 'mock' }, async () => {
			await bucket.put(`${ALICE}/first.txt`, 'first');
			await bucket.put(`${ALICE}/first.txt`, 'second');
			await bucket.put(`${ALICE}/batch.txt`, 'batch');
			assert.strictEqual((await bucket.get(`${ALICE}/first.txt`))?.body.toString(), 'second');
			assert.strictEqual(new URL(await bucket.getUrl(`${ALICE}/first.txt`)).protocol, 'http:');
			assert.strictEqual(new URL(await bucket.putUrl(`${ALICE}/upload.txt`)).protocol, 'http:');
			assert.strictEqual(new URL((await bucket.getFileHandle(`${ALICE}/first.txt`)).getUrl()).protocol, 'http:');
			assert.strictEqual(
				new URL((await bucket.createUploadHandle(`${ALICE}/upload.txt`)).getUrl()).protocol,
				'http:',
			);
			assert.deepStrictEqual(
				(await collect(bucket.scan({ prefix: `${ALICE}/` }))).map((file) => file.path).sort(),
				[`${ALICE}/batch.txt`, `${ALICE}/first.txt`],
			);
			const versions = await bucket.listVersions(`${ALICE}/first.txt`);
			assert.strictEqual(versions.length, 2);
			const oldest = versions.at(-1);
			assert.ok(oldest);
			await bucket.restoreVersion(`${ALICE}/first.txt`, oldest.versionId);
			assert.strictEqual((await bucket.get(`${ALICE}/first.txt`))?.body.toString(), 'first');
			await bucket.deleteBatch([`${ALICE}/batch.txt`, `${ALICE}/upload.txt`]);
			await bucket.delete(`${ALICE}/first.txt`);

			await assert.rejects(() => bucket.get(`${BOB}/private.txt`), assertForbidden);
			await assert.rejects(
				() => bucket.deleteBatch([`${ALICE}/allowed.txt`, `${BOB}/denied.txt`]),
				assertForbidden,
			);
			await assert.rejects(() => bucket.listVersions(`${BOB}/private.txt`), assertForbidden);
			await assert.rejects(() => bucket.restoreVersion(`${BOB}/private.txt`, 'v1'), assertForbidden);
		});

		await runWithIdentity(POOL, { identityId: 'guest-id', mode: 'mock', authenticated: false }, async () => {
			assert.strictEqual(await bucket.get('public/missing.txt'), null);
			assert.strictEqual(new URL(await bucket.getUrl('public/missing.txt')).protocol, 'http:');
			assert.strictEqual(new URL((await bucket.getFileHandle('public/missing.txt')).getUrl()).protocol, 'http:');
			assert.deepStrictEqual(await collect(bucket.scan({ prefix: 'public/' })), []);
			await assert.rejects(() => bucket.get(`${ALICE}/private.txt`), assertForbidden);
			await assert.rejects(async () => collect(bucket.scan()), assertForbidden);
		});
	});
});
