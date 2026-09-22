import { expect, test } from "bun:test";

import {
	createEventLedger,
	type RunEvent,
	type UnsequencedRunEvent,
} from "./ledger.ts";

function event(type: string, payload: unknown = {}): UnsequencedRunEvent {
	return { type, payload };
}

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
	const events: RunEvent[] = [];

	for await (const value of stream) {
		events.push(value);
	}

	return events;
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index += 1) {
		await Promise.resolve();
	}
}

test("replays all events to a late subscriber in sequence order", async () => {
	const ledger = createEventLedger();

	ledger.append(event("A"));
	ledger.append(event("B"));
	ledger.append(event("C"));
	ledger.close();

	await expect(collect(ledger.events())).resolves.toEqual([
		{ sequence: 1, type: "A", payload: {} },
		{ sequence: 2, type: "B", payload: {} },
		{ sequence: 3, type: "C", payload: {} },
	]);
});

test("replays from the requested sequence", async () => {
	const ledger = createEventLedger();

	ledger.append(event("A"));
	ledger.append(event("B"));
	ledger.append(event("C"));
	ledger.close();

	await expect(collect(ledger.events(2))).resolves.toEqual([
		{ sequence: 2, type: "B", payload: {} },
		{ sequence: 3, type: "C", payload: {} },
	]);
});

test("a live subscriber receives each appended event exactly once", async () => {
	const ledger = createEventLedger();
	const iterator = ledger.events()[Symbol.asyncIterator]();

	const firstPending = iterator.next();
	const first = ledger.append(event("first", { value: 1 }));
	await expect(firstPending).resolves.toEqual({
		done: false,
		value: first,
	});

	const secondPending = iterator.next();
	const second = ledger.append(event("second", { value: 2 }));
	await expect(secondPending).resolves.toEqual({
		done: false,
		value: second,
	});

	ledger.close();
	await expect(iterator.next()).resolves.toMatchObject({ done: true });
});

test("closing an empty ledger wakes a waiting subscriber", async () => {
	const ledger = createEventLedger();
	const iterator = ledger.events()[Symbol.asyncIterator]();
	const pending = iterator.next();
	let settled = false;
	pending.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);

	await flushMicrotasks();
	expect(settled).toBe(false);

	ledger.close();

	await expect(pending).resolves.toMatchObject({ done: true });
	await expect(iterator.next()).resolves.toMatchObject({ done: true });
});

test("caller and consumer mutations cannot change stored events", async () => {
	const ledger = createEventLedger();
	const input = { nested: { value: "original" } };

	ledger.append(event("payload", input));
	input.nested.value = "caller-mutated";

	const iterator = ledger.events()[Symbol.asyncIterator]();
	const received = (await iterator.next()).value;
	if (received === undefined) {
		throw new Error("Expected a stored event");
	}

	try {
		const payload = received.payload as { nested: { value: string } };
		payload.nested.value = "consumer-mutated";
	} catch {
		// A frozen event projection is also a valid implementation.
	}

	expect(ledger.snapshot()).toEqual({
		events: [
			{
				sequence: 1,
				type: "payload",
				payload: { nested: { value: "original" } },
			},
		],
	});
});

test("a throwing consumer does not corrupt sequence allocation", async () => {
	const ledger = createEventLedger();
	ledger.append(event("first"));

	const failingConsumer = (async () => {
		for await (const _value of ledger.events()) {
			throw new Error("sink failed");
		}
	})();

	await expect(failingConsumer).rejects.toThrow("sink failed");
	expect(ledger.append(event("second")).sequence).toBe(2);
});

test("separate ledgers never share sequence counters", () => {
	const ledgers = Array.from({ length: 10 }, () => createEventLedger());
	const appended = ledgers.map((ledger, index) =>
		ledger.append(event("run", { index })),
	);

	expect(appended.map((value) => value.sequence)).toEqual(Array(10).fill(1));
});
