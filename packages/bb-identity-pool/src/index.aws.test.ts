// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError, Scope } from '@aws-blocks/core';
import { requireIdentity, sanitizeConfigKey } from '@aws-blocks/core/bb-utils';
import {
	CognitoIdentityClient,
	type GetCredentialsForIdentityCommand,
	GetIdCommand,
} from '@aws-sdk/client-cognito-identity';
import { IdentityPool, IdentityPoolErrors } from './index.aws.js';

const poolId = 'ap-northeast-1:12345678-1234-1234-1234-123456789abc';
const identityId = 'ap-northeast-1:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let scopeNumber = 0;

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

function pool(
	options: ConstructorParameters<typeof IdentityPool>[2] = {
		provider: {
			name: 'issuer.example.test',
			oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/issuer.example.test',
		},
	},
) {
	scopeNumber += 1;
	return new IdentityPool(new Scope(`aws-app-${scopeNumber}`), 'identities', options);
}

async function withPoolConfig<T>(identities: IdentityPool, callback: () => Promise<T>): Promise<T> {
	const key = `BLOCKS_IDENTITY_POOL_${sanitizeConfigKey(identities.fullId)}`;
	const names = [`${key}_ID`, `${key}_REGION`] as const;
	const previous = names.map((name) => [name, process.env[name]] as const);
	process.env[`${key}_ID`] = poolId;
	process.env[`${key}_REGION`] = 'ap-northeast-1';
	try {
		return await callback();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

async function withInterceptedClient<T>(
	send: (command: GetIdCommand | GetCredentialsForIdentityCommand) => Promise<unknown>,
	callback: (destroyCalls: () => number) => Promise<T>,
): Promise<T> {
	const sendDescriptor = Object.getOwnPropertyDescriptor(CognitoIdentityClient.prototype, 'send');
	const destroyDescriptor = Object.getOwnPropertyDescriptor(CognitoIdentityClient.prototype, 'destroy');
	let destroyed = 0;
	Object.defineProperty(CognitoIdentityClient.prototype, 'send', { configurable: true, value: send });
	Object.defineProperty(CognitoIdentityClient.prototype, 'destroy', {
		configurable: true,
		value: () => {
			destroyed += 1;
		},
	});
	try {
		return await callback(() => destroyed);
	} finally {
		if (sendDescriptor) Object.defineProperty(CognitoIdentityClient.prototype, 'send', sendDescriptor);
		else delete (CognitoIdentityClient.prototype as { send?: unknown }).send;
		if (destroyDescriptor) Object.defineProperty(CognitoIdentityClient.prototype, 'destroy', destroyDescriptor);
		else delete (CognitoIdentityClient.prototype as { destroy?: unknown }).destroy;
	}
}

function validResponse(command: GetIdCommand | GetCredentialsForIdentityCommand): unknown {
	if (command instanceof GetIdCommand) return { IdentityId: identityId };
	return {
		IdentityId: identityId,
		Credentials: {
			AccessKeyId: 'access-key',
			SecretKey: 'secret-key',
			SessionToken: 'session-token',
			Expiration: new Date(Date.now() + 31_000),
		},
	};
}

describe('IdentityPool AWS runtime', () => {
	test('uses fixed provider Logins and passes only an authenticated identity into the callback', async () => {
		const identities = pool();
		await withPoolConfig(identities, async () => {
			await withInterceptedClient(
				async (command) => validResponse(command),
				async (destroyCalls) => {
					const result = await identities.run(context('Bearer opaque-token'), async (user) => {
						assert.deepStrictEqual(user, { identityId, authenticated: true });
						assert.ok(!JSON.stringify(user).includes('secret-key'));
						return user.identityId;
					});
					assert.strictEqual(result, identityId);
					assert.strictEqual(destroyCalls(), 1);
				},
			);
		});
	});

	test('uses Cognito guest flow without Logins for an absent authorization header even with a provider configured', async () => {
		const identities = pool();
		const commands: (GetIdCommand | GetCredentialsForIdentityCommand)[] = [];
		await withPoolConfig(identities, async () => {
			await withInterceptedClient(
				async (command) => {
					commands.push(command);
					return validResponse(command);
				},
				async (destroyCalls) => {
					const user = await identities.run(context(), async (guest) => {
						const active = requireIdentity(identities.fullId);
						assert.strictEqual(active.authenticated, false);
						assert.ok(active.credentials, 'guest credentials must be active inside the callback');
						assert.strictEqual(active.credentials.accessKeyId, 'access-key');
						assert.strictEqual(active.credentials.secretAccessKey, 'secret-key');
						assert.strictEqual(active.credentials.sessionToken, 'session-token');
						assert.ok(active.credentials.expiration instanceof Date);
						return guest;
					});
					assert.deepStrictEqual(user, { identityId, authenticated: false });
					assert.strictEqual(destroyCalls(), 1);
				},
			);
		});
		assert.deepStrictEqual(commands[0]?.input, { IdentityPoolId: poolId });
		assert.deepStrictEqual(commands[1]?.input, { IdentityId: identityId });
	});

	test('rejects a supplied bearer token when the pool has no provider before constructing a client', async () => {
		const identities = pool({});
		await withPoolConfig(identities, async () => {
			await withInterceptedClient(
				async () => assert.fail('Cognito client must not send for a rejected bearer token'),
				async (destroyCalls) => {
					await assert.rejects(
						identities.run(context('Bearer asserted-token'), async () => 'unexpected'),
						(error: unknown) => {
							assert.ok(error instanceof ApiError);
							assert.strictEqual(error.name, IdentityPoolErrors.Unauthorized);
							assert.strictEqual(error.status, 401);
							return true;
						},
					);
					assert.strictEqual(destroyCalls(), 0);
				},
			);
		});
	});

	test('sanitizes Cognito failures, skips the callback, and destroys the per-request client', async () => {
		const identities = pool();
		const serviceError = Object.assign(new Error('opaque-token must never reach the client'), {
			name: 'NotAuthorizedException',
			$metadata: { requestId: 'secret-request-id' },
		});
		await withPoolConfig(identities, async () => {
			await withInterceptedClient(
				async () => {
					throw serviceError;
				},
				async (destroyCalls) => {
					let callbackCalled = false;
					await assert.rejects(
						identities.run(context('Bearer opaque-token'), async () => {
							callbackCalled = true;
							return 'unexpected';
						}),
						(error: unknown) => {
							assert.ok(error instanceof Error);
							assert.strictEqual(error.name, IdentityPoolErrors.Unauthorized);
							assert.strictEqual(JSON.stringify(error).includes('secret-request-id'), false);
							assert.strictEqual(error.message.includes('opaque-token'), false);
							assert.strictEqual(error.cause, undefined);
							return true;
						},
					);
					assert.strictEqual(callbackCalled, false);
					assert.strictEqual(destroyCalls(), 1);
				},
			);
		});
	});

	test('sanitizes missing runtime configuration without constructing a Cognito client', async () => {
		const identities = pool();
		const key = `BLOCKS_IDENTITY_POOL_${sanitizeConfigKey(identities.fullId)}`;
		const names = [`${key}_ID`, `${key}_REGION`] as const;
		const previous = names.map((name) => [name, process.env[name]] as const);
		for (const name of names) delete process.env[name];
		try {
			await withInterceptedClient(
				async () => assert.fail('Cognito client must not send without configuration'),
				async (destroyCalls) => {
					await assert.rejects(
						identities.run(context('Bearer opaque-token'), async () => 'unexpected'),
						(error: unknown) => {
							assert.ok(error instanceof ApiError);
							assert.strictEqual(error.name, IdentityPoolErrors.Unavailable);
							assert.strictEqual(error.status, 502);
							assert.strictEqual(error.message.includes('opaque-token'), false);
							assert.strictEqual(error.cause, undefined);
							return true;
						},
					);
					assert.strictEqual(destroyCalls(), 0);
				},
			);
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	test('propagates callback exceptions after a successful exchange', async () => {
		const identities = pool();
		const expected = new Error('callback failed');
		await withPoolConfig(identities, async () => {
			await withInterceptedClient(
				async (command) => validResponse(command),
				async (destroyCalls) => {
					await assert.rejects(
						identities.run(context('Bearer opaque-token'), async () => {
							throw expected;
						}),
						(error: unknown) => error === expected,
					);
					assert.strictEqual(destroyCalls(), 1);
				},
			);
		});
	});
});
