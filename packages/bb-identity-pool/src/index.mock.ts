// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { ApiError, Scope } from '@aws-blocks/core';
import {
	assumeRequestIdentity,
	clearRequestIdentity,
	registerIdentityProvider,
	runWithIdentity,
} from '@aws-blocks/core/bb-utils';
import { bearerToken } from './auth-header.js';
import { IdentityPoolErrors } from './errors.js';
import type { IdentityPoolOptions, IdentityPoolUser } from './types.js';
import { BB_NAME, BB_VERSION } from './version.js';

export { IdentityPoolErrors } from './errors.js';
export type { IdentityPoolOptions, IdentityPoolUser } from './types.js';

/**
 * Enter a request-scoped local guest or configured authenticated identity.
 *
 * The mock accepts only the explicit `mockIdentities` mapping for supplied
 * bearer tokens. An absent header gets a fresh guest identity; the mock never
 * decodes an asserted token or lets the client choose an Identity ID.
 */
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
		const identity = this.resolveIdentity(context);
		return runWithIdentity(this.fullId, { ...identity, mode: 'mock' }, () => callback(identity));
	}

	/** Select the configured local identity until this request completes. */
	async assumeForIdentity(context: BlocksContext): Promise<IdentityPoolUser> {
		const attempt = clearRequestIdentity(this.fullId, context);
		const identity = this.resolveIdentity(context);
		assumeRequestIdentity(this.fullId, context, { ...identity, mode: 'mock' }, attempt);
		return identity;
	}

	private resolveIdentity(context: BlocksContext): IdentityPoolUser {
		const token = bearerToken(context.request.headers);
		if (!token) {
			if (context.request.headers.has('authorization')) {
				throw new ApiError('A valid bearer identity token is required.', 401, {
					name: IdentityPoolErrors.Unauthorized,
				});
			}
			const identityId = `mock:${randomUUID()}`;
			return { identityId, authenticated: false };
		}

		const mappings = this.options.provider ? this.options.mockIdentities : undefined;
		const identityId = mappings && Object.hasOwn(mappings, token) ? mappings[token] : undefined;
		if (typeof identityId !== 'string' || identityId.length === 0) {
			throw new ApiError('A valid bearer identity token is required.', 401, {
				name: IdentityPoolErrors.Unauthorized,
			});
		}
		return { identityId, authenticated: true };
	}
}
