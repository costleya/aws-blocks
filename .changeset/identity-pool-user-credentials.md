---
"@aws-blocks/core": minor
"@aws-blocks/bb-identity-pool": minor
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/bb-distributed-table": minor
"@aws-blocks/bb-file-bucket": minor
"@aws-blocks/bb-knowledge-base": minor
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": minor
---

Add an experimental IdentityPool Building Block that optionally binds to LambdaCompute for identity-role grants. API methods explicitly call `await identityPool.assumeForIdentity(context)` to exchange a missing login for Cognito guest credentials or a valid OIDC token for authenticated credentials. Invalid supplied logins fail the assumption and poison the request. Methods that do not assume an identity use the ordinary Lambda-role client.

Add explicit identityAccess operation and key grants to KVStore, DistributedTable and FileBucket, and knowledge-base-level grants to KnowledgeBase. After assumption, request-local SDK clients use the selected credentials; guest and authenticated pool roles receive no application access by default. Expose credential-free identity information through BlocksContext.identity. CDK synthesizes DynamoDB LeadingKeys and S3 prefix policies for IAM enforcement; mocks simulate declared grants locally.

Keep authentication records, job status and WebSocket connection bookkeeping explicitly system-owned. Reject Agent on identity-bound computes until its separate background runtime can propagate identity safely. Preserve existing resource names and stored formats.

Keep customer-managed DynamoDB encryption keys usable with identity roles. Bound LambdaCompute test memory and compare construct identity without expanding CDK graphs into assertion failures.
