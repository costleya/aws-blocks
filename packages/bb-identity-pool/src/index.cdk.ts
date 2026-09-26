// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { sanitizeConfigKey } from '@aws-blocks/core/bb-utils';
import {
	BuildingBlockScope,
	registerConfig,
	registerIdentityPoolGuestRole,
	registerIdentityPoolRole,
	synthGuard,
} from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { CfnIdentityPool, CfnIdentityPoolRoleAttachment } from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IdentityPoolOptions, IdentityPoolUser } from './types.js';

export { IdentityPoolErrors } from './errors.js';
export type { IdentityPoolOptions, IdentityPoolUser } from './types.js';

/** Provision a Cognito Identity Pool with separate authenticated and guest IAM roles. */
export class IdentityPool extends BuildingBlockScope {
	constructor(scope: ScopeParent, id: string, options: IdentityPoolOptions) {
		super(id, { parent: scope, vpc: {} });
		const identityPool = new CfnIdentityPool(this, 'IdentityPool', {
			allowUnauthenticatedIdentities: true,
			allowClassicFlow: false,
			identityPoolName: this.fullId.substring(0, 128),
			openIdConnectProviderArns: options.provider ? [options.provider.oidcProviderArn] : undefined,
		});
		const guestRole = new iam.Role(this, 'GuestRole', {
			assumedBy: new iam.WebIdentityPrincipal('cognito-identity.amazonaws.com', {
				StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
				'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'unauthenticated' },
			}),
		});
		const authenticatedRole = options.provider
			? new iam.Role(this, 'AuthenticatedRole', {
					assumedBy: new iam.WebIdentityPrincipal('cognito-identity.amazonaws.com', {
						StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
						'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
					}),
				})
			: undefined;
		new CfnIdentityPoolRoleAttachment(this, 'RoleAttachment', {
			identityPoolId: identityPool.ref,
			roles: {
				unauthenticated: guestRole.roleArn,
				...(authenticatedRole ? { authenticated: authenticatedRole.roleArn } : {}),
			},
		});

		registerIdentityPoolGuestRole(this, this.fullId, guestRole);
		if (authenticatedRole) registerIdentityPoolRole(this, this.fullId, authenticatedRole);
		const key = `BLOCKS_IDENTITY_POOL_${sanitizeConfigKey(this.fullId)}`;
		registerConfig(this, `${key}_ID`, identityPool.ref);
		registerConfig(this, `${key}_REGION`, cdk.Stack.of(this).region);
	}

	run<T>(_context: BlocksContext, _callback: (user: IdentityPoolUser) => Promise<T>): Promise<T> {
		return synthGuard('IdentityPool', 'run');
	}

	assumeForIdentity(_context: BlocksContext): Promise<IdentityPoolUser> {
		return synthGuard('IdentityPool', 'assumeForIdentity');
	}
}
