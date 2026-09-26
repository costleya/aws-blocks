// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Typed errors for IdentityPool. Use with `isBlocksError()` in catch blocks. */
export const IdentityPoolErrors = {
	/** The request did not supply a configured or valid bearer identity token. */
	Unauthorized: 'IdentityPool.Unauthorized',
	/** The request identity is not permitted to perform the requested resource operation. */
	Forbidden: 'IdentityPool.Forbidden',
	/** Cognito Identity could not issue a complete, usable credential set. */
	Unavailable: 'IdentityPool.Unavailable',
} as const;
