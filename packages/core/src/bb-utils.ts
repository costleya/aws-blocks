// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { API_NAMESPACE_MARKER } from './api.js';
// Defined in the config module (it owns the config-key contract), re-exported
// here so BB authors get it alongside the other BB utilities.
export { sanitizeConfigKey } from './common/config.js';
export { constantTimeEquals } from './common/crypto.js';
export {
	assertResourceIdentityAccess,
	assumeRequestIdentity,
	captureRequestIdentity,
	clearRequestIdentity,
	getComputeIdentityProvider,
	getResourceIdentity,
	type IdentityAccess,
	type IdentityComputeHandle,
	type IdentityCredentials,
	type IdentityProvider,
	type IdentityResourceGrant,
	type IdentityResourceScope,
	interpolateIdentityKeyPatternForIam,
	markSystemIdentityScope,
	type RequestIdentity,
	registerIdentityProvider,
	registerResourceIdentityAccess,
	requireIdentity,
	runWithIdentity,
	runWithRequestIdentity,
	runWithRequestScope,
	withRequestAwsClient,
	withSystemIdentityScope,
} from './common/identity-context.js';
/**
 * Utilities for Building Block authors.
 *
 * Used by standard BBs and available to customers writing custom Building Blocks.
 * Not part of the main '.' export — import from '@aws-blocks/core/bb-utils'.
 */
export { getMockDataDir } from './common/mock-data.js';
export { EventSourceMapping } from './lambda-handler.js';
