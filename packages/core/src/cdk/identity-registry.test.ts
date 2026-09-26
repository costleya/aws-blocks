// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { getIdentityPoolRole, registerIdentityPoolRole } from './identity-registry.js';

function role(stack: cdk.Stack, id: string): iam.Role {
	return new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
}

describe('identity pool CDK role registry', () => {
	test('returns the role registered for a pool in its stack', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'IdentityStack');
		const identityRole = role(stack, 'IdentityRole');
		registerIdentityPoolRole(stack, 'app/identities', identityRole);
		assert.strictEqual(getIdentityPoolRole(stack, 'app/identities'), identityRole);
	});

	test('rejects lookup before a pool role is registered', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'MissingIdentityStack');
		assert.throws(() => getIdentityPoolRole(stack, 'app/identities'), /No Identity Pool role is registered/);
	});

	test('rejects duplicate registrations for one pool in one stack', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'DuplicateIdentityStack');
		registerIdentityPoolRole(stack, 'app/identities', role(stack, 'FirstRole'));
		assert.throws(
			() => registerIdentityPoolRole(stack, 'app/identities', role(stack, 'SecondRole')),
			/Identity Pool role already registered/,
		);
	});

	test('isolates equal pool ids in separate CDK stacks', () => {
		const app = new cdk.App();
		const first = new cdk.Stack(app, 'FirstIdentityStack');
		const second = new cdk.Stack(app, 'SecondIdentityStack');
		const firstRole = role(first, 'IdentityRole');
		const secondRole = role(second, 'IdentityRole');
		registerIdentityPoolRole(first, 'app/identities', firstRole);
		registerIdentityPoolRole(second, 'app/identities', secondRole);
		assert.strictEqual(getIdentityPoolRole(first, 'app/identities'), firstRole);
		assert.strictEqual(getIdentityPoolRole(second, 'app/identities'), secondRole);
	});
});
