// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { type BlocksContext, Scope } from '@aws-blocks/core';
import {
	assumeRequestIdentity,
	clearRequestIdentity,
	runWithIdentity,
	runWithRequestScope,
} from '@aws-blocks/core/bb-utils';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KVStore } from './index.aws.js';

const POOL = 'app/identity-pool';
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

function authorizationCredential(request: SignedRequest): string | undefined {
	return request.headers.authorization?.match(/Credential=([^/]+)/)?.[1];
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

test('identity-scoped AWS operations sign each fresh request with its active identity credentials', async () => {
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
			(this.middlewareStack.add as any)(
				(_next: any) => async (middlewareArgs: any) => {
					signed.push(middlewareArgs.request as SignedRequest);
					return { response: {}, output: { $metadata: {} } };
				},
				{ step: 'finalizeRequest', name: 'identity-signing-capture', priority: 'low' },
			);
			return (originalSend as any).call(this, command, ...args);
		},
	);
	const destroyMock = mock.method(
		DynamoDBDocumentClient.prototype,
		'destroy',
		function (this: DynamoDBDocumentClient) {
			destroyed += 1;
			return originalDestroy.call(this);
		},
	);

	try {
		const scope = new Scope('app', { compute: { identityProviderFullId: POOL } });
		const store = new KVStore<string>(scope, 'identity-notes', {
			identityAccess: [
				{
					access: 'authenticated',
					operations: ['get'],
					keyPatterns: [`notes/\${identityId}/*`],
				},
			],
		});
		const alice = identity(ALICE, 'ALICE_ACCESS_KEY', 'alice-session-token');
		const bob = identity(BOB, 'BOB_ACCESS_KEY', 'bob-session-token');

		await Promise.all([
			runWithIdentity(POOL, alice, () => store.get(`notes/${ALICE}/concurrent`)),
			runWithIdentity(POOL, bob, () => store.get(`notes/${BOB}/concurrent`)),
		]);
		await runWithIdentity(POOL, alice, () => store.get(`notes/${ALICE}/sequential`));

		assert.strictEqual(signed.length, 3);
		assert.deepStrictEqual(signed.map(authorizationCredential).sort(), [
			'ALICE_ACCESS_KEY',
			'ALICE_ACCESS_KEY',
			'BOB_ACCESS_KEY',
		]);
		assert.deepStrictEqual(signed.map((request) => request.headers['x-amz-security-token']).sort(), [
			'alice-session-token',
			'alice-session-token',
			'bob-session-token',
		]);
		assert.ok(
			signed.every((request) => authorizationCredential(request) !== 'EXECUTION_ROLE_ACCESS_KEY'),
			'identity mode must never fall back to execution-role credentials',
		);
		assert.strictEqual(destroyed, 3, 'each identity-scoped operation must destroy its request client');

		const sentBeforeFailures = signed.length;
		await store.get(`notes/${ALICE}/unassumed`);
		assert.strictEqual(authorizationCredential(signed.at(-1)!), 'EXECUTION_ROLE_ACCESS_KEY');
		await assert.rejects(
			() =>
				runWithIdentity(
					POOL,
					{ ...alice, credentials: { ...alice.credentials, expiration: new Date(Date.now() + 30_000) } },
					() => store.get(`notes/${ALICE}/expired`),
				),
			{ name: 'IdentityPool.Unauthorized' },
		);
		assert.strictEqual(signed.length, sentBeforeFailures + 1, 'expired credentials must not reach DynamoDB');
		assert.strictEqual(destroyed, 3, 'expired credentials must not create retry clients');
	} finally {
		sendMock.mock.restore();
		destroyMock.mock.restore();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test('scan iterator rejects deferred pages outside its originating identity request before sending to DynamoDB', async () => {
	const scope = new Scope('scan-app', { compute: { identityProviderFullId: POOL } });
	const store = new KVStore<string>(scope, 'identity-notes');
	const alice = identity(ALICE, 'ALICE_SCAN_ACCESS_KEY', 'alice-scan-token');
	const bob = identity(BOB, 'BOB_SCAN_ACCESS_KEY', 'bob-scan-token');
	let sends = 0;
	const sendMock = mock.method(DynamoDBDocumentClient.prototype, 'send', async function () {
		sends++;
		return { Items: [{ pk: 'one', value: JSON.stringify('value') }], LastEvaluatedKey: { pk: 'one' } } as any;
	});
	try {
		const firstRequest = requestContext();
		let afterEnd: AsyncIterator<{ key: string; value: string }> | undefined;
		await runWithRequestScope(firstRequest, async () => {
			const attempt = clearRequestIdentity(POOL, firstRequest);
			assumeRequestIdentity(POOL, firstRequest, alice, attempt);
			afterEnd = store.scan()[Symbol.asyncIterator]();
		});
		const deferred = afterEnd;
		assert.ok(deferred);
		await assert.rejects(() => deferred.next(), { name: 'IdentityPool.Unauthorized' });
		assert.strictEqual(sends, 0, 'a deferred first page must not use the Lambda-role client');

		const originatingRequest = requestContext();
		await runWithRequestScope(originatingRequest, async () => {
			const attempt = clearRequestIdentity(POOL, originatingRequest);
			assumeRequestIdentity(POOL, originatingRequest, alice, attempt);
			const iterator = store.scan()[Symbol.asyncIterator]();
			assert.deepStrictEqual(await iterator.next(), { value: { key: 'one', value: 'value' }, done: false });
			assert.strictEqual(sends, 1);
			const secondRequest = requestContext();
			await runWithRequestScope(secondRequest, async () => {
				const secondAttempt = clearRequestIdentity(POOL, secondRequest);
				assumeRequestIdentity(POOL, secondRequest, bob, secondAttempt);
				await assert.rejects(() => iterator.next(), { name: 'IdentityPool.Unauthorized' });
			});
			assert.strictEqual(sends, 1, 'another principal must not fetch the next page');
		});
	} finally {
		sendMock.mock.restore();
	}
});
