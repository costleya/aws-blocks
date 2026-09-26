// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const MAX_BEARER_TOKEN_BYTES = 16_384;

/** Return a syntactically valid bearer token without logging or decoding it. */
export function bearerToken(headers: Headers): string | null {
	const authorization = headers.get('authorization');
	if (!authorization) return null;
	const match = /^Bearer ([^\s]+)$/i.exec(authorization);
	if (!match || Buffer.byteLength(match[1], 'utf8') > MAX_BEARER_TOKEN_BYTES) return null;
	return match[1];
}
