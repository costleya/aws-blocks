// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { z } from 'zod';
import {
	BlocksPresets,
	DEFAULT_NODE_RUNTIME,
	registerIdentityPoolGuestRole,
	registerIdentityPoolRole,
	Scope,
	type BlocksDefaults,
} from '@aws-blocks/core/cdk';
import { DistributedTable } from './index.cdk.js';

const POOL = 'app/identities';

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

function setup() {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'IdentityDistributedTableStack');
	const scope = new Scope('app');
	const authenticatedRole = new iam.Role(stack, 'IdentityAuthenticatedRole', {
		assumedBy: new iam.WebIdentityPrincipal('cognito-identity.amazonaws.com'),
	});
	const guestRole = new iam.Role(stack, 'IdentityGuestRole', {
		assumedBy: new iam.WebIdentityPrincipal('cognito-identity.amazonaws.com'),
	});
	registerIdentityPoolRole(stack, POOL, authenticatedRole);
	registerIdentityPoolGuestRole(stack, POOL, guestRole);
	(scope as unknown as { _compute: { identityProviderFullId: string } })._compute = { identityProviderFullId: POOL };
	return { stack, scope };
}

function policiesFor(template: ReturnType<Template['toJSON']>, roleId: string) {
	return Object.values(template.Resources).filter(
		(resource): resource is { Type: string; Properties: { Roles?: unknown; PolicyDocument?: { Statement?: unknown[] } } } =>
			typeof resource === 'object'
			&& resource !== null
			&& (resource as { Type?: unknown }).Type === 'AWS::IAM::Policy'
			&& JSON.stringify((resource as { Properties?: { Roles?: unknown } }).Properties?.Roles).includes(roleId),
	);
}

function resourcesOfType(template: ReturnType<Template['toJSON']>, type: string) {
	return Object.fromEntries(
		Object.entries(template.Resources).filter(
			([, resource]) => (resource as { Type?: unknown }).Type === type,
		),
	);
}

function actions(statement: { Action: string | string[] }): string[] {
	return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function resources(statement: { Resource: unknown | unknown[] }): unknown[] {
	return Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
}

test('CDK: identity-bound DistributedTable grants only the selected identity roles, with exact actions, resource ARNs, and LeadingKeys', () => {
	const { stack, scope } = setup();
	new DistributedTable(scope, 'notes', {
		schema: z.object({ id: z.string(), createdAt: z.number(), ownerId: z.string(), value: z.string() }),
		key: { partitionKey: 'id', sortKey: 'createdAt' },
		indexes: { byOwner: { partitionKey: 'ownerId', sortKey: 'createdAt' } },
		identityAccess: [
			{
				access: 'authenticated',
				operations: ['get', 'put', 'delete', 'query', 'getBatch', 'putBatch', 'deleteBatch'],
				keyPatterns: ['${identityId}#*'],
			},
			{ access: 'authenticated', operations: ['scan'] },
			{ access: 'guest', operations: ['put'], keyPatterns: ['${identityId}#*'] },
		],
	});

	const template = Template.fromStack(stack).toJSON();
	const authPolicies = policiesFor(template, 'IdentityAuthenticatedRole');
	const guestPolicies = policiesFor(template, 'IdentityGuestRole');
	assert.equal(authPolicies.length, 1, 'CDK may aggregate grants into one role policy document');
	assert.equal(guestPolicies.length, 1);

	const authStatements = authPolicies.flatMap(policy => policy.Properties.PolicyDocument?.Statement ?? []) as Array<{
		Action: string[];
		Resource: unknown[];
		Condition?: unknown;
	}>;
	assert.equal(authStatements.length, 2, 'each authenticated grant must stay an independently constrained IAM statement');
	const keyed = authStatements.find(statement => actions(statement).includes('dynamodb:GetItem'));
	assert.ok(keyed);
	assert.deepEqual(actions(keyed), [
		'dynamodb:GetItem',
		'dynamodb:PutItem',
		'dynamodb:DeleteItem',
		'dynamodb:Query',
		'dynamodb:BatchGetItem',
		'dynamodb:BatchWriteItem',
	]);
	assert.equal(resources(keyed).length, 2, 'queries need both the primary table and its index ARN');
	assert.match(JSON.stringify(resources(keyed)[0]), /notes/);
	assert.match(JSON.stringify(resources(keyed)[1]), /\/index\/\*/);
	assert.deepEqual(keyed.Condition, {
		'ForAllValues:StringLike': {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: IAM resolves this policy variable.
			'dynamodb:LeadingKeys': ['${cognito-identity.amazonaws.com:sub}#*'],
		},
		Null: { 'dynamodb:LeadingKeys': 'false' },
	});

	const scan = authStatements.find(statement => actions(statement).includes('dynamodb:Scan'));
	assert.ok(scan);
	assert.deepEqual(actions(scan), ['dynamodb:Scan']);
	assert.equal(resources(scan).length, 1);
	assert.equal(scan.Condition, undefined, 'a broad scan cannot claim a partition-key constraint');

	const guestStatement = (guestPolicies[0].Properties.PolicyDocument?.Statement ?? [])[0] as {
		Action: string | string[];
		Condition: unknown;
	};
	assert.deepEqual(actions(guestStatement), ['dynamodb:PutItem']);
	assert.deepEqual(guestStatement.Condition, keyed.Condition);

	const executionPolicies = policiesFor(template, 'BlocksRole');
	assert.ok(
		executionPolicies.every(policy => !JSON.stringify(policy.Properties.PolicyDocument).includes('dynamodb:')),
		'an identity-bound compute must not leave application table permissions on its execution role',
	);

	const managerPolicies = Object.values(template.Resources).filter(
		(resource) => JSON.stringify(resource).includes('BlocksGsiManager') && JSON.stringify(resource).includes('dynamodb:'),
	);
	assert.ok(managerPolicies.some(policy => JSON.stringify(policy).includes('dynamodb:DescribeTable')));
	assert.ok(managerPolicies.some(policy => JSON.stringify(policy).includes('dynamodb:UpdateTable')));
});

test('CDK: identity-keyed scan grants fail synthesis before a policy can widen access', () => {
	const { scope } = setup();
	assert.throws(
		() => new DistributedTable(scope, 'notes', {
			schema: z.object({ id: z.string(), value: z.string() }),
			key: { partitionKey: 'id' },
			identityAccess: [{ access: 'authenticated', operations: ['scan'], keyPatterns: ['${identityId}#*'] }],
		}),
		/scan identity access cannot declare keyPatterns/i,
	);
});

for (const encryption of [
	{ name: 'generated customer-managed key', value: 'customer-managed' as const },
	{
		name: 'imported customer-managed key',
		value: DistributedTable.fromKmsKey('arn:aws:kms:ap-northeast-1:111122223333:key/identity-table'),
	},
]) {
	test(`CDK: identity-scoped ${encryption.name} grants operation-appropriate KMS permissions without widening LeadingKeys`, () => {
		const { stack, scope } = setup();
		new DistributedTable(scope, 'encrypted-notes', {
			schema: z.object({ id: z.string(), value: z.string() }),
			key: { partitionKey: 'id' },
			encryption: encryption.value,
			identityAccess: [
				{
					access: 'authenticated',
					operations: ['put'],
					keyPatterns: ['${identityId}#*'],
				},
				{
					access: 'guest',
					operations: ['get'],
					keyPatterns: ['${identityId}#*'],
				},
			],
		});

		const template = Template.fromStack(stack).toJSON();
		const authenticated = policiesFor(template, 'IdentityAuthenticatedRole');
		const guest = policiesFor(template, 'IdentityGuestRole');
		const statements = (policies: ReturnType<typeof policiesFor>) =>
			policies.flatMap((policy) => policy.Properties.PolicyDocument?.Statement ?? []) as Array<{
				Action: string | string[];
				Condition?: unknown;
				Resource?: unknown;
			}>;
		const kmsActions = (policies: ReturnType<typeof policiesFor>) =>
			statements(policies)
				.flatMap((statement) => actions(statement))
				.filter((action) => action.startsWith('kms:'))
				.sort();

		assert.deepEqual(kmsActions(authenticated), [
			'kms:Decrypt',
			'kms:DescribeKey',
			'kms:Encrypt',
			'kms:GenerateDataKey*',
			'kms:ReEncrypt*',
		]);
		assert.deepEqual(kmsActions(guest), ['kms:Decrypt', 'kms:DescribeKey']);

		const authenticatedDynamo = statements(authenticated).find((statement) =>
			actions(statement).includes('dynamodb:PutItem'),
		);
		const guestDynamo = statements(guest).find((statement) => actions(statement).includes('dynamodb:GetItem'));
		assert.ok(authenticatedDynamo);
		assert.ok(guestDynamo);
		assert.deepEqual(authenticatedDynamo.Condition, {
			'ForAllValues:StringLike': {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: IAM resolves this policy variable.
				'dynamodb:LeadingKeys': ['${cognito-identity.amazonaws.com:sub}#*'],
			},
			Null: { 'dynamodb:LeadingKeys': 'false' },
		});
		assert.deepEqual(guestDynamo.Condition, authenticatedDynamo.Condition);

		if (encryption.value === 'customer-managed') {
			assert.equal(Object.keys(resourcesOfType(template, 'AWS::KMS::Key')).length, 1);
		} else {
			assert.equal(Object.keys(resourcesOfType(template, 'AWS::KMS::Key')).length, 0);
			assert.ok(
				[...authenticated, ...guest].some((policy) =>
					JSON.stringify(policy.Properties?.PolicyDocument).includes(encryption.value.keyArn),
				),
			);
		}
	});
}
