// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { runWithIdentity } from '@aws-blocks/core/bb-utils';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { FileBucket } from './index.aws.js';

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

function authorizationCredential(request: SignedRequest): string | undefined {
	return request.headers.authorization?.match(/Credential=([^/]+)/)?.[1];
}

test('identity-scoped S3 calls and presigned URLs use active credentials without Lambda fallback', async () => {
	const previous = {
		accessKeyId: process.env.AWS_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
		sessionToken: process.env.AWS_SESSION_TOKEN,
		region: process.env.AWS_REGION,
	};
	process.env.AWS_ACCESS_KEY_ID = 'EXECUTION_ROLE_ACCESS_KEY';
	process.env.AWS_SECRET_ACCESS_KEY = 'execution-role-secret';
	process.env.AWS_SESSION_TOKEN = 'execution-role-token';
	process.env.AWS_REGION = 'us-east-1';

	const signed: SignedRequest[] = [];
	const originalSend = S3Client.prototype.send;
	const originalDestroy = S3Client.prototype.destroy;
	let destroyed = 0;
	const sendMock = mock.method(
		S3Client.prototype,
		'send',
		function (this: S3Client, command: never, ...args: never[]) {
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
	const destroyMock = mock.method(S3Client.prototype, 'destroy', function (this: S3Client) {
		destroyed += 1;
		return originalDestroy.call(this);
	});

	try {
		const scope = new Scope('app', { compute: { identityProviderFullId: POOL } });
		const bucket = new FileBucket(scope, 'uploads', {
			identityAccess: [
				{
					access: 'authenticated',
					operations: ['put', 'getUrl'],
					// biome-ignore lint/suspicious/noTemplateCurlyInString: identity access patterns use this documented token.
					keyPatterns: ['${identityId}/*'],
				},
			],
		});
		const alice = identity(ALICE, 'ALICE_ACCESS_KEY', 'alice-session-token');
		const bob = identity(BOB, 'BOB_ACCESS_KEY', 'bob-session-token');

		const [aliceUrl, bobUrl] = await Promise.all([
			runWithIdentity(POOL, alice, async () => {
				await bucket.put(`${ALICE}/concurrent.txt`, 'alice');
				return bucket.getUrl(`${ALICE}/presigned.txt`);
			}),
			runWithIdentity(POOL, bob, async () => {
				await bucket.put(`${BOB}/concurrent.txt`, 'bob');
				return bucket.getUrl(`${BOB}/presigned.txt`);
			}),
		]);

		assert.deepStrictEqual(signed.map(authorizationCredential).sort(), ['ALICE_ACCESS_KEY', 'BOB_ACCESS_KEY']);
		assert.deepStrictEqual(signed.map((request) => request.headers['x-amz-security-token']).sort(), [
			'alice-session-token',
			'bob-session-token',
		]);
		assert.ok(signed.every((request) => authorizationCredential(request) !== 'EXECUTION_ROLE_ACCESS_KEY'));

		for (const [url, accessKeyId, sessionToken] of [
			[aliceUrl, 'ALICE_ACCESS_KEY', 'alice-session-token'],
			[bobUrl, 'BOB_ACCESS_KEY', 'bob-session-token'],
		] as const) {
			const query = new URL(url).searchParams;
			assert.strictEqual(query.get('X-Amz-Credential')?.split('/')[0], accessKeyId);
			assert.strictEqual(query.get('X-Amz-Security-Token'), sessionToken);
		}
		assert.strictEqual(
			destroyed,
			4,
			'each direct operation and URL signing call must destroy its request-scoped client',
		);

		const sentBeforeFailures = signed.length;
		const destroyedBeforeFailures = destroyed;
		await bucket.put(`${ALICE}/unassumed.txt`, 'system operation');
		assert.strictEqual(authorizationCredential(signed.at(-1)!), 'EXECUTION_ROLE_ACCESS_KEY');
		await assert.rejects(
			() =>
				runWithIdentity(
					POOL,
					{ ...alice, credentials: { ...alice.credentials, expiration: new Date(Date.now() + 30_000) } },
					() => bucket.put(`${ALICE}/expired.txt`, 'expired'),
				),
			{ name: 'IdentityPool.Unauthorized' },
		);
		assert.strictEqual(
			signed.length,
			sentBeforeFailures + 1,
			'only the unassumed request uses the execution-role client',
		);
		assert.strictEqual(
			destroyed,
			destroyedBeforeFailures,
			'rejected requests must not create a request-scoped S3 client',
		);
	} finally {
		sendMock.mock.restore();
		destroyMock.mock.restore();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test('identity-scoped get consumes its S3 body before releasing the request client', async () => {
	const originalDestroy = S3Client.prototype.destroy;
	let destroyed = false;
	const sendMock = mock.method(S3Client.prototype, 'send', async () => ({
		Body: {
			transformToByteArray: async () => {
				assert.strictEqual(
					destroyed,
					false,
					'the S3 client must remain open while the response stream is consumed',
				);
				return new Uint8Array([111, 107]);
			},
		},
		ContentLength: 2,
		$metadata: {},
	}));
	const destroyMock = mock.method(S3Client.prototype, 'destroy', function (this: S3Client) {
		destroyed = true;
		return originalDestroy.call(this);
	});

	try {
		const scope = new Scope('streaming', { compute: { identityProviderFullId: POOL } });
		const bucket = new FileBucket(scope, 'uploads', {
			identityAccess: [
				{
					access: 'authenticated',
					operations: ['get'],
					// biome-ignore lint/suspicious/noTemplateCurlyInString: identity access patterns use this documented token.
					keyPatterns: ['${identityId}/*'],
				},
			],
		});
		const content = await runWithIdentity(POOL, identity(ALICE, 'ALICE_ACCESS_KEY', 'alice-session-token'), () =>
			bucket.get(`${ALICE}/report.txt`),
		);
		assert.strictEqual(content?.body.toString(), 'ok');
		assert.strictEqual(destroyed, true, 'the request-scoped client is released after the body is consumed');
	} finally {
		sendMock.mock.restore();
		destroyMock.mock.restore();
	}
});

test('identity-scoped get uses a scoped existence probe for S3 AccessDenied', async () => {
	const scope = new Scope('not-found', { compute: { identityProviderFullId: POOL } });
	const bucket = new FileBucket(scope, 'uploads', {
		identityAccess: [
			{
				access: 'authenticated',
				operations: ['get'],
				// biome-ignore lint/suspicious/noTemplateCurlyInString: identity access patterns use this documented token.
				keyPatterns: ['${identityId}/*'],
			},
		],
	});
	const alice = identity(ALICE, 'ALICE_ACCESS_KEY', 'alice-session-token');
	let listedKeys: string[] = [];

	const missingMock = mock.method(S3Client.prototype, 'send', async (command: unknown) => {
		if (command instanceof GetObjectCommand) {
			const error = new Error('missing');
			error.name = 'AccessDenied';
			throw error;
		}
		assert.ok(command instanceof ListObjectsV2Command);
		assert.strictEqual(command.input.Prefix, `${ALICE}/missing.txt`);
		assert.strictEqual(command.input.MaxKeys, 1);
		return { Contents: listedKeys.map((Key) => ({ Key })), $metadata: {} };
	});
	try {
		assert.strictEqual(await runWithIdentity(POOL, alice, () => bucket.get(`${ALICE}/missing.txt`)), null);
		listedKeys = [`${ALICE}/missing.txt.backup`];
		assert.strictEqual(
			await runWithIdentity(POOL, alice, () => bucket.get(`${ALICE}/missing.txt`)),
			null,
			'a neighboring key returned by the prefix probe does not prove the requested object exists',
		);
	} finally {
		missingMock.mock.restore();
	}

	const deniedMock = mock.method(S3Client.prototype, 'send', async (command: unknown) => {
		if (command instanceof GetObjectCommand) {
			const error = new Error('denied');
			error.name = 'AccessDenied';
			throw error;
		}
		assert.ok(command instanceof ListObjectsV2Command);
		return { Contents: [{ Key: `${ALICE}/private.txt` }], $metadata: {} };
	});
	try {
		await assert.rejects(() => runWithIdentity(POOL, alice, () => bucket.get(`${ALICE}/private.txt`)), {
			name: 'AccessDenied',
		});
	} finally {
		deniedMock.mock.restore();
	}
});
