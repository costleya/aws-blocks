---
'@aws-blocks/bb-agent': minor
---

Restore native structured-output schema forwarding, ordered workflow turns, JSON-safe final results,
and the throwing maxModelCalls guard. Honor forced tool selection in the local canned provider.

Server-side stream completion now returns the logical AgentCompletion value
`{ text, structuredOutput?, usage? }` without the transport `type` field. Existing Realtime chunks
and RPC stream-result serialization remain available.
