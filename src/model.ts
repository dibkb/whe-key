export type ModelMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	toolCallId?: string;
};

export type ModelToolDefinition = {
	name: string;
	description: string;
	inputSchema: Readonly<Record<string, unknown>>;
};

export type ModelRequest = {
	messages: readonly ModelMessage[];
	tools: readonly ModelToolDefinition[];
};
export type ModelUsage = {
	input: number;
	output: number;
	total: number;
};

export type ModelEvent =
	| { type: "text-delta"; delta: string }
	| { type: "tool-call"; id: string; name: string; arguments: string }
	| { type: "finish"; reason: "stop" | "tool-calls"; usage?: ModelUsage }
	| { type: "error"; error: Error };

export type LanguageModel = {
	provider: string;
	modelId: string;
	stream(
		request: ModelRequest,
		context: { signal: AbortSignal },
	): AsyncIterable<ModelEvent>;
};
export type FakeLanguageModel = LanguageModel & {
	readonly requests: readonly ModelRequest[];
};

export type FakeScriptStep =
	| {
			kind: "event";
			event: ModelEvent;
	  }
	| {
			kind: "wait";
			gate: Promise<void>;
	  };

export type FakeScript = readonly FakeScriptStep[];

export function fakeModel(scripts: readonly FakeScript[]): FakeLanguageModel {
	let currIndex = 0;
	const requests: ModelRequest[] = [];

	return {
		provider: "fake",
		modelId: "fake",
		stream(request: ModelRequest, _context: { signal: AbortSignal }) {
			const script = scripts[currIndex];

			if (script === undefined) {
				throw Object.assign(new Error("Fake script exhausted"), {
					code: "FAKE_SCRIPT_EXHAUSTED" as const,
				});
			}

			currIndex += 1;
			requests.push(request);

			return (async function* () {
				for (const step of script) {
					if (step.kind === "event") {
						yield step.event;
					} else {
						await step.gate;
					}
				}
			})();
		},
		get requests() {
			return requests.slice();
		},
	};
}
