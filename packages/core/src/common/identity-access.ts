// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** The Identity Pool role that receives an explicit resource grant. */
export type IdentityAccess = 'authenticated' | 'guest';

/**
 * A resource-defined identity access grant.
 *
 * `Operation` belongs to the resource rather than IAM: for example, a key/value
 * store might use `'get' | 'put' | 'delete'`. The resource maps its own
 * operations to IAM actions while the local mock uses the same declaration to
 * enforce request access.
 */
export interface IdentityResourceGrant<Operation extends string = string> {
	access: IdentityAccess;
	operations: readonly Operation[];
	/**
	 * Allowed resource keys. `${identityId}` is replaced with the active identity
	 * at runtime and with Cognito's identity claim when generating IAM policy.
	 * `*` is the only wildcard. Omitting this field explicitly grants the listed
	 * operations for every key on the resource.
	 */
	keyPatterns?: readonly string[];
}

const IDENTITY_ID_TOKEN = `\${identityId}`;
const IAM_IDENTITY_ID_TOKEN = `\${cognito-identity.amazonaws.com:sub}`;

/** Validate an identity key pattern before local or CDK policy use. */
export function validateIdentityKeyPattern(pattern: string): void {
	if (!pattern) throw new Error('Identity key patterns must not be empty.');
	if (pattern.includes('?')) {
		throw new Error(`Unsupported identity key wildcard in "${pattern}". Use * only.`);
	}
	const withoutIdentityToken = pattern.replaceAll(IDENTITY_ID_TOKEN, '');
	if (withoutIdentityToken.includes('${') || withoutIdentityToken.includes('}')) {
		throw new Error(`Unsupported identity key pattern token in "${pattern}". Use ${IDENTITY_ID_TOKEN}.`);
	}
}

/** Replace the runtime identity token with the IAM Cognito identity claim. */
export function interpolateIdentityKeyPatternForIam(pattern: string): string {
	validateIdentityKeyPattern(pattern);
	return pattern.replaceAll(IDENTITY_ID_TOKEN, IAM_IDENTITY_ID_TOKEN);
}

/** Match a validated key pattern against an active identity and resource key. */
export function matchesIdentityKeyPattern(pattern: string, identityId: string, key: string): boolean {
	validateIdentityKeyPattern(pattern);
	const escaped = pattern
		.replaceAll(IDENTITY_ID_TOKEN, identityId)
		.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
		.replaceAll('*', '.*');
	return new RegExp(`^${escaped}$`).test(key);
}
