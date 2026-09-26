// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
/**
 * AWS-runtime entry point for `LambdaCompute`.
 *
 * The same backend module that declares `new LambdaCompute(...)` is imported in
 * two phases: at CDK synth (where the `cdk` entry provisions the function + API
 * Gateway) and again at request time inside the deployed runtime. At runtime
 * there is nothing for a compute to do — it *is* the environment the handler
 * already runs in, and its infrastructure was created at synth. So the runtime
 * `LambdaCompute` is an inert handle: it constructs (so the import succeeds and
 * any `{ compute }` reference resolves) but provisions nothing and pulls in no
 * CDK. `setEnv` is a no-op — configuration is injected at synth, not at runtime.
 */
import { Scope } from '@aws-blocks/core';
import type { LambdaComputeProps } from './types.js';

export type { IdentityPoolReference, LambdaComputeProps } from './types.js';

export class LambdaCompute extends Scope {
	/**
	 * This runtime handle is itself the compute selected by descendant scopes.
	 * Scope initializes `compute` from its parent before this derived field runs;
	 * replacing it here ensures `new Scope(..., { parent: compute })` keeps the
	 * Lambda's identity-provider binding instead of falling back to the parent.
	 */
	override readonly compute: this = this;

	/**
	 * Identity provider selected for this compute at declaration time. Core uses
	 * the matching compute association to enter its request-scoped identity
	 * callback before application code runs.
	 */
	readonly identityProviderFullId?: string;

	constructor(scope: ScopeParent, id: string, options?: LambdaComputeProps) {
		super(id, { parent: scope });
		this.identityProviderFullId = options?.identityPool?.fullId;
	}

	setEnv(_key: string, _value: string): void {}
}
