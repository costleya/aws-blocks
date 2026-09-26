// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { runWithIdentity } from '@aws-blocks/core/bb-utils';
import { AsyncJob } from './index.mock.js';

const poolFullId = 'identity-async/pool';
const fastPoll = { pollIntervalMs: 5, timeoutMs: 5_000 };

const noteSchema: import('@standard-schema/spec').StandardSchemaV1<{ owner: string; value: string }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value: unknown) {
			return { value: value as { owner: string; value: string } };
		},
	},
};

test('AsyncJob status bookkeeping is system-owned while background handlers remain identity-bound', async () => {
	const scope = new Scope('identity-async', { compute: { identityProviderFullId: poolFullId } });
	const notes = new DistributedTable(scope, 'notes', {
		schema: noteSchema,
		key: { partitionKey: 'owner' },
		identityAccess: [{ access: 'authenticated', operations: ['put'], keyPatterns: [`\${identityId}#*`] }],
	});
	let handlerCalls = 0;
	const job = new AsyncJob(scope, 'jobs', {
		trackStatus: true,
		handler: async () => {
			handlerCalls++;
			await assert.rejects(
				() => notes.put({ owner: 'alice#note', value: 'private' }),
				(error: unknown) => isBlocksError(error, 'IdentityPool.Unauthorized'),
				'background work must not inherit a submitting user identity or bypass the user data table',
			);
		},
	});

	const anonymous = await job.submit({ source: 'no-login' });
	const authenticated = await runWithIdentity(poolFullId, { identityId: 'alice', mode: 'mock' }, async () =>
		job.submit({ source: 'authenticated-request' }),
	);

	const [anonymousStatus, authenticatedStatus] = await Promise.all([
		job.waitUntilComplete(anonymous.jobId, fastPoll),
		job.waitUntilComplete(authenticated.jobId, fastPoll),
	]);
	assert.strictEqual(anonymousStatus.state, 'complete');
	assert.strictEqual(authenticatedStatus.state, 'complete');
	assert.strictEqual(handlerCalls, 2);
});
