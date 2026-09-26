// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { runWithIdentity } from '@aws-blocks/core/bb-utils';
import { Realtime } from './index.js';

const poolFullId = 'identity-realtime/pool';

const schema: import('@standard-schema/spec').StandardSchemaV1<{ value: string }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value: unknown) {
			return { value: value as { value: string } };
		},
	},
};

const noteSchema: import('@standard-schema/spec').StandardSchemaV1<{ owner: string; value: string }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value: unknown) {
			return { value: value as { owner: string; value: string } };
		},
	},
};

test('Realtime connection lifecycle is system-owned without bypassing identity-scoped user data', async () => {
	const scope = new Scope('identity-realtime', { compute: { identityProviderFullId: poolFullId } });
	const realtime = new Realtime(scope, 'rt', { namespaces: { events: Realtime.namespace(schema) } });
	const notes = new DistributedTable(scope, 'notes', {
		schema: noteSchema,
		key: { partitionKey: 'owner' },
		identityAccess: [{ access: 'authenticated', operations: ['put'], keyPatterns: [`\${identityId}#*`] }],
	});
	const received: unknown[] = [];
	realtime.subscribe('events', 'room', (value) => received.push(value));

	await realtime.publish('events', 'room', { value: 'no-login' });
	const channel = await runWithIdentity(poolFullId, { identityId: 'alice', mode: 'mock' }, async () =>
		realtime.getChannel('events', 'room'),
	);

	assert.ok(channel);
	assert.deepStrictEqual(received, [{ value: 'no-login' }]);
	await assert.rejects(
		() => notes.put({ owner: 'alice#note', value: 'private' }),
		(error: unknown) => isBlocksError(error, 'IdentityPool.Unauthorized'),
		'Realtime system metadata must not exempt sibling user data resources from request identity',
	);
});
