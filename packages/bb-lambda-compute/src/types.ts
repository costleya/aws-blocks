// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Architecture } from 'aws-cdk-lib/aws-lambda';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * The lightweight reference Lambda Compute needs to associate an Identity Pool
 * with a compute. Pass an Identity Pool instance directly; its `fullId`
 * satisfies this structural reference without creating a package dependency.
 */
export interface IdentityPoolReference {
	readonly fullId: string;
}

/**
 * Options for constructing a `LambdaCompute`.
 */
export interface LambdaComputeProps {
	/**
	 * Optional Identity Pool that supplies authenticated end-user credentials for
	 * requests routed to this compute. The provider is structural so this package
	 * does not depend on a concrete identity Building Block; pass an
	 * `IdentityPool` instance directly.
	 *
	 * Requests without a supplied login enter the provider's guest identity
	 * scope when guests are supported. Invalid supplied logins are rejected.
	 * Omitting this option preserves the compute's existing execution-role behavior.
	 */
	identityPool?: IdentityPoolReference;

	/**
	 * CloudWatch Logs retention for this compute's handler log group. Logs are
	 * always captured; this only bounds how long they're kept. Per-compute
	 * override of the stack-wide `defaults.logRetention` (used when omitted).
	 */
	logRetention?: RetentionDays;

	/**
	 * The instruction-set architecture for the compute's Lambda function.
	 * Defaults to **`Architecture.ARM_64`** (AWS Graviton), which is ~20% cheaper
	 * per GB-second than x86_64 at equivalent performance.
	 *
	 * Set `Architecture.X86_64` here for an explicitly constructed compute whose
	 * backend bundles an x86-only native addon. The umbrella still constructs its
	 * automatic default compute with no options, so that compute uses ARM64.
	 * Explicit computes accept this option through the public constructor.
	 */
	architecture?: Architecture;
}
