import * as z from "zod";

export type AgentOptions<TInput = string, TOutput = string> = {
	name: string;
	instructions: string;
	input?: z.ZodType<TInput>;
	output?: z.ZodType<TOutput>;
	maxSteps?: number;
	maxToolCalls?: number;
	outputRepairAttempts?: number;
};

export type AgentDefinition<TInput, TOutput> = Readonly<{
	name: string;
	instructions: string;
	input: z.ZodType<TInput>;
	output: z.ZodType<TOutput>;
	maxSteps: number;
	maxToolCalls: number;
	outputRepairAttempts: number;
}>;

const zodType = z.custom<z.ZodType>(
	(value) => value instanceof z.ZodType,
	"must be a ZodType",
);

const agentOptionsSchema = z
	.object({
		name: z.string().trim().min(1),
		instructions: z.string().trim().min(1),
		input: zodType.optional(),
		output: zodType.optional(),
		maxSteps: z.number().int().positive().default(6),
		maxToolCalls: z.number().int().positive().default(16),
		outputRepairAttempts: z.number().int().nonnegative().max(1).default(1),
	})
	.strict();

export function createAgent<TInput = string, TOutput = string>(
	options: AgentOptions<TInput, TOutput>,
): AgentDefinition<TInput, TOutput> {
	const parsed = agentOptionsSchema.parse(options);
	return Object.freeze({
		...parsed,
		input: (parsed.input ?? z.string()) as z.ZodType<TInput>,
		output: (parsed.output ?? z.string()) as z.ZodType<TOutput>,
	});
}
