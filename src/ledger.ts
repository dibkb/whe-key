export type UnsequencedRunEvent = {
	readonly type: string;
	readonly payload: unknown;
};

export type RunEvent = UnsequencedRunEvent & {
	readonly sequence: number;
};

export type RunTrace = {
	readonly events: readonly RunEvent[];
};

type Subscriber = {
	queue: RunEvent[];
	waiting?: (result: IteratorResult<RunEvent>) => void;
	done: boolean;
};

export type EventLedger = {
	append(event: UnsequencedRunEvent): RunEvent;
	events(fromSequence?: number): AsyncIterable<RunEvent>;
	snapshot(): RunTrace;
	close(): void;
};

export function createEventLedger(): EventLedger {
	let isClosed = false;
	const subscribers = new Set<Subscriber>();
	const runEvents: RunEvent[] = [];

	function append(event: UnsequencedRunEvent): RunEvent {
		if (isClosed) {
			throw Object.assign(new Error("Ledger is closed"), {
				code: "LEDGER_CLOSED" as const,
			});
		}

		const runEvent: RunEvent = {
			sequence: runEvents.length + 1,
			...structuredClone(event),
		};
		runEvents.push(runEvent);

		for (const subscriber of subscribers) {
			if (subscriber.done) {
				continue;
			}

			const value = structuredClone(runEvent);
			if (subscriber.waiting !== undefined) {
				const resolve = subscriber.waiting;
				subscriber.waiting = undefined;
				resolve({ done: false, value });
			} else {
				subscriber.queue.push(value);
			}
		}

		return structuredClone(runEvent);
	}

	async function* eventGenerator(
		fromSequence?: number,
	): AsyncIterable<RunEvent> {
		const startIndex = Math.max(0, (fromSequence ?? 1) - 1);
		const subscriber: Subscriber = {
			queue: [],
			done: isClosed,
		};
		subscribers.add(subscriber);

		try {
			for (let index = startIndex; index < runEvents.length; index += 1) {
				const event = runEvents[index];
				if (event !== undefined) {
					yield structuredClone(event);
				}
			}

			while (!subscriber.done) {
				if (subscriber.queue.length > 0) {
					const queued = subscriber.queue.shift();
					if (queued !== undefined) {
						yield queued;
					}
					continue;
				}

				const result = await new Promise<IteratorResult<RunEvent>>(
					(resolve) => {
						subscriber.waiting = resolve;
					},
				);

				if (result.done) {
					return;
				}

				yield result.value;
			}
		} finally {
			subscriber.done = true;
			subscribers.delete(subscriber);
		}
	}
	function snapshot(): RunTrace {
		return Object.freeze({ events: structuredClone(runEvents) });
	}
	function close() {
		if (isClosed) return;
		isClosed = true;
		for (const subscriber of subscribers) {
			subscriber.done = true;

			if (subscriber.queue.length === 0 && subscriber.waiting !== undefined) {
				subscriber.waiting({
					done: true,
					value: undefined,
				});

				subscriber.waiting = undefined;
			}
		}

		subscribers.clear();
	}
	return {
		append,
		events: eventGenerator,
		snapshot,
		close,
	};
}
