// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import type { IdentityPoolOptions, IdentityPoolUser } from './types.js';

export { IdentityPoolErrors } from './errors.js';
export type { IdentityPoolOptions, IdentityPoolUser } from './types.js';

/** Browser stub. Identity credential exchange and callbacks are server-only. */
export class IdentityPool {
	// biome-ignore lint/complexity/noUselessConstructor: Conditional exports keep the public constructor signature identical.
	constructor(_scope: ScopeParent, _id: string, _options: IdentityPoolOptions) {}

	run<T>(_context: BlocksContext, _callback: (user: IdentityPoolUser) => Promise<T>): Promise<T> {
		throw new Error('IdentityPool.run() is server-side only.');
	}

	assumeForIdentity(_context: BlocksContext): Promise<IdentityPoolUser> {
		throw new Error('IdentityPool.assumeForIdentity() is server-side only.');
	}
}
