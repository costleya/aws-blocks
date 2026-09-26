# IdentityPool

`@aws-blocks/bb-identity-pool` lets an API method explicitly select a Cognito Identity with `await identityPool.assumeForIdentity(context)`. A request without an `Authorization` header receives a guest identity; a valid trusted OIDC bearer token selects an authenticated identity. Subsequent Building Block AWS calls in that request use Cognito's temporary credentials. Application code never chooses an IAM role or receives raw credentials.

## When to use it

Use IdentityPool when a request must access AWS data with permissions tied to a Cognito Identity, such as data isolated by an `identityId#` partition-key prefix. It creates a Cognito Identity Pool with separate guest and authenticated roles. The guest role has no application permissions until a resource explicitly grants guest access.

Do not use it for caller-selected roles or an application that only needs ordinary server-side authentication. IdentityPool does not accept a client-supplied Identity ID, and a KVStore restricted to `identityId#` keys cannot support `scan()`. Use `get`, `put`, and `delete` with an identity-prefixed key instead.

## Provider configuration

To support authenticated bearer tokens, create the IAM OIDC provider before constructing IdentityPool. Set `provider.name` to its issuer without `https://`; it is the exact Cognito `Logins` map key. Set `provider.oidcProviderArn` to that existing provider's ARN. The OIDC provider's issuer URL and configured client audience must match the tokens your application sends.

```ts
const provider = {
	name: 'issuer.example.com',
	oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/issuer.example.com',
};
```

The account ID above is a placeholder. IdentityPool configures Cognito to trust this pre-existing provider; it does not create an OIDC provider from caller input. Omit `provider` to create a guest-only pool. A request that supplies any bearer token to a guest-only pool is rejected; it is never retried as a guest request.

## Attach a Compute

Attach the pool to the `LambdaCompute` that handles identity-scoped requests. The binding associates the pool's roles with resource `identityAccess` grants during CDK synthesis. Inside each API method that needs identity credentials, call `await identities.assumeForIdentity(context)` before accessing a resource. A bound compute does not exchange credentials automatically; calls without an assumption use the ordinary Lambda execution-role client. Pool-role grants do not grant that execution role data access.

## Minimal backend

This example scopes a key-value store to one IdentityPool. Each API method explicitly selects an identity before using the store; the grant permits authenticated identities to use their own `identityId#` keys.

```ts
import { ApiError, ApiNamespace, Scope } from '@aws-blocks/core';
import { IdentityPool } from '@aws-blocks/bb-identity-pool';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';

const scope = new Scope('app');
const provider = {
	name: 'issuer.example.com',
	oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/issuer.example.com',
};
const identities = new IdentityPool(scope, 'identities', { provider });
const compute = new LambdaCompute(scope, 'notes-compute', { identityPool: identities });
const apiScope = new Scope('notes-api', { parent: compute });
const notes = new KVStore<{ text: string }>(apiScope, 'notes', {
	identityAccess: [{
		access: 'authenticated',
		operations: ['get', 'put', 'delete'],
		keyPatterns: ['${identityId}#*'],
	}],
});

export const api = new ApiNamespace(apiScope, 'notes', (context) => ({
	async getNote() {
		const identity = await identities.assumeForIdentity(context);
		if (!identity.authenticated) throw new ApiError('Sign in to read notes.', 401);
		return notes.get(`${identity.identityId}#note`);
	},
	async putNote(text: string) {
		const identity = await identities.assumeForIdentity(context);
		if (!identity.authenticated) throw new ApiError('Sign in to save notes.', 401);
		await notes.put(`${identity.identityId}#note`, { text });
	},
	async deleteNote() {
		const identity = await identities.assumeForIdentity(context);
		if (!identity.authenticated) throw new ApiError('Sign in to delete notes.', 401);
		await notes.delete(`${identity.identityId}#note`);
	},
}));
```

`assumeForIdentity(context)` returns only the identity ID and authentication state and also sets `context.identity` for the current request. With no `Authorization` header, the explicit call starts Cognito's guest flow. With `Authorization: Bearer <token>`, it starts the authenticated enhanced flow: IdentityPool first obtains an identity, then obtains credentials with the same fixed provider mapping. Cognito's final identity response is authoritative, so it may differ from the initial identity result. A malformed, oversized, unknown, or invalid supplied header rejects the call and is never retried without `Logins`. A failed attempt clears any previously selected identity and prevents later resource calls in that request from using an earlier credential set.

## Local development

The mock accepts only explicitly configured bearer-token mappings. It does not decode a JWT or let a client assert an identity. An absent authorization header receives a fresh guest identity for that request; mock guest identities are not persisted and have no upgrade or reuse guarantee.

```ts
const identities = new IdentityPool(scope, 'identities', {
	provider,
	mockIdentities: {
		'development-token': 'us-east-1:11111111-1111-1111-1111-111111111111',
	},
});
```

Use `Authorization: Bearer development-token` for the authenticated mock fixture above. Missing authorization selects a guest when an API method calls `assumeForIdentity(context)`. Malformed, oversized, inherited, or unmapped bearer tokens reject that call.

## Failures and boundaries

- `IdentityPoolErrors.Unauthorized` is a 401 response for a supplied malformed, unknown, or invalid bearer token.
- `IdentityPoolErrors.Unavailable` is a sanitized 502 response when configuration or Cognito cannot provide a complete credential set with more than 30 seconds remaining.
- A missing header selects a guest only when an API method calls `assumeForIdentity(context)`. A failed assumption cannot fall back to guest access, a token-derived mock identity, or the Lambda execution role during that request.
- Cognito necessarily assumes the pool's guest or authenticated IAM role to issue its temporary credentials. That role is an implementation of the Cognito flow, not an application role the caller can select.
- Raw temporary credentials remain in request-local infrastructure and are never returned by `assumeForIdentity()` or `run()`. Core invalidates the selection when the request ends and guards deferred iterators from using it afterward.
