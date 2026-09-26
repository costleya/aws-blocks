# @aws-blocks/bb-lambda-compute

The Lambda-backed **compute** for AWS Blocks: a `NodejsFunction` fronted by its
own API Gateway REST API, backing the handler code an app's Building Blocks run
on.

`LambdaCompute` is available from `@aws-blocks/blocks` and this package. The
framework creates the default compute automatically. Construct an additional
compute to attach an optional IdentityPool, then parent its APIs and resources
under that compute or select it with `ScopeOptions.compute`.

> Design and rationale: [DESIGN.md](./DESIGN.md)

## What it provides

`LambdaCompute` — a `Compute` (the abstract base from `@aws-blocks/core`) that
provisions and owns a `NodejsFunction` (2048 MB, 15-minute timeout) fronted by
its own API Gateway REST API. The function assumes the shared Blocks execution
role, so Building Block grants reach it; its handler entry and `BLOCKS_STACK_NAME`
are derived from the owning `BlocksStack` / `BlocksBackend`, never
caller-supplied.

| Member | Type | Description |
|--------|------|-------------|
| `fn` | `NodejsFunction` | The Lambda function backing this compute (CDK layer). |
| `apiGateway` | `RestApi` | The API Gateway REST API fronting `fn` (CDK layer). |
| `setEnv(key, value)` | `void` | Inject a runtime environment variable into the function. |

## Identity-scoped requests

Pass an `IdentityPool` as `identityPool` when constructing a compute to bind
that provider to every request routed to it. The option needs only the
Identity Pool's `fullId`, so Lambda Compute does not depend on a concrete
identity Building Block package. Core performs the request dispatch: a valid
authenticated identity enters the provider's request scope before application
code runs, and a provider configured for guest access receives guest requests
when no login is supplied. An invalid supplied login is rejected and never
falls back to guest credentials. Computes without `identityPool` keep their
existing execution-role behavior.

## Local Development

Only the `cdk` layer provisions infrastructure (the `NodejsFunction` + API
Gateway); the runtime, local-dev, and browser layers are inert handles that
construct without pulling in CDK, because a compute has no request-time
behavior. See the CDK tests (`src/index.cdk.test.ts`) for how `LambdaCompute`
synthesizes within a stack.

Run local verification serially. This package's test command caps each Node
heap at 512 MiB, runs one test file at a time, and sets a 30-second test timeout.
Construct identity assertions compare booleans so a failure cannot expand the
entire connected CDK graph into an assertion payload.
