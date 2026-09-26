// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
	BlocksPresets,
	BlocksStack,
	FileBucket,
	IdentityPool,
	LambdaCompute,
	Scope,
} from '@aws-blocks/blocks/cdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	tmpDir = mkdtempSync(join(__dirname, 'tmp-identity-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

type Resource = { Type?: unknown; Properties?: Record<string, unknown> };
type TemplateJson = ReturnType<Template['toJSON']>;

function resourcesOfType(template: TemplateJson, type: string): Record<string, Resource> {
	return Object.fromEntries(
		Object.entries(template.Resources)
			.filter(([, resource]) => (resource as Resource).Type === type)
			.map(([id, resource]) => [id, resource as Resource]),
	);
}

function roleIdsForAmr(template: TemplateJson, amr: 'authenticated' | 'unauthenticated'): string[] {
	return Object.entries(resourcesOfType(template, 'AWS::IAM::Role'))
		.filter(([, role]) => JSON.stringify(role.Properties).includes(`\"cognito-identity.amazonaws.com:amr\":\"${amr}\"`))
		.map(([id]) => id);
}

function rolePolicies(template: TemplateJson, roleId: string): Resource[] {
	return Object.values(resourcesOfType(template, 'AWS::IAM::Policy')).filter((policy) =>
		JSON.stringify(policy.Properties?.Roles).includes(roleId),
	);
}

function hasAccessToBucket(policies: readonly Resource[], bucketId: string): boolean {
	return policies.some((policy) => JSON.stringify(policy.Properties?.PolicyDocument).includes(`"${bucketId}"`));
}

function uploadBucketId(template: TemplateJson): string {
	const bucketId = Object.entries(resourcesOfType(template, 'AWS::S3::Bucket')).find(([, bucket]) =>
		String(bucket.Properties?.BucketName).endsWith('-uploads'),
	)?.[0];
	assert.ok(bucketId, 'the test stack provisions the uploads bucket');
	return bucketId;
}

async function guestStack(id: string) {
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults: BlocksPresets.production,
	});
	const appScope = new Scope('app', { parent: stack });
	const identities = new IdentityPool(appScope, 'identities', {});
	const compute = new LambdaCompute(appScope, 'guest', { identityPool: identities });
	return { stack, compute };
}

test('guest-only identity compute gives an ungranted FileBucket no S3 data access', async () => {
	const { stack, compute } = await guestStack('guest-identity-no-access');
	new FileBucket(compute, 'uploads');

	const template = Template.fromStack(stack).toJSON();
	const guestRoles = roleIdsForAmr(template, 'unauthenticated');
	assert.deepEqual(roleIdsForAmr(template, 'authenticated'), [], 'guest-only pools must not synthesize an authenticated role');
	assert.equal(guestRoles.length, 1, 'guest-only pools synthesize exactly one Cognito guest role');
	const bucketId = uploadBucketId(template);
	assert.equal(hasAccessToBucket(rolePolicies(template, guestRoles[0]), bucketId), false, 'guest role needs an explicit grant');

	const executionRoleId = Object.keys(resourcesOfType(template, 'AWS::IAM::Role')).find(
		(roleId) => roleId !== guestRoles[0],
	);
	assert.ok(executionRoleId, 'BlocksStack supplies one execution role');
	assert.equal(
		hasAccessToBucket(rolePolicies(template, executionRoleId), bucketId),
		false,
		'an identity-bound compute must not retain S3 data access on its execution role',
	);
});

test('guest-only identity compute grants public FileBucket reads and scans only to its guest role', async () => {
	const { stack, compute } = await guestStack('guest-identity-public-access');
	new FileBucket(compute, 'uploads', {
		identityAccess: [{ access: 'guest', operations: ['get', 'scan'], keyPatterns: ['public/*'] }],
	});

	const template = Template.fromStack(stack).toJSON();
	const bucketId = uploadBucketId(template);
	const guestRoles = roleIdsForAmr(template, 'unauthenticated');
	assert.deepEqual(roleIdsForAmr(template, 'authenticated'), [], 'guest-only pools must not require an authenticated role');
	assert.equal(guestRoles.length, 1);
	const guestPolicy = JSON.stringify(rolePolicies(template, guestRoles[0]));
	assert.ok(guestPolicy.includes('s3:GetObject'));
	assert.ok(guestPolicy.includes('s3:GetObjectVersion'));
	assert.ok(guestPolicy.includes('s3:ListBucket'));
	assert.ok(guestPolicy.includes('public/*'));
	assert.ok(guestPolicy.includes('s3:prefix'));
	assert.equal(guestPolicy.includes('s3:PutObject'), false);

	const executionRoleId = Object.keys(resourcesOfType(template, 'AWS::IAM::Role')).find(
		(roleId) => roleId !== guestRoles[0],
	);
	assert.ok(executionRoleId);
	assert.equal(hasAccessToBucket(rolePolicies(template, executionRoleId), bucketId), false);
});
