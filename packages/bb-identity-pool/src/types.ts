// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Configuration for an Identity Pool with optional authenticated OIDC access. */
export interface IdentityPoolOptions {
	/**
	 * The OIDC provider that Cognito validates. `name` is the Cognito `Logins`
	 * key (the issuer without `https://`); `oidcProviderArn` identifies the
	 * existing IAM OIDC provider that the Identity Pool trusts. Omit it for a
	 * guest-only pool; any supplied bearer token then fails rather than falling
	 * back to a guest identity.
	 */
	provider?: {
		name: string;
		oidcProviderArn: string;
	};
	/**
	 * Explicit bearer-token to identity mappings used only by the local mock.
	 * No mapping is created implicitly, so applications choose every local
	 * identity that can enter an identity-scoped callback.
	 */
	mockIdentities?: Readonly<Record<string, string>>;
}

/** The Cognito identity available inside an identity-scoped callback. */
export interface IdentityPoolUser {
	identityId: string;
	/** Whether Cognito issued this identity from a validated bearer token. */
	authenticated: boolean;
}
