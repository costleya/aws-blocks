// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { JSONValue } from './types.js';

/** Runtime boundary for values that can safely cross the Realtime JSON transport. */
const isJsonValue = (value: unknown, ancestors = new Set<object>()): value is JSONValue => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	if (ancestors.has(value)) return false;

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				if (!isJsonValue(value[index], ancestors)) return false;
			}
			return true;
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
		return Object.values(value).every((child) => isJsonValue(child, ancestors));
	} finally {
		ancestors.delete(value);
	}
};

export const jsonValueSchema: z.ZodType<JSONValue> = z.custom<JSONValue>(isJsonValue);

/** Schema for conversation metadata stored in DistributedTable (Table 1). */
export const conversationSchema = z.object({
	userId: z.string(),
	conversationId: z.string(),
	name: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
});

/** Schema for messages stored in DistributedTable (Table 2). */
export const messageSchema = z.object({
	conversationId: z.string(),
	messageId: z.string(),
	role: z.enum(['user', 'assistant', 'tool-call', 'tool-result', 'approval', 'interrupt']),
	content: z.string(),
	contentType: z.enum(['text', 'image', 'audio', 'video', 'document']),
	userId: z.string(),
	createdAt: z.number(),
	metadata: z.string(), // JSON: { toolName?, toolInput?, toolOutput?, usage?, latencyMs?, error?, confirmationStatus? }
});

/** Schema for AgentStreamChunk — used by Realtime namespace validation. */
export const agentStreamChunkSchema = z.object({
	type: z.enum(['text-delta', 'tool-call', 'tool-result', 'done', 'error', 'interrupt']),
	text: z.string().optional(),
	toolName: z.string().optional(),
	input: z.any().optional(),
	structuredOutput: jsonValueSchema.optional(),
	error: z.string().optional(),
	interrupts: z.array(z.object({ id: z.string(), name: z.string(), reason: z.any().optional() })).optional(),
	usage: z.object({
		inputTokens: z.number(),
		outputTokens: z.number(),
		totalTokens: z.number(),
	}).optional(),
});
