// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mock, test } from 'node:test';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { isBlocksError, Scope } from '@aws-blocks/core';
import { getComputeIdentityProvider } from '@aws-blocks/core/bb-utils';
import { Realtime } from './index.aws.js';

type LambdaEventHandler = (event: unknown) => Promise<{ statusCode: number }>;

test('AWS Realtime disconnect uses a system-owned connections table while retaining the parent identity binding', async () => {
	const scope = new Scope('identity-realtime-aws', {
		compute: { identityProviderFullId: 'identity-realtime-aws/pool' },
	});
	const realtime = new Realtime(scope, 'rt', {
		namespaces: {
			events: Realtime.namespace({
				'~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
			}),
		},
	});
	const notes = new DistributedTable(scope, 'notes', {
		schema: {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: (value: unknown) => ({ value: value as { owner: string; value: string } }),
			},
		},
		key: { partitionKey: 'owner' },
		identityAccess: [{ access: 'authenticated', operations: ['put'], keyPatterns: [`\${identityId}#*`] }],
	});
	assert.strictEqual(getComputeIdentityProvider(realtime), 'identity-realtime-aws/pool');
	assert.strictEqual(
		realtime.systemIdentity,
		false,
		'the temporary system marker must be restored on the Realtime scope',
	);

	let queriedSystemTable = false;
	const queryMock = mock.method(
		DistributedTable.prototype as unknown as { query: (...args: unknown[]) => AsyncIterable<unknown> },
		'query',
		function (this: { systemIdentity?: boolean }) {
			queriedSystemTable = this.systemIdentity === true;
			return (async function* () {})();
		},
	);
	try {
		const handlers = (globalThis as { __BLOCKS_LAMBDA_EVENT_HANDLERS__?: Map<string, LambdaEventHandler> })
			.__BLOCKS_LAMBDA_EVENT_HANDLERS__;
		const handler = handlers?.get(`blocks.websocket:${realtime.fullId}`);
		assert.ok(handler, 'Realtime must register its WebSocket lifecycle handler');
		assert.deepStrictEqual(
			await handler({
				requestContext: {
					eventType: 'DISCONNECT',
					connectionId: 'connection-1',
					domainName: 'example',
					stage: 'dev',
				},
			}),
			{ statusCode: 200 },
		);
		assert.strictEqual(queriedSystemTable, true, 'connection metadata must use the private system-owned table');
	} finally {
		queryMock.mock.restore();
	}

	await assert.rejects(
		() => notes.put({ owner: 'alice#note', value: 'private' }),
		(error: unknown) => isBlocksError(error, 'IdentityPool.Unauthorized'),
		'Realtime system metadata must not exempt a sibling user data table from request identity',
	);
});
