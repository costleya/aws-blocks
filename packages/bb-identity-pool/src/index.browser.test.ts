// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import type { BlocksContext } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import { IdentityPool } from './index.browser.js';

test('browser IdentityPool rejects server-only identity exchange', () => {
	const identities = new IdentityPool(new Scope('app'), 'identities', {
		provider: {
			name: 'issuer.example.test',
			oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/issuer.example.test',
		},
	});
	assert.throws(() => identities.run({} as BlocksContext, async () => 'unexpected'), /server-side only/i);
});
