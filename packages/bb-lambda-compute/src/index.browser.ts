// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — a compute is server-side infrastructure and never runs in the
// browser. The backend module that constructs it is type-imported by frontends,
// so this stub keeps CDK out of the browser bundle while the reference resolves.
import type { LambdaComputeProps } from './types.js';

export class LambdaCompute {
	/**
	 * This browser stub is itself the compute selected by descendant scopes,
	 * matching the runtime handle's structural compute association.
	 */
	readonly compute: this = this;

	/**
	 * Identity provider selected for this compute at declaration time. This stub
	 * preserves the runtime handle's metadata without loading server code.
	 */
	readonly identityProviderFullId?: string;

	constructor(_scope: unknown, _id: string, options?: LambdaComputeProps) {
		this.identityProviderFullId = options?.identityPool?.fullId;
	}

	setEnv(_key: string, _value: string): void {}
}
export type { IdentityPoolReference, LambdaComputeProps } from './types.js';
