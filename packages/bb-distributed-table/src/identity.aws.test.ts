// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { runWithIdentity } from '@aws-blocks/core/bb-utils';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { DistributedTable } from './index.aws.js';

const POOL = 'app/identities';
const ALICE = 'eu-west-1:11111111-1111-4111-8111-111111111111';
const BOB = 'eu-west-1:22222222-2222-4222-8222-222222222222';

type SignedRequest = { headers: Record<string, string | undefined> };

function identity(identityId: string, accessKeyId: string, sessionToken: string) {
	return {
		identityId,
		mode: 'aws' as const,
		credentials: {
			accessKeyId,
			secretAccessKey: `${accessKeyId}-secret`,
			sessionToken,
			expiration: new Date(Date.now() + 60_000),
		},
	};
}

function credential(request: SignedRequest): string | undefined {
	return request.headers.authorization?.match(/Credential=([^/]+)/)?.[1];
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iter) items.push(item);
	return items;
}

test('identity-bound DistributedTable signs every DynamoDB operation with the active identity and never the execution role', async () => {
	const previous = {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
		sessionToken: process.env.AWS_SESSION_TOKEN,
	};
	process.env.AWS_ACCESS_KEY_ID = 'EXECUTION_ROLE_ACCESS_KEY';
	process.env.AWS_SECRET_ACCESS_KEY = 'execution-role-secret';
	process.env.AWS_SESSION_TOKEN = 'execution-role-token';

	const signed: SignedRequest[] = [];
	const originalSend = DynamoDBDocumentClient.prototype.send;
	const originalDestroy = DynamoDBDocumentClient.prototype.destroy;
	let destroyed = 0;
	const sendMock = mock.method(
		DynamoDBDocumentClient.prototype,
		'send',
		function (this: DynamoDBDocumentClient, command: never, ...args: never[]) {
			(this.middlewareStack.add as unknown as (middleware: unknown, options: unknown) => void)(
				(_next: unknown) => async (middlewareArgs: { request: SignedRequest }) => {
					signed.push(middlewareArgs.request);
					return { response: {}, output: { $metadata: {} } };
				},
				{ step: 'finalizeRequest', name: 'identity-signing-capture', priority: 'low' },
			);
			return (originalSend as unknown as (command: never, ...args: never[]) => Promise<unknown>).call(this, command, ...args);
		},
	);
	const destroyMock = mock.method(DynamoDBDocumentClient.prototype, 'destroy', function (this: DynamoDBDocumentClient) {
		destroyed += 1;
		return originalDestroy.call(this);
	});

	try {
		const scope = new Scope('app', { compute: { identityProviderFullId: POOL } });
		const notes = new DistributedTable(scope, 'notes', {
			schema: z.object({ id: z.string(), createdAt: z.number(), ownerId: z.string(), value: z.string() }),
			key: { partitionKey: 'id', sortKey: 'createdAt' },
			indexes: { byOwner: { partitionKey: 'ownerId', sortKey: 'createdAt' } },
			identityAccess: [
				{
					access: 'authenticated',
					operations: ['get', 'put', 'delete', 'query', 'scan', 'getBatch', 'putBatch', 'deleteBatch'],
					keyPatterns: ['${identityId}#*'],
				},
				{ access: 'authenticated', operations: ['scan'] },
			],
		});
		const alice = identity(ALICE, 'ALICE_ACCESS_KEY', 'alice-session-token');
		const bob = identity(BOB, 'BOB_ACCESS_KEY', 'bob-session-token');

		await Promise.all([
			runWithIdentity(POOL, alice, () => notes.put({ id: `${ALICE}#concurrent`, createdAt: 1, ownerId: ALICE, value: 'alice' })),
			runWithIdentity(POOL, bob, () => notes.put({ id: `${BOB}#concurrent`, createdAt: 1, ownerId: BOB, value: 'bob' })),
		]);
		await runWithIdentity(POOL, alice, async () => {
			await notes.get({ id: `${ALICE}#one`, createdAt: 1 });
			await notes.put({ id: `${ALICE}#one`, createdAt: 1, ownerId: ALICE, value: 'put' });
			await notes.delete({ id: `${ALICE}#one`, createdAt: 1 });
			await collect(notes.query({ where: { id: { equals: `${ALICE}#one` } } }));
			await collect(notes.query({ index: 'byOwner', where: { ownerId: { equals: `${ALICE}#owner` } } }));
			await collect(notes.scan());
			await notes.getBatch([{ id: `${ALICE}#one`, createdAt: 1 }]);
			await notes.putBatch([{ id: `${ALICE}#one`, createdAt: 1, ownerId: ALICE, value: 'batch' }]);
			await notes.deleteBatch([{ id: `${ALICE}#one`, createdAt: 1 }]);
		});

		assert.equal(signed.length, 11, 'two concurrent writes plus every public DistributedTable operation family');
		assert.deepEqual(signed.map(credential).sort(), [
			'ALICE_ACCESS_KEY', 'ALICE_ACCESS_KEY', 'ALICE_ACCESS_KEY', 'ALICE_ACCESS_KEY', 'ALICE_ACCESS_KEY',
			'ALICE_ACCESS_KEY', 'ALICE_ACCESS_KEY', 'ALICE_ACCESS_KEY', 'ALICE_ACCESS_KEY', 'ALICE_ACCESS_KEY',
			'BOB_ACCESS_KEY',
		]);
		assert.deepEqual(signed.map(request => request.headers['x-amz-security-token']).sort(), [
			'alice-session-token', 'alice-session-token', 'alice-session-token', 'alice-session-token', 'alice-session-token',
			'alice-session-token', 'alice-session-token', 'alice-session-token', 'alice-session-token', 'alice-session-token',
			'bob-session-token',
		]);
		assert.ok(signed.every(request => credential(request) !== 'EXECUTION_ROLE_ACCESS_KEY'));
		assert.equal(destroyed, signed.length, 'every request-scoped client must be destroyed');

		const beforeDenied = signed.length;
		await notes.get({ id: `${ALICE}#unassumed`, createdAt: 1 });
		assert.equal(credential(signed.at(-1)!), 'EXECUTION_ROLE_ACCESS_KEY');
		await assert.rejects(
			() => runWithIdentity(POOL, { ...alice, credentials: { ...alice.credentials, expiration: new Date(Date.now() + 30_000) } }, () => notes.get({ id: `${ALICE}#expired`, createdAt: 1 })),
			{ name: 'IdentityPool.Unauthorized' },
		);
		assert.equal(signed.length, beforeDenied + 1, 'only the unassumed request uses the execution-role client');
	} finally {
		sendMock.mock.restore();
		destroyMock.mock.restore();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
