// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import { Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IdentityPool } from './index.cdk.js';
import type { IdentityPoolOptions } from './types.js';

afterEach(() => {
	delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
});

const provider: NonNullable<IdentityPoolOptions['provider']> = {
	name: 'issuer.example.test',
	oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/issuer.example.test',
};

function setup(options: IdentityPoolOptions = { provider }) {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, 'IdentityPoolStack');
	(globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = stack;
	const parent = new Scope('app');
	const identities = new IdentityPool(parent, 'identities', options);
	return { stack, identities };
}

test('CDK provisions guest and authenticated roles with distinct Cognito trust conditions', () => {
	const { stack } = setup();
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::Cognito::IdentityPool', {
		AllowUnauthenticatedIdentities: true,
		AllowClassicFlow: false,
		OpenIdConnectProviderARNs: ['arn:aws:iam::123456789012:oidc-provider/issuer.example.test'],
	});
	template.resourceCountIs('AWS::Cognito::IdentityPoolRoleAttachment', 1);
	template.resourceCountIs('AWS::IAM::Role', 2);
	template.hasResourceProperties('AWS::Cognito::IdentityPoolRoleAttachment', {
		Roles: Match.objectLike({ authenticated: Match.anyValue(), unauthenticated: Match.anyValue() }),
	});
	template.hasResourceProperties('AWS::IAM::Role', {
		AssumeRolePolicyDocument: Match.objectLike({
			Statement: Match.arrayWith([
				Match.objectLike({
					Principal: { Federated: 'cognito-identity.amazonaws.com' },
					Condition: Match.objectLike({
						StringEquals: Match.objectLike({ 'cognito-identity.amazonaws.com:aud': Match.anyValue() }),
						'ForAnyValue:StringLike': Match.objectLike({
							'cognito-identity.amazonaws.com:amr': 'authenticated',
						}),
					}),
				}),
			]),
		}),
	});
	template.hasResourceProperties('AWS::IAM::Role', {
		AssumeRolePolicyDocument: Match.objectLike({
			Statement: Match.arrayWith([
				Match.objectLike({
					Principal: { Federated: 'cognito-identity.amazonaws.com' },
					Condition: Match.objectLike({
						StringEquals: Match.objectLike({ 'cognito-identity.amazonaws.com:aud': Match.anyValue() }),
						'ForAnyValue:StringLike': Match.objectLike({
							'cognito-identity.amazonaws.com:amr': 'unauthenticated',
						}),
					}),
				}),
			]),
		}),
	});
	template.resourceCountIs('AWS::Lambda::Function', 0);
	const policyJson = JSON.stringify(template.findResources('AWS::IAM::Policy'));
	assert.ok(!policyJson.includes('sts:'), 'IdentityPool adds no STS permission grant');
	assert.ok(!policyJson.includes('dynamodb:'), 'IdentityPool adds no data-plane permissions');
});

test('CDK guest-only pool omits the OIDC provider and authenticated role attachment', () => {
	const { stack } = setup({});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::Cognito::IdentityPool', {
		AllowUnauthenticatedIdentities: true,
		AllowClassicFlow: false,
		OpenIdConnectProviderARNs: Match.absent(),
	});
	template.resourceCountIs('AWS::IAM::Role', 1);
	template.hasResourceProperties('AWS::Cognito::IdentityPoolRoleAttachment', {
		Roles: Match.objectLike({ unauthenticated: Match.anyValue(), authenticated: Match.absent() }),
	});
});

test('CDK registers the identity-pool id and region for the runtime and guards run()', () => {
	const { stack, identities } = setup();
	const registry = (stack as unknown as { [key: symbol]: { entries?: Map<string, unknown> } })[
		Symbol.for('BLOCKS_CONFIG_REGISTRY')
	];
	assert.ok(registry?.entries, 'identity pool must register runtime config');
	const key = 'BLOCKS_IDENTITY_POOL_APP_IDENTITIES';
	assert.ok(registry.entries.has(`${key}_ID`));
	assert.ok(registry.entries.has(`${key}_REGION`));
	assert.throws(() => identities.run({} as never, async () => 'unexpected'), /cannot be called during CDK synth/i);
});
