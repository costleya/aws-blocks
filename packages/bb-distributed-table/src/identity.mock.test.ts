// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { runWithIdentity, type IdentityResourceGrant } from '@aws-blocks/core/bb-utils';
import { DistributedTable, type DistributedTableOperation } from './index.mock.js';
import { z } from 'zod';

const POOL = 'app/identities';
const ALICE = 'eu-west-1:11111111-1111-4111-8111-111111111111';
const BOB = 'eu-west-1:22222222-2222-4222-8222-222222222222';

const schema = z.object({ id: z.string(), createdAt: z.number(), ownerId: z.string(), value: z.string() });

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));

function identityScope() {
	return new Scope('app', { compute: { identityProviderFullId: POOL } });
}

function table(grants: readonly IdentityResourceGrant<DistributedTableOperation>[]) {
	return new DistributedTable(identityScope(), 'notes', {
		schema,
		key: { partitionKey: 'id', sortKey: 'createdAt' },
		indexes: { byOwner: { partitionKey: 'ownerId', sortKey: 'createdAt' } },
		identityAccess: grants,
	});
}

function authenticated(identityId: string) {
	return { identityId, mode: 'mock' as const, authenticated: true };
}

function guest(identityId: string) {
	return { identityId, mode: 'mock' as const, authenticated: false };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iter) items.push(item);
	return items;
}

function assertIdentityError(status: number, name: string) {
	return (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.name, name);
		assert.equal((error as { status?: number }).status, status);
		return true;
	};
}

const forbidden = assertIdentityError(403, 'IdentityPool.Forbidden');

test('identity-bound DistributedTable uses ordinary access until assumption, then denies without a grant', async () => {
	const denied = table([]);
	assert.equal(await denied.get({ id: `${ALICE}#one`, createdAt: 1 }), null);
	await assert.rejects(
		() => runWithIdentity(POOL, authenticated(ALICE), () => denied.get({ id: `${ALICE}#one`, createdAt: 1 })),
		forbidden,
	);

	const ordinary = new DistributedTable(new Scope('ordinary'), 'notes', {
		schema,
		key: { partitionKey: 'id', sortKey: 'createdAt' },
	});
	await ordinary.put({ id: 'system#one', createdAt: 1, ownerId: 'system', value: 'works' });
	assert.equal((await ordinary.get({ id: 'system#one', createdAt: 1 }))?.value, 'works');
});

test('identity-bound DistributedTable enforces authenticated and guest grants across keyed, batch, query, and scan operations', async () => {
	const notes = table([
		{
			access: 'authenticated',
			operations: ['get', 'put', 'delete', 'getBatch', 'putBatch', 'deleteBatch', 'query'],
			keyPatterns: ['${identityId}#*'],
		},
		{ access: 'authenticated', operations: ['scan'] },
		{ access: 'guest', operations: ['get', 'put'], keyPatterns: ['${identityId}#*'] },
	]);

	await Promise.all([
		runWithIdentity(POOL, authenticated(ALICE), () => notes.put({ id: `${ALICE}#one`, createdAt: 1, ownerId: `${ALICE}#owner`, value: 'alice' })),
		runWithIdentity(POOL, authenticated(BOB), () => notes.put({ id: `${BOB}#one`, createdAt: 1, ownerId: `${BOB}#owner`, value: 'bob' })),
	]);

	await runWithIdentity(POOL, authenticated(ALICE), async () => {
		assert.equal((await notes.get({ id: `${ALICE}#one`, createdAt: 1 }))?.value, 'alice');
		await assert.rejects(() => notes.get({ id: `${BOB}#one`, createdAt: 1 }), forbidden);
		await assert.rejects(
			() => notes.put({ id: `${BOB}#two`, createdAt: 2, ownerId: `${BOB}#owner`, value: 'denied' }),
			forbidden,
		);
		await assert.rejects(() => notes.delete({ id: `${BOB}#one`, createdAt: 1 }), forbidden);
		await assert.rejects(() => notes.getBatch([{ id: `${ALICE}#one`, createdAt: 1 }, { id: `${BOB}#one`, createdAt: 1 }]), forbidden);
		await assert.rejects(
			() => notes.putBatch([{ id: `${ALICE}#two`, createdAt: 2, ownerId: `${ALICE}#owner`, value: 'ok' }, { id: `${BOB}#two`, createdAt: 2, ownerId: `${BOB}#owner`, value: 'denied' }]),
			forbidden,
		);
		await assert.rejects(() => notes.deleteBatch([{ id: `${ALICE}#one`, createdAt: 1 }, { id: `${BOB}#one`, createdAt: 1 }]), forbidden);
		await assert.rejects(
			() => collect(notes.query({ where: { id: { equals: `${BOB}#one` } } })),
			forbidden,
		);
		await assert.rejects(
			() => collect(notes.query({ index: 'byOwner', where: { ownerId: { equals: `${BOB}#owner` } } })),
			forbidden,
		);

		const byPrimaryKey = await collect(notes.query({ where: { id: { equals: `${ALICE}#one` } } }));
		assert.deepEqual(byPrimaryKey.map(item => item.value), ['alice']);
		const byIndex = await collect(notes.query({ index: 'byOwner', where: { ownerId: { equals: `${ALICE}#owner` } } }));
		assert.deepEqual(byIndex.map(item => item.value), ['alice']);
		assert.equal((await collect(notes.scan())).length, 2, 'an explicit broad scan grant is permitted');

		await notes.putBatch([{ id: `${ALICE}#two`, createdAt: 2, ownerId: `${ALICE}#owner`, value: 'second' }]);
		assert.equal((await notes.getBatch([{ id: `${ALICE}#two`, createdAt: 2 }]))[0]?.value, 'second');
		await notes.deleteBatch([{ id: `${ALICE}#two`, createdAt: 2 }]);
		await notes.delete({ id: `${ALICE}#one`, createdAt: 1 });
	});

	await runWithIdentity(POOL, guest(ALICE), async () => {
		await notes.put({ id: `${ALICE}#guest`, createdAt: 3, ownerId: `${ALICE}#owner`, value: 'guest' });
		assert.equal((await notes.get({ id: `${ALICE}#guest`, createdAt: 3 }))?.value, 'guest');
		await assert.rejects(() => notes.get({ id: `${BOB}#one`, createdAt: 1 }), forbidden);
		await assert.rejects(() => notes.delete({ id: `${ALICE}#guest`, createdAt: 3 }), forbidden);
	});
});

test('identity-keyed scans remain unsupported and cannot be widened by a key pattern', async () => {
	const notes = table([{ access: 'authenticated', operations: ['scan'], keyPatterns: ['${identityId}#*'] }]);
	await runWithIdentity(POOL, authenticated(ALICE), async () => {
		await assert.rejects(() => collect(notes.scan()), forbidden);
	});
});
