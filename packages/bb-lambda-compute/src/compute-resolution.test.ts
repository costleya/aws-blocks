// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal unit tests for `Scope.compute` resolution.
 *
 * `compute` resolves to the nearest `_compute` assigned on the block or an
 * ancestor scope, else the owning stack/backend's default compute — a
 * LambdaCompute that owns the Lambda function + API Gateway backing the stack's
 * handler/gateway. The `_compute` input is internal until the customer-facing
 * surface exists.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksPresets, Scope } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import { LambdaCompute } from './index.cdk.js';

// Inject LambdaCompute as the default-compute factory so `.compute` resolves to
// it — the same thing @aws-blocks/blocks does for real apps, here passed through
// create()'s internal defaultComputeFactory option.
const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

// Compare construct identity as a boolean. A failed object-valued assertion
// tries to format the entire connected CDK graph and can exhaust the heap.
function assertSameConstruct(actual: unknown, expected: unknown, message: string): void {
	assert.ok(actual === expected, message);
}

test('construct identity failures keep only booleans in the assertion payload', () => {
	const actual = { self: {} };
	actual.self = actual;
	const expected = { self: {} };
	expected.self = expected;
	assert.throws(
		() => assertSameConstruct(actual, expected, 'different constructs'),
		(error: unknown) =>
			error instanceof assert.AssertionError && error.actual === false && error.expected === true,
	);
});

// The backend entry (for the NodejsFunction) and a no-op backend module (which
// BlocksStack.create imports) are written to a temp dir under the package
// rather than checked-in fixtures. The handler entry must live under the
// project root — CDK's NodejsFunction rejects an entry outside it.
const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let sideEffectBackendPath: string;
let tmpDir: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-compute-res-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	sideEffectBackendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(sideEffectBackendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

async function makeStack(id: string): Promise<BlocksStack> {
	const app = new cdk.App();
	return BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: sideEffectBackendPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: lambdaFactory,
	});
}

describe('Scope.compute resolution', () => {
	test('default: resolves to the compute that owns the stack handler + gateway (one function)', async () => {
		const stack = await makeStack('ComputeDefault');

		const block = new Scope('block');
		const compute = block.compute;

		assert.ok(compute instanceof LambdaCompute, 'default resolves to a LambdaCompute');
		// The stack's handler/gateway delegate to the default compute's.
		assertSameConstruct(stack.handler, (compute as LambdaCompute).fn, 'stack.handler is the compute function');
		assertSameConstruct(stack.gateway, (compute as LambdaCompute).apiGateway, 'stack.gateway is the compute gateway');

		// Exactly one function + gateway — the default compute's.
		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
	});

	test('default compute is cached (same instance across reads and blocks)', async () => {
		const stack = await makeStack('ComputeCached');

		const a = new Scope('a').compute;
		const b = new Scope('b').compute;

		assertSameConstruct(a, b, 'all blocks share the one default compute');
		assertSameConstruct(stack._defaultCompute, a, 'cached on the owner');
	});

	test('explicit _compute on the block takes precedence', async () => {
		await makeStack('ComputeExplicit');

		const explicit = new LambdaCompute(new Scope('c'), 'explicit');
		const block = new Scope('block');
		block._compute = explicit;

		assertSameConstruct(block.compute, explicit, 'block _compute wins over the default');
	});

	test('descendant inherits an ancestor scope compute', async () => {
		await makeStack('ComputeScoped');

		const scoped = new LambdaCompute(new Scope('s'), 'scoped');
		const outer = new Scope('outer');
		outer._compute = scoped;
		const middle = new Scope('middle', { parent: outer });
		const leaf = new Scope('leaf', { parent: middle });

		assertSameConstruct(leaf.compute, scoped, 'descendant resolves to the ancestor compute');
	});

	test('a real LambdaCompute is its descendants\' compute and ScopeOptions.compute preserves that binding', async () => {
		await makeStack('ComputeIdentityParent');

		const root = new Scope('users-root');
		const users = new LambdaCompute(root, 'users');
		const data = new Scope('data', { parent: users });
		const nested = new Scope('nested', { parent: data });
		const explicitlyBound = new Scope('explicit', { parent: root, compute: users });
		const sibling = new Scope('sibling', { parent: root });

		assertSameConstruct(users.compute, users, 'a compute must resolve to itself');
		assertSameConstruct(data.compute, users, 'a direct child inherits its parent LambdaCompute');
		assertSameConstruct(nested.compute, users, 'nested descendants retain the LambdaCompute binding');
		assertSameConstruct(explicitlyBound.compute, users, 'ScopeOptions.compute selects the public compute binding');
		assert.ok(sibling.compute !== users, 'a sibling remains on the unbound default compute');
	});

	test('nearest assignment wins along the ancestor chain', async () => {
		await makeStack('ComputeNearest');

		const outerCompute = new LambdaCompute(new Scope('oc'), 'outerC');
		const innerCompute = new LambdaCompute(new Scope('ic'), 'innerC');
		const ownCompute = new LambdaCompute(new Scope('own'), 'ownC');

		const outer = new Scope('outer');
		outer._compute = outerCompute;
		const inner = new Scope('inner', { parent: outer });
		inner._compute = innerCompute;

		const leaf = new Scope('leaf', { parent: inner });
		assertSameConstruct(leaf.compute, innerCompute, 'nearest ancestor assignment wins');

		leaf._compute = ownCompute;
		assertSameConstruct(leaf.compute, ownCompute, 'the block’s own assignment beats any ancestor');
	});
});
