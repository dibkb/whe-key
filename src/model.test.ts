import { expect, test } from "bun:test";

import {
	type FakeScript,
	fakeModel,
	type ModelEvent,
	type ModelRequest,
} from "./index.ts";

async function collect(
	stream: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
	const events: ModelEvent[] = [];

	for await (const event of stream) {
		events.push(event);
	}

	return events;
}

const scriptA: FakeScript = [
	{
		kind: "event",
		event: {
			type: "text-delta",
			delta: "first",
		},
	},
	{
		kind: "event",
		event: {
			type: "finish",
			reason: "stop",
		},
	},
];

const scriptB: FakeScript = [
	{
		kind: "event",
		event: {
			type: "text-delta",
			delta: "second",
		},
	},
	{
		kind: "event",
		event: {
			type: "finish",
			reason: "stop",
		},
	},
];

test("reserves one script per stream call and captures requests", async () => {
	const model = fakeModel([scriptA, scriptB]);

	const requestA: ModelRequest = {
		messages: [
			{
				role: "user",
				content: "Request A",
			},
		],
		tools: [],
	};

	const requestB: ModelRequest = {
		messages: [
			{
				role: "user",
				content: "Request B",
			},
		],
		tools: [],
	};

	const requestC: ModelRequest = {
		messages: [
			{
				role: "user",
				content: "Request C",
			},
		],
		tools: [],
	};

	const streamA = model.stream(requestA, {
		signal: new AbortController().signal,
	});

	const streamB = model.stream(requestB, {
		signal: new AbortController().signal,
	});

	const eventsA = await collect(streamA);
	const eventsB = await collect(streamB);
	expect(eventsA).toEqual([
		{
			type: "text-delta",
			delta: "first",
		},
		{
			type: "finish",
			reason: "stop",
		},
	]);

	expect(eventsB).toEqual([
		{
			type: "text-delta",
			delta: "second",
		},
		{
			type: "finish",
			reason: "stop",
		},
	]);
	expect(model.requests).toEqual([requestA, requestB]);

	let exhaustionError: unknown;

	try {
		model.stream(requestC, {
			signal: new AbortController().signal,
		});
	} catch (error) {
		exhaustionError = error;
	}

	expect(exhaustionError).toMatchObject({
		code: "FAKE_SCRIPT_EXHAUSTED",
	});
});

test("stops after a stop finish event", async () => {
	const model = fakeModel([
		[
			{
				kind: "event",
				event: {
					type: "text-delta",
					delta: "hello",
				},
			},
			{
				kind: "event",
				event: {
					type: "finish",
					reason: "stop",
				},
			},
			{
				kind: "event",
				event: {
					type: "text-delta",
					delta: "ignored",
				},
			},
		],
	]);

	const events = await collect(
		model.stream(
			{
				messages: [{ role: "user", content: "hello" }],
				tools: [],
			},
			{ signal: new AbortController().signal },
		),
	);

	expect(events).toEqual([
		{ type: "text-delta", delta: "hello" },
		{ type: "finish", reason: "stop" },
	]);
});

test("stops after a provider error event", async () => {
	const error = new Error("provider down");
	const model = fakeModel([
		[
			{
				kind: "event",
				event: { type: "error", error },
			},
			{
				kind: "event",
				event: { type: "text-delta", delta: "ignored" },
			},
		],
	]);

	const events = await collect(
		model.stream(
			{
				messages: [{ role: "user", content: "hello" }],
				tools: [],
			},
			{ signal: new AbortController().signal },
		),
	);

	expect(events).toEqual([{ type: "error", error }]);
});

test("tool-call finish is terminal", async () => {
	const model = fakeModel([
		[
			{
				kind: "event",
				event: {
					type: "tool-call",
					id: "call-1",
					name: "weather",
					arguments: '{"city":"Guwahati"}',
				},
			},
			{
				kind: "event",
				event: {
					type: "finish",
					reason: "tool-calls",
				},
			},
			{
				kind: "event",
				event: { type: "text-delta", delta: "ignored" },
			},
		],
	]);

	const events = await collect(
		model.stream(
			{
				messages: [{ role: "user", content: "weather?" }],
				tools: [],
			},
			{ signal: new AbortController().signal },
		),
	);

	expect(events).toHaveLength(2);
	expect(events[1]).toEqual({
		type: "finish",
		reason: "tool-calls",
	});
});
