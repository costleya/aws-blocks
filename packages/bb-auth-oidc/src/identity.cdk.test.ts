// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));

interface SynthReport { tables: Record<string, string>; executionDynamoResources: string[]; identityDynamoResources: string[]; }

function synth(identityBound: boolean): SynthReport {
	const probe = join(here, `.identity-cdk-probe.${process.pid}.${identityBound ? 'bound' : 'unbound'}.mjs`);
	writeFileSync(probe, `
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME, registerIdentityPoolGuestRole, registerIdentityPoolRole } from '@aws-blocks/core/cdk';
import { AuthOIDC, stubIdp } from '@aws-blocks/bb-auth-oidc';
import { KVStore } from '@aws-blocks/bb-kv-store';
const app = new cdk.App(); const stack = new cdk.Stack(app, 'IdentityAuthOidcStack'); globalThis.CURRENT_BLOCKS_STACK = stack;
stack.executionRole = new cdk.aws_iam.Role(stack, 'BlocksRole', { assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com') });
stack.handler = new lambda.Function(stack, 'Handler', { runtime: DEFAULT_NODE_RUNTIME, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => {};'), role: stack.executionRole });
const scope = new Scope('app');
if (${identityBound}) { const guest = new cdk.aws_iam.Role(stack, 'GuestRole', { assumedBy: new cdk.aws_iam.WebIdentityPrincipal('cognito-identity.amazonaws.com') }); const authenticated = new cdk.aws_iam.Role(stack, 'AuthenticatedRole', { assumedBy: new cdk.aws_iam.WebIdentityPrincipal('cognito-identity.amazonaws.com') }); registerIdentityPoolGuestRole(stack, 'app/identities', guest); registerIdentityPoolRole(stack, 'app/identities', authenticated); scope._compute = { identityProviderFullId: 'app/identities', bindIdentityProvider() {} }; }
const auth = new AuthOIDC(scope, 'auth', { providers: [stubIdp({ name: 'stub' })] }); new KVStore(scope, 'notes'); new KVStore(auth, 'application-child');
const resources = Template.fromStack(stack).toJSON().Resources;
const tables = Object.fromEntries(Object.entries(resources).filter(([, resource]) => resource.Type === 'AWS::DynamoDB::Table').map(([id, resource]) => [resource.Properties.TableName, id]));
const roleId = (fragment) => Object.entries(resources).find(([id, resource]) => resource.Type === 'AWS::IAM::Role' && (id.includes(fragment) || JSON.stringify(resource).includes(fragment)))?.[0];
const executionRoleId = roleId('BlocksRole'); const identityRoleIds = [roleId('GuestRole'), roleId('AuthenticatedRole')].filter(Boolean);
const dynamoResourcesFor = (ids) => Object.entries(resources).flatMap(([id, resource]) => resource.Type === 'AWS::IAM::Policy' && ids.some(roleId => JSON.stringify(resource.Properties.Roles).includes(roleId)) ? resource.Properties.PolicyDocument.Statement : resource.Type === 'AWS::IAM::Role' && ids.includes(id) ? (resource.Properties.Policies || []).flatMap(policy => policy.PolicyDocument.Statement) : []).filter(statement => JSON.stringify(statement.Action).includes('dynamodb:')).map(statement => JSON.stringify(statement.Resource));
console.log('__REPORT__' + JSON.stringify({ tables, executionDynamoResources: dynamoResourcesFor([executionRoleId]), identityDynamoResources: dynamoResourcesFor(identityRoleIds) }));
`);
	try {
		const result = spawnSync(process.execPath, ['--conditions=cdk', probe], { encoding: 'utf8' });
		assert.strictEqual(result.status, 0, result.stderr);
		const report = result.stdout.split('__REPORT__')[1];
		assert.ok(report, result.stdout);
		return JSON.parse(report.trim()) as SynthReport;
	} finally { rmSync(probe, { force: true }); }
}

test('CDK: AuthOIDC keeps only its private session table on the execution role under an identity-bound compute', () => {
	const unbound = synth(false);
	const bound = synth(true);
	assert.deepStrictEqual(Object.keys(bound.tables).sort(), ['app-auth-application-child', 'app-auth-sessions', 'app-notes']);
	assert.deepStrictEqual(Object.keys(bound.tables).sort(), Object.keys(unbound.tables).sort());
	assert.ok(bound.executionDynamoResources.some(resource => resource.includes(bound.tables['app-auth-sessions'])));
	for (const tableName of ['app-notes', 'app-auth-application-child']) {
		assert.ok(bound.executionDynamoResources.every(resource => !resource.includes(bound.tables[tableName])));
	}
	assert.strictEqual(bound.identityDynamoResources.length, 0);
});
