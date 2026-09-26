// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { api as apiType, identityPoolApi as identityPoolApiType } from 'aws-blocks';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isLocal = ENV === 'local';
const ALICE = 'identity-alice';
const BOB = 'identity-bob';
const ALICE_ID = 'eu-west-1:11111111-1111-4111-8111-111111111111';
const BOB_ID = 'eu-west-1:22222222-2222-4222-8222-222222222222';

function getBaseUrl(): string {
	const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8')) as { apiUrl: string };
	return config.apiUrl.replace(/\/aws-blocks\/api$/, '');
}

type RpcResponse = {
	result?: unknown;
	error?: { code: number; data?: { name?: string } };
};

function isIdentity(value: unknown): value is { identityId: string; authenticated: boolean } {
	return typeof value === 'object'
		&& value !== null
		&& 'identityId' in value
		&& typeof value.identityId === 'string'
		&& 'authenticated' in value
		&& typeof value.authenticated === 'boolean';
}

async function rpc(token: string | undefined, method: string, params: unknown[]): Promise<RpcResponse> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const response = await fetch(`${getBaseUrl()}/aws-blocks/api`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', method: `identityPoolApi.${method}`, params, id: 1 }),
	});
	assert.strictEqual(response.status, 200);
	return response.json() as Promise<RpcResponse>;
}

async function result(token: string | undefined, method: string, params: unknown[]): Promise<unknown> {
	const response = await rpc(token, method, params);
	assert.strictEqual(response.error, undefined, `RPC ${method} failed: ${JSON.stringify(response.error)}`);
	return response.result;
}

async function assertRpcError(
	token: string | undefined,
	method: string,
	params: unknown[],
	status: number,
	name: string,
): Promise<void> {
	const response = await rpc(token, method, params);
	assert.strictEqual(response.error?.code, status, `Expected RPC error: ${JSON.stringify(response)}`);
	assert.strictEqual(response.error?.data?.name, name);
}

export function identityPoolTests(
	getIdentityPoolApi: () => typeof identityPoolApiType,
	getApi: () => typeof apiType,
) {
	describe('IdentityPool explicit HTTP identity selection', { skip: !isLocal && 'mock identity tokens only run locally' }, () => {
		test('generated customer clients expose identity and ordinary APIs without casts', () => {
			const identityApi = getIdentityPoolApi();
			void identityApi.marker;
			void identityApi.unassumedMarker;
			void identityApi.unassumedKvPut;
			void identityApi.unassumedKvGet;
			void identityApi.unassumedKvDelete;
			void identityApi.kvPut;
			void identityApi.kvGet;
			void identityApi.kvDelete;
			void identityApi.tablePut;
			void identityApi.tableGet;
			void identityApi.tableDelete;
			void identityApi.filePut;
			void identityApi.fileGet;
			void identityApi.fileDelete;

			const api = getApi();
			void api.kvPut;
			void api.kvGet;
			void api.kvDelete;
			void api.identityMarker;
		});

		test('an unbound API remains usable without an identity pool', async () => {
			const api = getApi();
			const key = `identity-normal-${Date.now().toString(36)}`;
			await api.kvPut(key, 'normal operation');
			assert.strictEqual(await api.kvGet(key), 'normal operation');
			await api.kvDelete(key);
			assert.strictEqual(await api.identityMarker(), null);
		});

		test('a bound method that does not assume an identity uses ordinary resource access', async () => {
			const key = `unassumed/${Date.now().toString(36)}`;
			assert.strictEqual(await result('invalid-identity-token', 'unassumedMarker', []), null);
			await result('invalid-identity-token', 'unassumedKvPut', [key, 'system access']);
			assert.strictEqual(await result(undefined, 'unassumedKvGet', [key]), 'system access');
			await result(undefined, 'unassumedKvDelete', [key]);
			assert.strictEqual(await result(undefined, 'unassumedKvGet', [key]), null);
		});

		test('guest access is denied by default but explicit public access succeeds', async () => {
			const publicKey = `public/welcome-${Date.now().toString(36)}`;
			const privateKey = `notes/${ALICE_ID}/guest-denied`;
			await result(ALICE, 'kvPut', [publicKey, 'hello guest']);

			const guest = await result(undefined, 'marker', []);
			assert.ok(isIdentity(guest));
			assert.match(guest.identityId, /^mock:/);
			assert.strictEqual(guest.authenticated, false);
			assert.strictEqual(await result(undefined, 'kvGet', [publicKey]), 'hello guest');
			await assertRpcError(undefined, 'kvGet', [privateKey], 403, 'IdentityPool.Forbidden');
			await assertRpcError(undefined, 'tableGet', [ALICE_ID, 'guest-denied'], 403, 'IdentityPool.Forbidden');
			await assertRpcError(undefined, 'fileGet', [`private/${ALICE_ID}/guest-denied`], 403, 'IdentityPool.Forbidden');
			await result(ALICE, 'kvDelete', [publicKey]);
		});

		test('explicit assumption rejects invalid credentials and never downgrades to guest access', async () => {
			const publicKey = `public/no-downgrade-${Date.now().toString(36)}`;
			await result(ALICE, 'kvPut', [publicKey, 'guest-only data']);

			await assertRpcError('invalid-identity-token', 'marker', [], 401, 'IdentityPool.Unauthorized');
			await assertRpcError('invalid-identity-token', 'kvGet', [publicKey], 401, 'IdentityPool.Unauthorized');
			await result(ALICE, 'kvDelete', [publicKey]);
		});

		test('an explicitly assumed bearer identity is authenticated', async () => {
			const identity = await result(ALICE, 'marker', []);
			assert.ok(isIdentity(identity));
			assert.strictEqual(identity.identityId, ALICE_ID);
			assert.strictEqual(identity.authenticated, true);
		});

		test('authenticated identities are isolated by KV key, table partition key, and file prefix', async () => {
			const suffix = Date.now().toString(36);
			const aliceKey = `notes/${ALICE_ID}/${suffix}`;
			const bobKey = `notes/${BOB_ID}/${suffix}`;
			const aliceFile = `private/${ALICE_ID}/${suffix}.txt`;
			const bobFile = `private/${BOB_ID}/${suffix}.txt`;

			await Promise.all([
				result(ALICE, 'kvPut', [aliceKey, 'alice note']),
				result(BOB, 'kvPut', [bobKey, 'bob note']),
				result(ALICE, 'tablePut', [ALICE_ID, suffix, 'alice row']),
				result(BOB, 'tablePut', [BOB_ID, suffix, 'bob row']),
				result(ALICE, 'filePut', [aliceFile, 'alice file']),
				result(BOB, 'filePut', [bobFile, 'bob file']),
			]);

			assert.strictEqual(await result(ALICE, 'kvGet', [aliceKey]), 'alice note');
			assert.deepStrictEqual(await result(ALICE, 'tableGet', [ALICE_ID, suffix]), {
				pk: ALICE_ID,
				sk: suffix,
				value: 'alice row',
			});
			assert.strictEqual(await result(ALICE, 'fileGet', [aliceFile]), 'alice file');

			await assertRpcError(BOB, 'kvGet', [aliceKey], 403, 'IdentityPool.Forbidden');
			await assertRpcError(BOB, 'tableGet', [ALICE_ID, suffix], 403, 'IdentityPool.Forbidden');
			await assertRpcError(BOB, 'fileGet', [aliceFile], 403, 'IdentityPool.Forbidden');

			await Promise.all([
				result(ALICE, 'kvDelete', [aliceKey]),
				result(BOB, 'kvDelete', [bobKey]),
				result(ALICE, 'tableDelete', [ALICE_ID, suffix]),
				result(BOB, 'tableDelete', [BOB_ID, suffix]),
				result(ALICE, 'fileDelete', [aliceFile]),
				result(BOB, 'fileDelete', [bobFile]),
			]);
		});
	});
}
