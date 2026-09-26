// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { GetCredentialsForIdentityCommand, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import { type CognitoIdentityExchangeClient, exchangeIdentity } from './identity-exchange.js';

const input = {
	poolId: 'ap-northeast-1:12345678-1234-1234-1234-123456789abc',
	providerName: 'issuer.example.test',
	region: 'ap-northeast-1',
	token: 'opaque-token',
};
const initialIdentityId = 'ap-northeast-1:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const canonicalIdentityId = 'ap-northeast-1:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function client(
	responses: readonly unknown[],
	commands: (GetIdCommand | GetCredentialsForIdentityCommand)[],
): CognitoIdentityExchangeClient {
	return {
		async send(command) {
			commands.push(command);
			const response = responses[commands.length - 1];
			if (response instanceof Error) throw response;
			return response;
		},
	};
}

function credentials(expiration = new Date(Date.now() + 31_000)) {
	return {
		AccessKeyId: 'access-key',
		SecretKey: 'secret-key',
		SessionToken: 'session-token',
		Expiration: expiration,
	};
}

describe('Cognito Identity enhanced exchange', () => {
	test('uses the same fixed Logins map for GetId and GetCredentials, then returns Cognito’s canonical identity', async () => {
		const commands: (GetIdCommand | GetCredentialsForIdentityCommand)[] = [];
		const result = await exchangeIdentity(
			client(
				[{ IdentityId: initialIdentityId }, { IdentityId: canonicalIdentityId, Credentials: credentials() }],
				commands,
			),
			input,
		);

		assert.strictEqual(result.identityId, canonicalIdentityId);
		assert.strictEqual(result.authenticated, true);
		assert.strictEqual(result.credentials.accessKeyId, 'access-key');
		assert.strictEqual(commands.length, 2);
		assert.ok(commands[0] instanceof GetIdCommand);
		assert.ok(commands[1] instanceof GetCredentialsForIdentityCommand);
		assert.deepStrictEqual(commands[0].input, {
			IdentityPoolId: input.poolId,
			Logins: { [input.providerName]: input.token },
		});
		assert.deepStrictEqual(commands[1].input, {
			IdentityId: initialIdentityId,
			Logins: { [input.providerName]: input.token },
		});
		assert.deepStrictEqual(Object.keys(commands[0].input).sort(), ['IdentityPoolId', 'Logins']);
		assert.deepStrictEqual(Object.keys(commands[1].input).sort(), ['IdentityId', 'Logins']);
	});

	test('uses Cognito enhanced guest flow without Logins when no bearer provider is configured', async () => {
		const commands: (GetIdCommand | GetCredentialsForIdentityCommand)[] = [];
		const result = await exchangeIdentity(
			client(
				[{ IdentityId: initialIdentityId }, { IdentityId: canonicalIdentityId, Credentials: credentials() }],
				commands,
			),
			{ poolId: input.poolId, region: input.region },
		);
		assert.strictEqual(result.identityId, canonicalIdentityId);
		assert.strictEqual(result.authenticated, false);
		assert.deepStrictEqual(commands[0].input, { IdentityPoolId: input.poolId });
		assert.deepStrictEqual(commands[1].input, { IdentityId: initialIdentityId });
	});

	test('rejects incomplete login configuration without contacting Cognito', async () => {
		for (const incomplete of [
			{ poolId: input.poolId, providerName: input.providerName, region: input.region },
			{ poolId: input.poolId, region: input.region, token: input.token },
		]) {
			const commands: (GetIdCommand | GetCredentialsForIdentityCommand)[] = [];
			await assert.rejects(exchangeIdentity(client([], commands), incomplete), /login configuration is invalid/i);
			assert.strictEqual(commands.length, 0);
		}
	});

	test('rejects invalid initial identity responses before requesting credentials', async () => {
		const commands: (GetIdCommand | GetCredentialsForIdentityCommand)[] = [];
		await assert.rejects(
			exchangeIdentity(
				client([{ IdentityId: 'us-east-1:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }], commands),
				input,
			),
			/invalid identity ID/i,
		);
		assert.strictEqual(commands.length, 1);
	});

	test('rejects credentials that are incomplete or inside the expiry safety margin', async () => {
		for (const issued of [
			{ IdentityId: canonicalIdentityId },
			{ IdentityId: canonicalIdentityId, Credentials: credentials(new Date(Date.now() + 30_000)) },
			{ IdentityId: 'us-east-1:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', Credentials: credentials() },
		]) {
			const commands: (GetIdCommand | GetCredentialsForIdentityCommand)[] = [];
			await assert.rejects(
				exchangeIdentity(client([{ IdentityId: initialIdentityId }, issued], commands), input),
				/incomplete credentials/i,
			);
			assert.strictEqual(commands.length, 2);
		}
	});
});
