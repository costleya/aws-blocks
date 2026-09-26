# Feature request: Allow custom canned responses in `bb-agent`

## Which area does this feature relate to?

- Building Blocks (existing)
- Local development / mocking

## Describe the feature you'd like to request

Allow `bb-agent` users to replace the canned provider's built-in weather, order, and help responses with an application-specific phrase-to-response dictionary.

The model configuration could accept the dictionary inline or as a path to a JSON file:

```ts
const agent = new Agent(scope, 'assistant', {
  systemPrompt: 'Help the user.',
  model: {
    local: {
      provider: 'canned',
      cannedResponses: {
        'reset password': 'Open Settings → Security to reset your password.',
      },
    },
  },
});
```

```ts
const agent = new Agent(scope, 'assistant', {
  systemPrompt: 'Help the user.',
  model: {
    local: {
      provider: 'canned',
      cannedResponses: './canned-responses.json',
    },
  },
});
```

In the second example, `canned-responses.json` contains a JSON object whose keys are phrases and whose values are response strings.

Omitting `cannedResponses` should preserve the current canned-provider behavior. Supplying it should replace the built-in text-response dictionary while retaining the generic fallback and existing tool behavior.

## Use case

The canned provider makes it possible to develop an Agent application locally without model credentials, network access, latency, or nondeterministic model output. Its current fixed responses are useful for the included examples but cannot represent an application's own conversations.

Application-specific responses would let developers exercise real UI and backend flows with deterministic content. For example, an account-support application could test password-reset and account-lockout conversations, while a document application could test known advisory responses. A JSON-backed dictionary would also let a local fixture editor update responses between requests without rebuilding or restarting the development server.

This remains a mock-provider feature: it provides predictable local behavior and does not attempt to simulate general model reasoning.

## Proposed solution

Add this optional field to `ModelConfig`:

```ts
interface ModelConfig {
  // Existing fields...
  cannedResponses?: Record<string, string> | string;
}
```

Forward the value through the model factory to `CannedProvider`. Direct provider users should be able to pass the same union as `responses`.

Suggested behavior:

- A dictionary supplied inline is used for text-response selection.
- A string is treated as a filesystem path. Relative paths resolve against the process working directory when the provider is constructed.
- A file-backed dictionary is read once for each text-response selection. The resulting dictionary is the snapshot for that request, so later requests can observe an atomically replaced file without a watcher or restart.
- Tool-result summaries retain highest precedence, followed by tool calls, then dictionary text responses. Tool paths do not read the response file.
- The first matching dictionary entry in JavaScript object enumeration order wins: array-index keys are visited in ascending numeric order, followed by other string keys in insertion order.
- Keys match literal phrases in the latest message, case-insensitively, with flexible internal whitespace and Unicode-aware word protection. Punctuation is matched literally, and embedded-word false positives are avoided.
- Custom values are emitted verbatim, including empty and whitespace-only strings. The existing streaming behavior remains unchanged for built-in and generic responses.
- An unmatched custom dictionary returns the current generic canned fallback rather than consulting the built-in weather/order/help entries.
- Missing or unreadable files, malformed JSON, non-object JSON, non-string values, and whitespace-only keys fail with a clear error. The provider retries the file on the next text request so correcting it allows recovery.
- Runtime writers should write complete JSON to a temporary file in the same directory and atomically rename it over the configured file.

The configuration is additive and is ignored by real model providers, so existing applications retain their current behavior.

## Alternatives considered

**Continue using the built-in canned responses.** This does not exercise application-specific output or realistic UI states.

**Use `cannedTriggers` and `cannedExamples`.** These are useful for selecting tools and generating tool inputs, but they do not configure ordinary text responses.

**Run a local OpenAI-compatible model.** This is useful when model behavior matters, but it adds a model dependency and produces less deterministic fixture output. It is heavier than necessary for routine application and UI development.

**Implement a separate custom Strands provider in each application.** This can provide the behavior, but it duplicates the canned provider's tool-selection and streaming protocol and makes a common local-development need application-owned.

**Require application code to reload an inline dictionary.** This can support live changes, but it requires application-specific file loading and provider reconstruction. Letting the canned provider read a configured JSON file keeps the behavior in the mock that owns response selection.

## Additional context

A working implementation and regression coverage are available on [`costleya:codex/canned-response-dictionaries`](https://github.com/costleya/aws-blocks/tree/codex/canned-response-dictionaries).

The proposed regression coverage includes default compatibility, inline and file-backed configuration, factory forwarding, tool precedence, literal phrase and punctuation matching, Unicode case equivalence, verbatim empty/whitespace output, live file replacement and removal, invalid-file errors, and recovery using the same provider.

## Is this something you'd be interested in working on?

- [x] I may be able to implement this feature request
- [ ] This feature might incur a breaking change
