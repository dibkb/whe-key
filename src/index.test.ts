/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import * as z from "zod";

import { createAgent } from "./index.ts";

const baseOptions = {
	name: "  example-agent  ",
	instructions: "  Follow the request.  ",
};

describe("createAgent", () => {
	test("normalizes a minimal definition and applies bounded defaults", () => {
		const agent = createAgent(baseOptions);

		expect(agent.name).toBe("example-agent");
		expect(agent.instructions).toBe("Follow the request.");
		expect(agent.maxSteps).toBe(6);
		expect(agent.maxToolCalls).toBe(16);
		expect(agent.outputRepairAttempts).toBe(1);
		expect(agent.input.safeParse("hello").success).toBe(true);
		expect(agent.input.safeParse(42).success).toBe(false);
		expect(agent.output.safeParse("done").success).toBe(true);
		expect(Object.isFrozen(agent)).toBe(true);
	});

	test("preserves supplied input and output schemas", () => {
		const input = z.object({ prompt: z.string() });
		const output = z.object({ answer: z.string() });
		const agent = createAgent({ ...baseOptions, input, output });

		expect(agent.input).toBe(input);
		expect(agent.output).toBe(output);
	});

	test("rejects blank text fields", () => {
		expect(() => createAgent({ ...baseOptions, name: "   " })).toThrow(
			z.ZodError,
		);
		expect(() => createAgent({ ...baseOptions, instructions: "   " })).toThrow(
			z.ZodError,
		);
	});

	test("rejects invalid execution limits", () => {
		for (const limits of [
			{ maxSteps: 0 },
			{ maxSteps: 1.5 },
			{ maxToolCalls: 0 },
			{ outputRepairAttempts: -1 },
			{ outputRepairAttempts: 2 },
		]) {
			expect(() => createAgent({ ...baseOptions, ...limits })).toThrow(
				z.ZodError,
			);
		}
	});

	test("allows disabling output repair", () => {
		const agent = createAgent({ ...baseOptions, outputRepairAttempts: 0 });

		expect(agent.outputRepairAttempts).toBe(0);
	});

	test("rejects schema-shaped impostors", () => {
		const impostor = {
			safeParse: () => ({ success: true as const, data: "not-zod" }),
		} as unknown as z.ZodType<string>;

		expect(() => createAgent({ ...baseOptions, input: impostor })).toThrow(
			z.ZodError,
		);
	});

	test("rejects unknown configuration properties", () => {
		const options = { ...baseOptions, unexpected: true };

		expect(() => createAgent(options as never)).toThrow(z.ZodError);
	});
});
