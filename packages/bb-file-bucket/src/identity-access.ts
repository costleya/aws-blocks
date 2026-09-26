// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IdentityResourceGrant } from '@aws-blocks/core/bb-utils';
import type { FileBucketOperation } from './types.js';

/**
 * Validate patterns for operations backed by a bucket listing.
 *
 * S3's s3:prefix condition checks the requested prefix, not returned keys.
 * A condition on `foo` could therefore list `foobar`. get always needs a
 * pattern for its missing-object probe; scan and listVersions may omit
 * patterns when unrestricted listing is explicitly granted.
 */
export function validateIdentityListAccess(grant: IdentityResourceGrant<FileBucketOperation>): void {
	const hasGet = grant.operations.includes('get');
	const hasList = grant.operations.includes('scan') || grant.operations.includes('listVersions');
	if (!hasGet && !hasList) return;
	if (hasGet && !grant.keyPatterns?.length) {
		throw new Error(
			'FileBucket identity grants for get require one or more slash-delimited key prefixes ending in /*.',
		);
	}
	if (grant.keyPatterns?.some((pattern) => pattern === '*' || !pattern.endsWith('/*'))) {
		throw new Error(
			'FileBucket identity grants for get, scan, or listVersions with key patterns require slash-delimited prefixes ending in /*.',
		);
	}
}
