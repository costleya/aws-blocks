// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { AgentResultEvent } from '@strands-agents/sdk';
import { z } from 'zod';
import { AgentErrors, InterruptError } from './errors.js';
import { Agent } from './index.mock.js';
import type { AgentConfig } from './types.js';

type AgentOverrides = Omit<Partial<AgentConfig>, 'inferenceOnly' | 'model' | 'systemPrompt'>;

function createAgent(id: string, config: AgentOverrides = {}) {
	return new Agent(new Scope(`document-patch-${id}`), 'agent', {
		...config,
		inferenceOnly: true,
		systemPrompt: 'Respond briefly.',
		model: { local: { provider: 'canned' }, deployed: { provider: 'canned' } },
	});
}

async function completionFor(doneChunk: Record<string, unknown>) {
	const agent = createAgent('completion-fake');
	const runtime = agent as unknown as {
		dispatchTurn(): Promise<void>;
		rt: {
			getChannel(): Promise<unknown>;
			subscribe(_namespace: string, _channel: string, handler: (data: unknown) => void): () => void;
		};
	};
	runtime.dispatchTurn = async () => {};
	runtime.rt = {
		getChannel: async () => ({}),
		subscribe: (_namespace, _channel, handler) => {
			queueMicrotask(() => handler(doneChunk));
			return () => {};
		},
	};
	return (await agent.stream('hello')).complete();
}

test('complete returns a logical completion instead of the done transport chunk', async () => {
	const completion = await completionFor({
		type: 'done',
		text: 'Draft complete.',
		usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
	});
	assert.deepStrictEqual(completion, {
		text: 'Draft complete.',
		usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
	});
	assert.ok(!('type' in completion));
});

test('complete preserves explicit null structured output and omits undefined fields', async () => {
	const nullCompletion = await completionFor({ type: 'done', text: 'No draft.', structuredOutput: null });
	assert.deepStrictEqual(nullCompletion, { text: 'No draft.', structuredOutput: null });

	const absentCompletion = await completionFor({ type: 'done', text: 'Text only.' });
	assert.deepStrictEqual(absentCompletion, { text: 'Text only.' });
	assert.ok(!('structuredOutput' in absentCompletion));
	assert.ok(!('usage' in absentCompletion));
});

test('complete retains the established server error and interrupt behavior', async () => {
	await assert.rejects(
		() => completionFor({ type: 'error', error: 'model unavailable' }),
		(error: unknown) =>
			error instanceof Error &&
			error.name === AgentErrors.StreamFailed &&
			/model unavailable/.test(error.message),
	);
	await assert.rejects(
		() => completionFor({ type: 'interrupt', interrupts: [{ id: 'approval-1', name: 'reviewDraft' }] }),
		(error: unknown) => error instanceof InterruptError && error.interrupts[0]?.id === 'approval-1',
	);
});

test('forwards a native structured output schema to Strands', async () => {
	const structuredOutput = z.object({ title: z.string() }).strict();
	const agent = createAgent('schema-forwarding', { structuredOutput });
	const strands = await (
		agent as unknown as {
			createStrandsAgent(): Promise<{ _structuredOutputSchema?: unknown }>;
		}
	).createStrandsAgent();
	assert.strictEqual(strands._structuredOutputSchema, structuredOutput);
});

test('the canned provider honors Strands forced structured-tool selection', async () => {
	const structuredOutput = z.object({ title: z.string() }).strict();
	const agent = createAgent('canned-structured-output', { structuredOutput });
	const completion = await (await agent.stream('Call the structured output tool.')).complete();
	assert.deepStrictEqual(completion.structuredOutput, { title: 'sample' });
});

test('maxModelCalls throws before the second native structured-output provider turn', async () => {
	const agent = createAgent('canned-structured-output-cap', {
		structuredOutput: z.object({ title: z.string() }).strict(),
		maxModelCalls: 1,
	});
	await assert.rejects(
		async () => await (await agent.stream('Call the structured output tool.')).complete(),
		/Agent model call limit of 1 exceeded/,
	);
});

test('captures native structured output even when AgentResultEvent reports no metrics', async () => {
	const agent = createAgent('structured-output-without-usage');
	const chunks: Array<Record<string, unknown>> = [];
	const runtime = agent as unknown as {
		createStrandsAgent(): Promise<unknown>;
		rt: { publish(_namespace: string, _channel: string, chunk: Record<string, unknown>): Promise<void> };
	};
	runtime.createStrandsAgent = async () => ({
		addHook: () => {},
		appState: new Map(),
		cancel: () => {},
		async *stream() {
			yield new AgentResultEvent({
				agent: {} as never,
				invocationState: {},
				result: { structuredOutput: { title: 'Draft' } } as never,
			});
		},
	});
	runtime.rt = {
		publish: async (_namespace, _channel, chunk) => {
			chunks.push(chunk);
		},
	};
	await agent.invokeTurn({ message: 'source material', channelId: 'channel', userId: 'author' });
	assert.deepStrictEqual(chunks, [
		{ type: 'done', text: '', structuredOutput: { title: 'Draft' }, usage: undefined },
	]);
});

test('workflow turns retain native schema forwarding and the final logical completion', async () => {
	const sectionSchema = z.object({ sectionIds: z.array(z.string()) }).strict();
	const agent = createAgent('workflow', {
		workflow: async ({ turn }) => {
			const manifest = await turn('Call strands_structured_output for the manifest.', {
				structuredOutput: sectionSchema,
			});
			return { text: 'workflow complete', structuredOutput: manifest.structuredOutput };
		},
	});
	const completion = await (await agent.stream('source material')).complete();
	assert.deepStrictEqual(completion, {
		text: 'workflow complete',
		structuredOutput: { sectionIds: [] },
		usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
	});
});

test('workflow waits for an issued unawaited turn before publishing its final completion', async () => {
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const toolStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const agent = createAgent('workflow-drain', {
		workflow: ({ turn }) => {
			void turn('run lateTask');
			return Promise.resolve({ text: 'workflow complete' });
		},
		tools: (tool) => ({
			lateTask: tool({
				description: 'Complete only after the test releases it.',
				parameters: z.object({}),
				handler: async () => {
					started?.();
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { ok: true };
				},
			}),
		}),
	});
	const completion = (await agent.stream('source material')).complete();
	await toolStarted;
	let settled = false;
	void completion.then(() => {
		settled = true;
	});
	await Promise.resolve();
	assert.strictEqual(settled, false);
	release?.();
	assert.deepStrictEqual(await completion, {
		text: 'workflow complete',
		usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
	});
});

test('a failed structured workflow turn prevents queued later turns from running', async () => {
	let laterToolCalls = 0;
	const agent = createAgent('workflow-failure-stops-queue', {
		workflow: ({ turn }) => {
			void turn('Call strands_structured_output with an invalid title.', {
				structuredOutput: z.object({ title: z.string().min(20) }).strict(),
			});
			void turn('run mustNotRun');
			return Promise.resolve({ text: 'unreachable' });
		},
		tools: (tool) => ({
			mustNotRun: tool({
				description: 'This must not execute after the prior workflow turn fails.',
				parameters: z.object({}),
				handler: async () => {
					laterToolCalls += 1;
					return { ok: true };
				},
			}),
		}),
	});
	await assert.rejects(
		async () => await (await agent.stream('source material')).complete(),
		/Agent workflow turn did not return structured output|too_small|title|failed to invoke the structured output tool/,
	);
	assert.strictEqual(laterToolCalls, 0);
});

test('rejects invalid JSON-only structured output before it crosses the completion transport', async () => {
	for (const [name, structuredOutput] of [
		['date', new Date()],
		['bigint', BigInt(1)],
	] as const) {
		const agent = createAgent(`invalid-json-${name}`, {
			workflow: (() => Promise.resolve({ text: 'invalid output', structuredOutput })) as never,
		});
		await assert.rejects(async () => await (await agent.stream('source material')).complete());
	}

	const cyclic: { self?: unknown } = {};
	cyclic.self = cyclic;
	const agent = createAgent('invalid-json-cycle', {
		workflow: (() => Promise.resolve({ text: 'invalid output', structuredOutput: cyclic })) as never,
	});
	await assert.rejects(async () => await (await agent.stream('source material')).complete());
});

test('maxModelCalls validates its legacy cap and throws before an excess workflow invocation', async () => {
	for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, Number.NaN]) {
		assert.throws(
			() => createAgent(`invalid-model-call-${invalid}`, { maxModelCalls: invalid }),
			(error: unknown) => error instanceof Error && error.name === AgentErrors.InvalidModelConfig,
		);
	}

	const agent = createAgent('legacy-model-cap', {
		maxModelCalls: 1,
		maxLlmCalls: false,
		workflow: async ({ turn }) => {
			await turn('first turn');
			await turn('second turn');
			return { text: 'unreachable' };
		},
	});
	await assert.rejects(
		async () => await (await agent.stream('source material')).complete(),
		/Agent model call limit of 1 exceeded/,
	);
});

test('maxModelCalls above the generic default permits every workflow invocation when maxLlmCalls is omitted', async () => {
	const structuredOutput = z.object({ title: z.string() }).strict();
	const agent = createAgent('legacy-model-cap-over-default', {
		maxModelCalls: 21,
		maxToolIterations: false,
		workflow: async ({ turn }) => {
			for (let index = 0; index < 21; index += 1) {
				await turn(`Call strands_structured_output for turn ${index}.`, { structuredOutput });
			}
			return { text: 'all turns complete' };
		},
	});
	assert.deepStrictEqual(await (await agent.stream('source material')).complete(), {
		text: 'all turns complete',
		usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
	});
});

test('maxLlmCalls and maxToolIterations remain independent of maxModelCalls', async () => {
	const modelCapAgent = createAgent('new-model-cap', {
		maxModelCalls: 2,
		maxLlmCalls: 1,
		tools: (tool) => ({
			status: tool({ description: 'Get status.', parameters: z.object({}), handler: async () => ({ ok: true }) }),
		}),
	});
	await assert.rejects(async () => await (await modelCapAgent.stream('run status')).complete(), /maxLlmCalls/);

	const toolCapAgent = createAgent('tool-cap', {
		maxModelCalls: 3,
		maxToolIterations: 1,
		tools: (tool) => ({
			alpha: tool({ description: 'Alpha.', parameters: z.object({}), handler: async () => ({ ok: true }) }),
			bravo: tool({ description: 'Bravo.', parameters: z.object({}), handler: async () => ({ ok: true }) }),
		}),
	});
	await assert.rejects(
		async () => await (await toolCapAgent.stream('run alpha and bravo')).complete(),
		/maxToolIterations/,
	);
});
