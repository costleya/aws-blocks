# Identity Pool: Explicit request credentials

`IdentityPool` is an optional AWS Blocks construct attached to `LambdaCompute` for grant synthesis. An API method explicitly calls `await pool.assumeForIdentity(context)` to exchange the request's token and select credentials for subsequent Building Block calls. Resource `identityAccess` declarations describe pool-role permissions separately from authentication.

## Request behavior

| Configuration and request | Result |
| --- | --- |
| Compute without IdentityPool | Existing execution-role behavior |
| Bound Compute, no call to `assumeForIdentity()` | Ordinary Lambda execution-role client |
| Explicit assumption, no Authorization header | New guest identity and unauthenticated-role credentials |
| Explicit assumption, valid configured provider token | Authenticated identity and authenticated-role credentials |
| Explicit assumption, malformed or rejected Authorization | Reject the assumption and poison the request; never retry as guest or fall back to the execution role |

Both guest and authenticated pool roles start without application-data permissions. CDK translates `identityAccess` into IAM role policies, which do not grant the Lambda execution role access. The AWS runtime uses selected credentials and lets IAM evaluate the declared key and prefix restrictions; the mock simulates those grants locally. An expired selected identity fails, and a failed assumption cannot revert to the execution role within the same request. Guest identities are fresh per explicit assumption in this first version; it does not promise persistent guest storage or automatic guest-to-user data migration.

```mermaid
sequenceDiagram
    participant U as Caller
    participant C as Compute request scope
    participant I as Cognito Identity Pool
    participant H as API method or RawRoute
    participant D as DynamoDB or S3
    U->>C: Request, optional provider bearer token
    C->>H: Invoke API method
    H->>I: assumeForIdentity(context): GetId and GetCredentialsForIdentity
    I-->>H: IdentityId, authentication state; credentials held by Core
    H->>D: Data operation signed with request credentials
    Note over D: IAM evaluates declared key or object-path restrictions
    D-->>H: Result or access denied
    H-->>U: Application result
```

Identity Pools issue temporary IAM role credentials, not a policy object. IAM applies the configured role policies to each signed service request after an API method assumes an identity. Lambda retains its own execution role for initialization, deliberate system operations, and application operations that do not assume an identity. Application code is trusted: this design cannot isolate resources from malicious code running in the same Lambda.

The client supplies a provider token, not an identity ID, pool, provider name, role ARN or credential bundle. Cognito verifies the fixed configured provider. An Identity Pool does not look up application organization membership. Identity Pool IDs, User Pool subjects and application organization IDs remain distinct.

## Local application walkthrough

```ts
import { ApiError, ApiNamespace, IdentityPool, KVStore, LambdaCompute, Scope } from '@aws-blocks/blocks';

const root = new Scope('app');
const pool = new IdentityPool(root, 'identity', {
  provider: {
    name: 'login.example.com',
    oidcProviderArn: 'arn:aws:iam::000000000000:oidc-provider/login.example.com',
  },
  mockIdentities: { 'local-alice': 'eu-west-1:11111111-1111-4111-8111-111111111111' },
});
const compute = new LambdaCompute(root, 'users', { identityPool: pool });
const scope = new Scope('data', { parent: compute });
const notes = new KVStore<string>(scope, 'notes', {
  identityAccess: [
    { access: 'authenticated', operations: ['get', 'put', 'delete'], keyPatterns: ['${identityId}#*'] },
    { access: 'guest', operations: ['get'], keyPatterns: ['public/*'] },
  ],
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async saveNote(text: string) {
    const identity = await pool.assumeForIdentity(context);
    if (!identity.authenticated) throw new ApiError('Sign in to save notes.', 401);
    await notes.put(`${identity.identityId}#note`, text);
  },
  async readNote() {
    const identity = await pool.assumeForIdentity(context);
    if (!identity.authenticated) throw new ApiError('Sign in to read notes.', 401);
    return notes.get(`${identity.identityId}#note`);
  },
  async readPublicNote() {
    await pool.assumeForIdentity(context);
    return notes.get('public/welcome');
  },
}));
```

The provider ARN above is a placeholder for an existing IAM OIDC provider. User Pool configuration is not required. Omit `provider` to create a guest-only pool; supplying a token to a guest-only pool rejects an explicit assumption. Local development accepts only the explicitly configured mock token map. Production forwards `Authorization: Bearer <provider token>` to the backend; an API method exchanges it through Cognito when it calls `assumeForIdentity(context)`.

The example grants guests a public read; an authenticated user needs a separate public-read grant if the application wants the same access after sign-in. Guest permissions are not inherited by the authenticated role.

`assumeForIdentity(context)` returns only `identityId` and `authenticated` and sets the same credential-free information on `context.identity`. Scope parentage selects Compute; `ScopeOptions.compute` can override it. The Compute binding supplies the pool-role grant relationship but does not exchange credentials at dispatch. Core invalidates selected credentials at request end and guards deferred iterators that escape the request scope.

## Resource permissions and internal changes

`identityAccess` is a list of role, operation and optional key-pattern declarations. Patterns support `*` and the literal `${identityId}` placeholder. Omitting patterns explicitly grants the listed operations across that resource. No data is rekeyed or migrated automatically.

| Surface | Implementation and boundary |
| --- | --- |
| IdentityPool | Conditional CDK/AWS/mock/browser exports, optional external OIDC provider, enhanced Cognito exchange, separate guest/authenticated role trusts, sanitized errors |
| Compute and core | Optional binding for grant synthesis, explicit request assumption, credential-free public identity, async request lifetime and expiration checks |
| Core resource grants | Shared declarations, local mock policy simulation, resource-specific CDK translation; no default app grants for either pool role |
| KVStore | Get/put/delete and explicitly unrestricted scan; actual partition keys use DynamoDB LeadingKeys when patterns are declared |
| DistributedTable | Direct/batch reads and writes, table/GSI query keys, explicit unrestricted scans; all actual partition keys checked; identity roles retain operation-appropriate grants for customer-managed encryption keys |
| FileBucket | Object read/write/delete, batches, list, versions/restore and signed URLs use caller credentials; object ARN patterns and separate list-prefix conditions |
| KnowledgeBase | Explicit retrieve and ingestion-status operations use caller credentials; grants apply to the knowledge base. Key patterns are rejected because caller S3 prefixes cannot filter Bedrock retrieval |
| AuthBasic, AuthCognito, AuthOIDC | Private user/code/session tables deliberately retain system access so authentication can work before identity exists; consumer scopes retain identity enforcement |
| AsyncJob and Realtime | Private job-status and WebSocket-connection bookkeeping deliberately remains system-owned; no user credentials are serialized into queue or WebSocket payloads |
| Agent | Rejected on an identity-bound Compute: its separate AgentCore/background persistence requires an explicit future identity delegation design |
| Framework config and deployment | Config S3 bootstrap, hosting assets/cache, GSI management Lambdas, and Bedrock ingestion service roles remain system operations |
| Packaging | Umbrella exports, operation/grant types, generated API reports, catalog and changeset; existing data formats/resource names preserved |

DynamoDB `LeadingKeys` conditions use `ForAllValues:StringLike` together with a `Null: false` guard. They match real partition-key values, including query/index keys; they do not filter arbitrary attributes or sort keys. Scan cannot enforce those restrictions, so a patterned scan grant is rejected. An explicitly unrestricted scan grant allows table-wide scanning.

S3 object requests use object ARN patterns. Listing uses bucket permissions plus `s3:prefix`; limiting listing alone does not protect object access. Signed URLs are delegated access with their own expiration and must be treated accordingly.

After explicit assumption, each identity-aware AWS operation uses a fixed credential snapshot in its own client rather than mutating a shared client or supplying a changing provider that the SDK can cache across users. Without an assumption, the ordinary Lambda-role client is used. All work must finish inside the awaited request boundary. Detached work, cron, SQS handlers and AgentCore do not implicitly inherit a user's identity. User-owned data access from those contexts requires a future explicit delegation design.

## Local verification

Run build and test commands serially and wait for each process to exit before
starting another. The LambdaCompute test script limits Node heaps to 512 MiB,
uses one test worker, and applies a 30-second timeout. Its construct identity
assertions keep only booleans in failure payloads: formatting unequal CDK
construct graphs was reproduced exhausting a capped heap, whereas the same
failed boolean comparison exits normally. The TypeScript build needs a larger
heap for CDK declarations; local acceptance uses a 1536 MiB heap limit and a
separate process-group memory watchdog.

```sh
npm run build
npm test -w @aws-blocks/bb-identity-pool
npm test -w @aws-blocks/bb-lambda-compute
npm test -w @aws-blocks/bb-kv-store
npm test -w @aws-blocks/bb-distributed-table
npm test -w @aws-blocks/bb-file-bucket
npm test -w @aws-blocks/bb-knowledge-base
npm run test:e2e:local
```

The comprehensive fixture is enabled only when `BLOCKS_TEST_ENV=local`; fake OIDC configuration is absent from deployed stacks. Its `IdentityPool explicit HTTP identity selection` suite exercises no-pool requests, bound methods without assumption, guests, valid Alice/Bob identities and invalid tokens through actual HTTP dispatch for KVStore, DistributedTable and FileBucket.

From `test-apps/comprehensive`, run the focused walkthrough with:

```sh
BLOCKS_TEST_ENV=local node --import tsx --conditions=browser --test \
  --test-name-pattern='IdentityPool explicit HTTP identity selection' test/e2e.test.ts
```

Package tests intercept real SDK requests to verify signatures and session tokens, exercise concurrency and expiration, and synthesize CDK locally under `--conditions=cdk` to inspect role trusts and grants. Additional tests cover the deliberate system-storage exceptions and unsupported Agent boundary. Mock checks and synthesized policies do not prove deployed IAM evaluation. No sandbox or live Cognito request is required for these checks.

## Remaining integrations

- Cognito User Pool support: configure its provider/client and exchange its ID token using the existing server session model. AuthCognito integration is not automatic.
- Browser and SSR token sourcing, refresh and logout: forward tokens only to the intended backend; avoid process-global user tokens during SSR.
- Persistent guest identity and guest-to-user migration: requires a separate ownership and persistence design.
- Organization membership and principal tags: derive authorization from verified membership rather than trusting a client-supplied organization ID.
- Background execution and AgentCore: explicitly define delegation, credential expiry, retries and data ownership before enabling user-scoped data access.
- Other service SDKs such as relational databases, SES and SSM: require their own authorization model; this change covers the documented DynamoDB/S3 paths and Bedrock-mediated knowledge bases.
- Deployment acceptance: separately authorize real token exchange, IAM denial tests and cleanup. Token revocation and already-issued AWS credential expiry are separate concerns.

## AWS sources checked through AWS MCP

- [Identity Pool authentication flow](https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flow.html)
- [GetId](https://docs.aws.amazon.com/cognitoidentity/latest/APIReference/API_GetId.html) and [GetCredentialsForIdentity](https://docs.aws.amazon.com/cognitoidentity/latest/APIReference/API_GetCredentialsForIdentity.html)
- [Identity Pool IAM roles](https://docs.aws.amazon.com/cognito/latest/developerguide/iam-roles.html)
- [Lambda execution role](https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html)
- [DynamoDB fine-grained conditions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html) and [IAM set operators](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-single-vs-multi-valued-context-keys.html)
- [Knowledge Base API permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-prereq-permissions-general.html) and [service-role permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-permissions.html)
