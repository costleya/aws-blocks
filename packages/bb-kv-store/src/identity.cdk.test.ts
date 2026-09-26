// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	type BlocksDefaults,
	BlocksPresets,
	DEFAULT_NODE_RUNTIME,
	registerIdentityPoolRole,
	Scope,
} from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { KVStore } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;

	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as { CURRENT_BLOCKS_STACK?: StubBlocksStack }).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new iam.Role(this, 'BlocksRole', {
			assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

test('CDK: identity-scoped KV grants only the Identity Pool role constrained DynamoDB access', () => {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'IdentityKvStack');
	const scope = new Scope('app');
	const identityRole = new iam.Role(stack, 'IdentityPoolAuthenticatedRole', {
		assumedBy: new iam.WebIdentityPrincipal('cognito-identity.amazonaws.com'),
	});
	const poolFullId = 'app/identity-pool';
	registerIdentityPoolRole(stack, poolFullId, identityRole);
	(scope as { _compute?: { identityProviderFullId: string } })._compute = { identityProviderFullId: poolFullId };
	new KVStore(scope, 'identity-notes', {
		identityAccess: [
			{
				access: 'authenticated',
				operations: ['get', 'put', 'delete'],
				keyPatterns: [`notes/\${identityId}/*`],
			},
		],
	});

	const template = Template.fromStack(stack).toJSON();
	const policies = Object.values(template.Resources).filter(
		(resource): resource is { Type: string; Properties: Record<string, unknown> } =>
			typeof resource === 'object' &&
			resource !== null &&
			(resource as { Type?: unknown }).Type === 'AWS::IAM::Policy',
	);
	const identityPolicy = policies.find((policy) => {
		const roles = policy.Properties.Roles;
		return JSON.stringify(roles).includes('IdentityPoolAuthenticatedRole');
	});
	assert.ok(identityPolicy, 'expected a policy attached to the Identity Pool authenticated role');
	const document = identityPolicy.Properties.PolicyDocument as {
		Statement: Array<{ Action: string[]; Resource: unknown; Condition: Record<string, unknown> }>;
	};
	assert.strictEqual(document.Statement.length, 1);
	const [statement] = document.Statement;
	assert.deepStrictEqual(statement.Action, ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem']);
	assert.ok(statement.Resource, 'The identity role policy must target the KVStore table.');
	assert.deepStrictEqual(statement.Condition, {
		'ForAllValues:StringLike': {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: IAM resolves this policy variable.
			'dynamodb:LeadingKeys': ['notes/${cognito-identity.amazonaws.com:sub}/*'],
		},
		Null: { 'dynamodb:LeadingKeys': 'false' },
	});

	const executionRolePolicies = policies.filter((policy) =>
		JSON.stringify(policy.Properties.Roles).includes('BlocksRole'),
	);
	assert.ok(
		executionRolePolicies.every(
			(policy) => !JSON.stringify(policy.Properties.PolicyDocument).includes('dynamodb:'),
		),
		'The Lambda execution role must not receive a DynamoDB table policy for an identity-scoped KVStore.',
	);
});

test('CDK: scan grants reject key patterns and permit an explicit unrestricted scan', () => {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'IdentityKvScanStack');
	const scope = new Scope('app');
	const poolFullId = 'app/identity-pool';
	registerIdentityPoolRole(
		stack,
		poolFullId,
		new iam.Role(stack, 'IdentityPoolAuthenticatedRole', {
			assumedBy: new iam.WebIdentityPrincipal('cognito-identity.amazonaws.com'),
		}),
	);
	(scope as { _compute?: { identityProviderFullId: string } })._compute = { identityProviderFullId: poolFullId };
	assert.throws(
		() =>
			new KVStore(scope, 'bounded-scan', {
				identityAccess: [
					{ access: 'authenticated', operations: ['scan'], keyPatterns: [`notes/\${identityId}/*`] },
				],
			}),
		/KVStore scan identity grants cannot declare keyPatterns/,
	);
	new KVStore(scope, 'unrestricted-scan', {
		identityAccess: [{ access: 'authenticated', operations: ['scan'] }],
	});
	const policyDocuments = Object.values(Template.fromStack(stack).toJSON().Resources)
		.filter(
			(resource): resource is { Type: string; Properties: { PolicyDocument?: unknown } } =>
				typeof resource === 'object' &&
				resource !== null &&
				(resource as { Type?: unknown }).Type === 'AWS::IAM::Policy',
		)
		.map((policy) => JSON.stringify(policy.Properties.PolicyDocument));
	assert.ok(policyDocuments.some((document) => document.includes('dynamodb:Scan')));
});
