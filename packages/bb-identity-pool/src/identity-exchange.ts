// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IdentityCredentials } from '@aws-blocks/core/bb-utils';
import { GetCredentialsForIdentityCommand, GetIdCommand } from '@aws-sdk/client-cognito-identity';

/** A minimal Cognito client contract used by the runtime and isolated SDK tests. @internal */
export interface CognitoIdentityExchangeClient {
	send(command: GetIdCommand | GetCredentialsForIdentityCommand): Promise<unknown>;
}

/** The validated result of an enhanced Cognito Identity exchange. @internal */
export interface ExchangedIdentity {
	identityId: string;
	credentials: IdentityCredentials;
	authenticated: boolean;
}

function isIdentityIdForRegion(identityId: unknown, region: string): identityId is string {
	if (typeof identityId !== 'string') return false;
	const separator = identityId.indexOf(':');
	if (separator <= 0 || identityId.slice(0, separator) !== region) return false;
	return /^[0-9a-fA-F]{8}-[0-9a-fA-F-]{8,}$/.test(identityId.slice(separator + 1));
}

function usableCredentials(credentials: unknown): credentials is {
	AccessKeyId: string;
	SecretKey: string;
	SessionToken: string;
	Expiration: Date;
} {
	if (!credentials || typeof credentials !== 'object') return false;
	const value = credentials as Partial<{
		AccessKeyId: unknown;
		SecretKey: unknown;
		SessionToken: unknown;
		Expiration: unknown;
	}>;
	return (
		typeof value.AccessKeyId === 'string' &&
		value.AccessKeyId.length > 0 &&
		typeof value.SecretKey === 'string' &&
		value.SecretKey.length > 0 &&
		typeof value.SessionToken === 'string' &&
		value.SessionToken.length > 0 &&
		value.Expiration instanceof Date &&
		Number.isFinite(value.Expiration.getTime()) &&
		value.Expiration.getTime() > Date.now() + 30_000
	);
}

/**
 * Exchange a guest or bearer-token request through Cognito's enhanced flow.
 *
 * Authenticated exchanges intentionally supply the same fixed `Logins` map to
 * both calls. Guest exchanges omit it from both. The helper uses the canonical
 * identity returned with credentials because Cognito may merge an initially
 * returned identity during the exchange.
 *
 * @internal
 */
export async function exchangeIdentity(
	client: CognitoIdentityExchangeClient,
	input: { poolId: string; providerName?: string; region: string; token?: string },
): Promise<ExchangedIdentity> {
	if ((input.providerName === undefined) !== (input.token === undefined)) {
		throw new Error('Cognito Identity login configuration is invalid.');
	}
	const authenticated = input.providerName !== undefined;
	const logins =
		input.providerName !== undefined && input.token !== undefined
			? { [input.providerName]: input.token }
			: undefined;
	const initial = await client.send(
		new GetIdCommand({
			IdentityPoolId: input.poolId,
			...(logins ? { Logins: logins } : {}),
		}),
	);
	const initialIdentityId = (initial as { IdentityId?: unknown }).IdentityId;
	if (!isIdentityIdForRegion(initialIdentityId, input.region)) {
		throw new Error('Cognito Identity returned an invalid identity ID.');
	}

	const issued = await client.send(
		new GetCredentialsForIdentityCommand({
			IdentityId: initialIdentityId,
			...(logins ? { Logins: logins } : {}),
		}),
	);
	const result = issued as { IdentityId?: unknown; Credentials?: unknown };
	if (!isIdentityIdForRegion(result.IdentityId, input.region) || !usableCredentials(result.Credentials)) {
		throw new Error('Cognito Identity returned incomplete credentials.');
	}

	return {
		identityId: result.IdentityId,
		authenticated,
		credentials: {
			accessKeyId: result.Credentials.AccessKeyId,
			secretAccessKey: result.Credentials.SecretKey,
			sessionToken: result.Credentials.SessionToken,
			expiration: result.Credentials.Expiration,
		},
	};
}
