// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { ApiError, getConfig, Scope } from '@aws-blocks/core';
import {
	assumeRequestIdentity,
	clearRequestIdentity,
	registerIdentityProvider,
	runWithIdentity,
	sanitizeConfigKey,
} from '@aws-blocks/core/bb-utils';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { bearerToken } from './auth-header.js';
import { IdentityPoolErrors } from './errors.js';
import { exchangeIdentity } from './identity-exchange.js';
import type { IdentityPoolOptions, IdentityPoolUser } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

export { IdentityPoolErrors } from './errors.js';
export type { IdentityPoolOptions, IdentityPoolUser } from './types.js';

function isUnauthorizedExchangeFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === 'NotAuthorizedException' || error.name === 'InvalidParameterException';
}

/** Exchange guest or bearer credentials through Cognito Identity for an explicit request scope. */
export class IdentityPool extends Scope {
	constructor(
		scope: ScopeParent,
		id: string,
		private readonly options: IdentityPoolOptions,
	) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		registerIdentityProvider(this);
	}

	async run<T>(context: BlocksContext, callback: (user: IdentityPoolUser) => Promise<T>): Promise<T> {
		const identity = await this.exchange(context);
		return runWithIdentity(this.fullId, { ...identity, mode: 'aws' }, () =>
			callback({ identityId: identity.identityId, authenticated: identity.authenticated }),
		);
	}

	/** Validate the request with Cognito and select its credentials until this request completes. */
	async assumeForIdentity(context: BlocksContext): Promise<IdentityPoolUser> {
		const attempt = clearRequestIdentity(this.fullId, context);
		const identity = await this.exchange(context);
		assumeRequestIdentity(this.fullId, context, { ...identity, mode: 'aws' }, attempt);
		return { identityId: identity.identityId, authenticated: identity.authenticated };
	}

	private async exchange(context: BlocksContext): Promise<Awaited<ReturnType<typeof exchangeIdentity>>> {
		const token = bearerToken(context.request.headers);
		if (!token) {
			if (context.request.headers.has('authorization')) {
				throw new ApiError('A valid bearer identity token is required.', 401, {
					name: IdentityPoolErrors.Unauthorized,
				});
			}
		} else if (!this.options.provider) {
			throw new ApiError('A valid bearer identity token is required.', 401, {
				name: IdentityPoolErrors.Unauthorized,
			});
		}

		const configKey = `BLOCKS_IDENTITY_POOL_${sanitizeConfigKey(this.fullId)}`;
		let identity: Awaited<ReturnType<typeof exchangeIdentity>>;
		try {
			const [poolId, region] = await Promise.all([
				getConfig(`${configKey}_ID`),
				getConfig(`${configKey}_REGION`),
			]);
			if (!poolId || !region) throw new Error('Identity Pool configuration is unavailable.');
			const client = new CognitoIdentityClient({ region, customUserAgent: this.buildUserAgentChain() });
			try {
				identity = await exchangeIdentity(client, {
					poolId,
					providerName: token ? this.options.provider?.name : undefined,
					region,
					token: token ?? undefined,
				});
			} finally {
				client.destroy();
			}
		} catch (error: unknown) {
			const name = isUnauthorizedExchangeFailure(error)
				? IdentityPoolErrors.Unauthorized
				: IdentityPoolErrors.Unavailable;
			const status = name === IdentityPoolErrors.Unauthorized ? 401 : 502;
			const message =
				name === IdentityPoolErrors.Unauthorized
					? 'A valid bearer identity token is required.'
					: 'Identity credentials are temporarily unavailable.';
			throw new ApiError(message, status, { name });
		}
		return identity;
	}
}
