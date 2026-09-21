# Go Build Quest — Hog, tiny and allocation-aware

This is the Go track for the same Hog v0 requirements as the TypeScript and Python quests. It is an independent implementation: choose one language, or run the same scenario fixtures across all three.

> **Mission:** build a small provider-neutral agent loop with one Groq adapter, validated tools and final output, cooperative pause/play/abort, streaming events, and a complete per-run trace including model input and output token usage.

This is a problem set, not an implementation. The snippets define public contracts and leave the bodies to you.

## Game rules

- Use a supported stable Go toolchain; Go 1.22 or newer is sufficient for the proposed contracts.
- Tests use the standard `testing`, `httptest`, and fuzzing facilities.
- The core uses the standard library only.
- The recommended Zod-like adapter uses `github.com/Oudwins/zog`; pin its minor version because it is pre-1.0.
- The Groq adapter uses `net/http` directly. Groq does not currently publish an official Go SDK, and v0 needs only one streaming endpoint.
- `context.Context` enters each run and tool call; never store it in immutable agent configuration.
- Default tests make zero network calls and spend zero tokens.
- Use a deterministic fake provider until Level 6.
- Write the tests for a level before its implementation.
- Do not add a package until a measured or correctness requirement cannot be met with the standard library.

## Dependency budget

### Allowed in v0

| Purpose | Choice | Why |
|---|---|---|
| Runtime, JSON, HTTP, SSE, concurrency, tests, profiling | Go standard library | Already sufficient and keeps the hot path visible. |
| Zod-like runtime parsing and validation | `github.com/Oudwins/zog` behind one adapter | Chainable schemas, rich issues, no transitive dependencies. |

### Deliberately absent

- No agent framework.
- No dependency-injection container.
- No event bus.
- No alternate JSON codec.
- No worker pool or goroutine-per-tool design.
- No unofficial Groq SDK.
- No OpenTelemetry SDK in core; export trace events through a later adapter.
- No second validation or JSON Schema generation package in v0.

Zog validates and parses values and now exposes an experimental ZSS-to-JSON-Schema path. That path and its representability rules are not yet a stable core contract. Keep provider-facing JSON Schema explicit in the v0 adapter; the `Schema[T]` boundary makes a future generator replaceable.

## XP map

| Level | Name | XP | Unlock |
|---:|---|---:|---|
| 0 | Forge the Go contracts | 80 | Immutable agents and schemas |
| 1 | Build the fake provider | 100 | Deterministic normalized streams |
| 2 | Validate and execute tools | 140 | Safe heterogeneous tools |
| 3 | Run the bounded agent loop | 180 | Model → tool → model execution |
| 4 | Build the event ledger | 140 | Live events, trace, and token usage |
| 5 | Control and clean up runs | 160 | Pause, play, resume, abort, limits |
| 6 | Add Groq and defeat the performance boss | 200 | Complete Hog Go v0 |
| **Total** | | **1,000 XP** | **Hog Go finisher** |

## Victory condition

A caller can prepare a run, optionally pause it before work starts, play it, observe typed events without blocking execution, let it call validated tools, receive a validated typed result, and inspect a complete ordered trace with per-attempt and aggregate token usage.

```go
type Answer struct {
	Answer   string `json:"answer"`
	UsedTool bool   `json:"used_tool"`
}

agent, err := hog.NewAgent(hog.AgentConfig[Answer]{
	Name:         "weather-agent",
	Provider:     fake,
	Instructions: "Use the weather tool when live weather is necessary.",
	Tools:        []hog.Tool{weatherTool},
	Output:       answerSchema,
	MaxSteps:     6,
})

run, err := agent.Prepare("Should I carry an umbrella?")
cursor := run.Events()

run.Pause()
run.Play(context.Background())
run.Resume()

for {
	event, ok, err := cursor.Next(context.Background())
	if err != nil || !ok {
		break
	}
	fmt.Println(event.Seq, event.Kind)
}

result, err := run.Wait(context.Background())
```

The two-phase `Prepare` → `Play` contract is intentional. It makes “pause before the first model request” deterministic instead of relying on goroutine scheduling.

## Shared vocabulary

- **Agent:** immutable validated configuration.
- **Run:** one invocation of one agent.
- **Step:** one model request and the tool calls it produces.
- **Attempt:** one visible provider request; retries are separate attempts.
- **Tool call:** a model-proposed name, call ID, and JSON arguments.
- **Observation:** validated tool output returned to the model.
- **Ledger:** ordered append-only event storage for one run.
- **Cursor:** a non-destructive reader over live or completed ledger events.
- **Trace:** read-only access to the completed ledger and summary.
- **Pause:** a reversible cooperative gate checked at safe boundaries.
- **Abort:** irreversible cancellation of run-owned work.

## Minimal package layout

```text
hog/
  agent.go
  errors.go
  schema.go
  event.go
  usage.go
  provider.go
  tool.go
  runner.go
  run.go
  ledger.go
  gate.go
  internal/testprovider/fake.go
  schema/zogadapter/zog.go
  provider/groq/groq.go
  provider/groq/sse.go
```

Every package must justify its existence. Start flatter than this and split only when imports or ownership become unclear.

## Public contract sketches

### Schema seam

```go
type Issue struct {
	Path    []string
	Code    string
	Message string
}

type Schema[T any] interface {
	DecodeJSON(raw []byte) (T, []Issue)
	EncodeJSON(value T) ([]byte, error)
	JSONSchema() json.RawMessage
}

func NewZogSchema[T any](
	parse func([]byte) (T, []Issue),
	encode func(T) ([]byte, error),
	providerJSONSchema json.RawMessage,
) Schema[T]
```

Goal: keep Zog-specific types in one adapter. Tool arguments, tool results, and final output all cross the same generic contract. The provider JSON Schema is explicit v0 data, not generated through an experimental API.

### Provider seam

```go
type Provider interface {
	Stream(ctx context.Context, request ModelRequest) (ModelStream, error)
}

type ModelStream interface {
	Next(ctx context.Context) (ModelEvent, bool, error)
	Close() error
}

type ModelEvent struct {
	Kind       ModelEventKind
	Text       string
	ToolCallID string
	ToolName   string
	Arguments  []byte
	Usage      Usage
	RequestID  string
}
```

Goal: the runner never imports Groq types. The adapter normalizes provider chunks into a tiny vocabulary and closes network resources on every path.

### Tool seam

```go
type Tool interface {
	Name() string
	Description() string
	InputJSONSchema() json.RawMessage
}

type ToolSpec[I, O any] struct {
	Name        string
	Description string
	Input       Schema[I]
	Output      Schema[O]
	Execute     func(context.Context, I) (O, error)
}

func NewTool[I, O any](spec ToolSpec[I, O]) (Tool, error)
```

Goal: use generics at construction so authors get typed input/output, then erase the type once at the heterogeneous registry boundary. The runner invokes only the internal validated executable form.

### Run, result, and trace seams

```go
type RunStatus uint8

const (
	RunCreated RunStatus = iota
	RunRunning
	RunPaused
	RunCompleted
	RunFailed
	RunAborted
)

type Run[Out any] interface {
	Play(ctx context.Context) error
	Pause() bool
	Resume() bool
	Abort(cause error) bool
	Status() RunStatus
	Events() Cursor
	Wait(ctx context.Context) (Result[Out], error)
}

type Cursor interface {
	Next(ctx context.Context) (event Event, ok bool, err error)
}

type Trace interface {
	Len() int
	At(index int) (Event, bool)
	Usage() Usage
}

type Result[Out any] struct {
	Status RunStatus
	Output Out
	Err    error
	Trace  Trace
}
```

`Wait`’s returned `error` describes the wait operation, such as its caller context expiring. A run failure lives in `Result.Err` so the result can still carry its trace and usage.

## Architecture and flows

```text
caller
  │ Prepare(input)
  ▼
Run handle ── controls ──► pause gate / cancel cause
  │ Play(ctx)
  ▼
single runner goroutine
  ├──► Provider.Stream ──► normalized ModelEvent
  ├──► Tool registry ────► validate → execute → validate
  ├──► Output schema ────► typed final value
  └──► Ledger ───────────► live cursors + completed Trace + Usage
```

### Flow A — Construct an agent

1. Validate the name, limits, provider, tool names, and output schema.
2. Build an immutable tool registry.
3. Copy mutable caller-owned bytes such as `json.RawMessage`.
4. Return an agent safe for concurrent `Prepare` calls.

**Goal:** reject configuration bugs before any run or goroutine exists.

### Flow B — Prepare and play a run

1. `Prepare` validates the input size and creates state without starting work.
2. The caller may attach a cursor or call `Pause`.
3. `Play` starts exactly one runner goroutine and returns immediately.
4. A second `Play` returns a stable state error.

**Goal:** deterministic startup and no hidden goroutine fan-out.

### Flow C — Execute a model step

1. Check cancellation and pause gates.
2. Append `model.started` with step and attempt identifiers.
3. Open the provider stream.
4. Normalize text, tool-call fragments, provider IDs, and usage.
5. Close the stream exactly once.
6. Append either `model.completed` or `model.failed`.

**Goal:** every billable provider attempt is visible in order.

### Flow D — Execute a tool

1. Reassemble arguments with a byte limit.
2. Resolve the tool name; reject unknown tools.
3. Decode and validate arguments.
4. Check the gate, then execute sequentially with the run context.
5. Encode and validate the return value.
6. Append safe input/output or validation/failure events.
7. Send the observation to the next model step.

**Goal:** the model proposes; trusted Go code validates and executes.

### Flow E — Finish structured output

1. Reassemble the final JSON bytes with a limit.
2. Decode using `Schema[Out]`.
3. If invalid, append issues and allow at most one explicit repair attempt.
4. Validate again and return the typed value or a terminal result error.

**Goal:** never report unvalidated model bytes as typed output.

### Flow F — Trace and token accounting

1. Append each event once with a run-local monotonic sequence.
2. Record provider-reported input, output, and total tokens for every attempt.
3. Aggregate usage by attempt ID exactly once.
4. Preserve “unavailable” rather than silently estimating missing counts.
5. Finalize the trace only after the terminal event is appended.

**Goal:** a completed run explains what happened and what was billed.

### Flow G — Pause, resume, and abort

1. Control methods update state under one small lock.
2. The runner checks the gate before a provider request, tool execution, event emission, and finalization.
3. `Resume` wakes all gate waiters.
4. `Abort` cancels run-owned context and wakes paused work.
5. Active HTTP may already have consumed tokens before cancellation reaches Groq; record that honestly.

**Goal:** cooperative control with explicit limits, not fake process suspension.

## Memory and speed laws

1. **One runner goroutine per active run.** Do not spawn per event or per subscriber.
2. **Readers never backpressure execution.** A cursor reads the ledger; the runner does not send into a caller-owned channel.
3. **No `map[string]any` in the hot path.** Use compact structs and `json.RawMessage` only at dynamic boundaries.
4. **Copy caller/provider byte slices at ownership boundaries.** Never retain mutable borrowed buffers.
5. **Bound everything:** steps, attempts, tool calls, argument bytes, output bytes, events, trace bytes, error-body bytes, and repair attempts.
6. **Do not duplicate the trace in `Result`.** Return a read-only view over the ledger.
7. **Do not retain raw provider chunks** after normalized events are recorded.
8. **Preallocate only from known safe bounds.** Never trust a provider length as allocation authority.
9. **Disable hidden retries.** A future retry policy must append a new attempt event and usage.
10. **Measure before replacing stdlib.** `encoding/json` and `net/http` stay until profiles prove otherwise.

### Complete trace is a bounded promise

The default in-memory trace is complete only within configured limits. On overflow, terminate with `trace_limit` while preserving every event already accepted plus the terminal failure event. Do not silently drop events and still call the trace complete.

Suggested playground defaults—not universal production settings:

| Limit | Initial value |
|---|---:|
| Steps | 8 |
| Provider attempts | 10 |
| Tool calls | 16 |
| Tool argument bytes per call | 64 KiB |
| Final output bytes | 256 KiB |
| Events | 10,000 |
| Retained trace bytes | 4 MiB |
| Output repair attempts | 1 |

## Level 0 — Forge the Go contracts · 80 XP

### Problem statement

Define immutable agent configuration, schemas, normalized provider contracts, stable error codes, and the two-phase run API without executing anything.

### Starter snippet

```go
type AgentConfig[Out any] struct {
	Name         string
	Instructions string
	Provider     Provider
	Tools        []Tool
	Output       Schema[Out]
	Limits       Limits
}

func NewAgent[Out any](config AgentConfig[Out]) (*Agent[Out], error)
func (a *Agent[Out]) Prepare(input string) (Run[Out], error)
```

### Requirements

- Stable machine-readable error codes.
- Duplicate and empty tool names fail construction.
- Non-positive limits fail construction.
- Agent configuration cannot be mutated through caller-owned slices or bytes.
- Agent instances support concurrent run preparation.
- No goroutine starts during construction or preparation.

### Test cases

1. Valid configuration returns an agent.
2. Duplicate tool names return `invalid_config`.
3. Nil provider or output schema returns `invalid_config`.
4. Mutation of the original tool slice does not mutate the agent.
5. `Prepare` produces distinct run IDs and `created` state.
6. `Prepare` over the input-byte limit fails without starting work.

### Passing criteria

- [ ] Public contracts compile in a tiny external-package example.
- [ ] Invalid configurations have stable codes and useful causes.
- [ ] `go test ./...` passes with zero network access.
- [ ] `go vet ./...` passes.

### Level boss

Prepare 1,000 runs concurrently from one agent. Every run ID is unique; all remain `created`; the race detector reports nothing.

## Level 1 — Build the deterministic fake provider · 100 XP

### Problem statement

Create a scripted provider that emits normalized events, failures, and usage without HTTP, time sleeps, randomness, or tokens.

### Starter snippet

```go
type Script struct {
	Events []ModelEvent
	OpenErr error
	NextErrAt int
}

func NewFakeProvider(scripts ...Script) Provider
```

### Requirements

- One script is consumed per provider attempt.
- Support text fragments, interleaved tool-call fragments, finish events, usage, and injected errors.
- `Close` is observable and idempotent for cleanup tests.
- Exhausted scripts fail deterministically.
- No sleeps; tests coordinate through hooks or channels they control.

### Test cases

1. Events appear in exact scripted order.
2. Two tool calls remain isolated when argument fragments interleave.
3. Open failure and mid-stream failure are distinguishable.
4. Usage and request ID survive normalization.
5. Cancellation stops `Next` and the stream is closed.
6. Reusing one fake across concurrent runs consumes scripts safely.

### Passing criteria

- [ ] Fixtures are deterministic under `go test -count=100`.
- [ ] Every opened stream is closed once.
- [ ] `go test -race ./...` passes.
- [ ] No wall-clock sleep is needed in unit tests.

### Level boss

Replay a fixture containing text plus two interleaved tool calls 1,000 times. Each replay yields byte-identical normalized events.

## Level 2 — Validate and execute tools · 140 XP

### Problem statement

Build a heterogeneous registry that preserves typed authoring, validates both sides of each tool call, and returns safe observations.

### Starter snippet

```go
func NewTool[I, O any](spec ToolSpec[I, O]) (Tool, error)

type ToolFailure struct {
	Code       string
	Tool       string
	CallID     string
	Retryable  bool
	Issues     []Issue
	Cause      error
}
```

### Requirements

- Strict JSON parsing: trailing values and type mismatches fail.
- Runtime validation occurs before execution and after execution.
- Unknown tools never execute.
- Tools receive the run context.
- Tool panics are recovered only at this trust boundary and become failures.
- Logged validation errors exclude secrets and unbounded raw payloads.
- Execution is sequential in v0.

### Test cases

1. Valid arguments call the tool once and validate its output.
2. Malformed JSON, trailing JSON, and schema failure call it zero times.
3. Unknown tool returns `tool_not_found`.
4. Invalid tool return becomes `tool_output_invalid`.
5. Cancellation reaches a blocking tool.
6. Panic becomes `tool_panicked` and the run retains a trace.
7. Oversized arguments fail before decode.

### Passing criteria

- [ ] Typed tool code contains no type assertions.
- [ ] Type erasure exists only inside the registry wrapper.
- [ ] Every outcome has start and terminal ledger-ready data.
- [ ] Validation fixtures cover accepted and rejected values for both the runtime schema and provider JSON Schema.

### Level boss

Register tools with unrelated input/output types and execute them through `[]Tool`; no reflection or `map[string]any` leaks into the runner API.

## Level 3 — Run the bounded agent loop · 180 XP

### Problem statement

Implement one single-owner loop that consumes normalized model events, assembles tool calls, executes tools, appends observations, and stops on typed output or a hard limit.

### Starter snippet

```go
type runner[Out any] struct {
	// state ownership is your task
}

func (r *runner[Out]) execute(ctx context.Context) Result[Out]
```

### Requirements

- One goroutine owns mutable conversation and step state.
- Tool calls are keyed by provider call ID, not arrival order.
- The loop checks cancellation and limits before every new side effect.
- No-tool, one-tool, and multiple sequential-tool paths work.
- Tool observations are provider-neutral messages.
- Every opened provider stream is closed on success, failure, limit, and cancellation.
- No recursion for steps; use an explicit loop.

### Test cases

1. Text-only output completes in one step.
2. Tool request → valid observation → final output completes in two steps.
3. Two tool calls execute in declared order.
4. A fragmented call reconstructs exact JSON bytes.
5. Duplicate call IDs fail deterministically.
6. `max_steps`, `max_tool_calls`, and byte limits terminate before extra work.
7. Provider and tool failures preserve prior events.

### Passing criteria

- [ ] Runner imports no Groq or Zog package.
- [ ] Conversation state has one writer.
- [ ] Limits are tested at boundary −1, boundary, and boundary +1.
- [ ] No stream or response body remains open.

### Level boss

Execute the same multi-step scenario under 100 concurrent runs. All outputs and traces are isolated and race-free.

## Level 4 — Build the event ledger · 140 XP

### Problem statement

Use one append-only ledger for live cursors, completed trace, lifecycle audit, and exact per-attempt token aggregation without letting slow readers block the run.

### Starter snippet

```go
type Event struct {
	Seq        uint64
	AtUnixNano int64
	Kind       EventKind
	Step       uint32
	Attempt    uint16
	CallID     string
	Payload    json.RawMessage
}

type Usage struct {
	InputTokens  uint64
	OutputTokens uint64
	TotalTokens  uint64
	Known        bool
}
```

### Required event families

- `run.created`, `run.started`, `run.paused`, `run.resumed`.
- `model.started`, text/tool fragments as configured, `model.usage`, `model.completed`, `model.failed`.
- `tool.started`, `tool.completed`, `tool.failed`.
- `output.validated`, `output.invalid`.
- `run.completed`, `run.failed`, `run.aborted`.

### Token accounting contract

- Store provider-reported input, output, and total tokens per attempt.
- Include zero as a known valid count.
- Use `Known=false` when the provider omits usage.
- Aggregate an attempt exactly once, even if final metadata repeats usage.
- Trace every retry as another attempt; v0 performs no automatic retry.
- Expose per-attempt usage events and aggregate usage on `Trace`.

### Test cases

1. Sequences start at one and remain gap-free under control calls.
2. A cursor created before play sees live events; one created after completion replays all events.
3. A slow or abandoned cursor does not block completion.
4. Mutating source payload bytes cannot mutate recorded events.
5. Repeated usage metadata does not double-count.
6. Unknown usage stays unknown; it is never displayed as zero.
7. Trace overflow produces a truthful terminal `trace_limit` result.

### Passing criteria

- [ ] Result points to a read-only trace view rather than a second event copy.
- [ ] Cursor wait is cancellation-aware.
- [ ] Appends have one small critical section.
- [ ] Usage totals equal the sum of unique known attempts.
- [ ] Heap growth stops after completed runs and cursors become unreachable.

### Level boss

One run has a fast cursor, a cursor delayed until completion, and an abandoned cursor. The run completes once; both active readers see the same sequence; the abandoned reader consumes no goroutine.

## Level 5 — Control and clean up runs · 160 XP

### Problem statement

Add deterministic play, cooperative pause/resume, abort with cause, context cancellation, and terminal-state cleanup without deadlocks or goroutine leaks.

### Starter snippet

```go
type Gate interface {
	Pause() bool
	Resume() bool
	Wait(ctx context.Context) error
}

type Controller interface {
	Play(ctx context.Context) error
	Pause() bool
	Resume() bool
	Abort(cause error) bool
}
```

### Semantics

- A prepared run starts in `created` and performs no work.
- `Pause` before `Play` is deterministic.
- `Play` starts once; a second call fails without another goroutine.
- Pause is cooperative: no new provider call, tool call, event emission, or finalization passes the next gate.
- An in-flight HTTP request may finish or consume tokens until cancellation is observed.
- `Abort` is terminal, cancels the run context, wakes paused work, and preserves the trace.
- Repeated pause/resume/abort calls are idempotent and report whether state changed.
- A timeout passed to `Wait` cancels only that wait, not the run.

### Test cases

1. Pause before play prevents the first provider request.
2. Resume permits exactly one continuation.
3. Pause between model and tool prevents tool execution.
4. Abort while paused terminates promptly.
5. Abort during provider or tool work propagates context cancellation.
6. Parent run context cancellation aborts owned work.
7. Wait timeout leaves the run active.
8. Terminal controls do not change result or append duplicate terminal events.
9. A 10,000-iteration concurrent control stress test passes under `-race`.

### Passing criteria

- [ ] State transitions are documented and centrally enforced.
- [ ] No send/close race exists on notification channels.
- [ ] Paused and completed runs leave no waiter goroutine behind.
- [ ] Every terminal path closes network and stream resources.
- [ ] `go test -race ./...` passes.

### Level boss

Fuzz legal and illegal control sequences while a scripted provider crosses every safe point. No deadlock, panic, duplicate terminal event, or post-terminal side effect occurs.

## Level 6 — Add Groq and defeat the performance boss · 200 XP

### Problem statement

Add a thin Groq streaming adapter over `net/http`, validate final output with the same schema seam, allow one visible repair attempt, and prove speed and memory behavior with benchmarks.

### Groq adapter contract

```go
type GroqConfig struct {
	APIKey  string
	BaseURL string
	Client  *http.Client
}

func NewGroqProvider(config GroqConfig) (Provider, error)
```

### Requirements

- Only the adapter knows Groq request/response JSON.
- Use the injected client and respect request context.
- Stream from `/openai/v1/chat/completions` and parse SSE incrementally.
- Bound status-error bodies and SSE frame sizes.
- Handle JSON split across reads and multiple frames in one read.
- Do not use `bufio.Scanner` with its default token limit unless you set and test an explicit maximum.
- Close response bodies on every status and parse path.
- Normalize tool-call fragments, request IDs, finish reasons, errors, and usage.
- Disable hidden retries; any future retry is a traced attempt.
- Do not assume Groq strict `json_schema`, streaming, and tool use can be enabled together. The v0 path streams tool use and validates final output locally; re-check provider capabilities before adding another mode.
- Use `httptest.Server` for all default tests.
- A live Groq smoke test is opt-in through an environment variable and is never a default gate.

### Structured-output cases

1. Valid output decodes once and completes.
2. Invalid output appends safe issues and starts one repair attempt.
3. Valid repaired output completes with both attempts and usage visible.
4. A second invalid output fails with `output_invalid`.
5. Extra/trailing JSON fails under the documented strict policy.
6. Oversized output terminates before an unbounded allocation.

### Groq fixture cases

1. Text-only SSE stream.
2. Fragmented tool name and arguments.
3. Interleaved tool calls.
4. Usage in terminal metadata.
5. Missing usage.
6. Non-2xx response with an oversized body.
7. Malformed SSE/JSON.
8. Cancellation during a stalled response.

### Passing criteria

- [ ] Fake and Groq providers pass the same provider contract suite.
- [ ] Final output is returned only after local schema validation.
- [ ] Every provider attempt and reported token count appears in trace.
- [ ] No default test uses the network or API credits.
- [ ] `go test`, `go vet`, and `go test -race` pass.
- [ ] Benchmark and memory reports are checked in with machine/toolchain metadata.

### Level boss

Run the final scenario through both the fake provider and a local `httptest` Groq fixture. Apart from provider metadata and time, the semantic event sequence, tool behavior, typed result, and usage aggregation match.

## Performance lab — mandatory

“Fast” is a measurement, not a design adjective. Provider latency hides framework overhead, so benchmark with deterministic in-memory fixtures.

### Workloads

1. Bare fake-provider consumer versus Hog: 10 text deltas, no tools.
2. One complete tool round trip with strict input/output validation.
3. One invalid final output plus one repair attempt.
4. Append and replay 10,000 compact events.
5. Create 1,000 paused empty runs, then abort and release them.
6. Parse representative Groq SSE from `httptest.Server`.

### Commands

```sh
go test ./...
go vet ./...
go test -race ./...
go test -run '^$' -bench . -benchmem ./...
go test -run '^$' -bench BenchmarkRun -memprofile mem.out ./...
go tool pprof -top mem.out
```

### Metrics to report

- `ns/op`, `B/op`, and `allocs/op` for ledger append/read, fake run, tool round trip, and SSE parsing.
- p50 and p95 added Hog duration versus the bare fixture consumer.
- Retained bytes per event and per paused run.
- Goroutine count before and after the cleanup workload, treated as diagnostic evidence rather than a brittle unit assertion.
- Heap profile top allocators.

### Provisional local targets

These are starting constraints to calibrate on the chosen CI machine, not universal Go claims.

- Cursor replay of already-recorded events: zero heap allocations per event.
- Ledger append: at most one payload-copy allocation per event after capacity is prepared.
- 100-event no-tool fake run: under 1 ms p95 framework time on the reference machine.
- Retained trace storage: at most 512 bytes of overhead per compact event, excluding owned payload bytes.
- 1,000 paused empty runs: bounded memory and no remaining run-owned goroutines after abort, wait, and GC.
- Once a stable baseline is checked in, fail a benchmark gate on more than 15% regression only after repeated samples confirm it.

Do not run race detection and performance benchmarks in the same sample; the race detector intentionally adds substantial overhead.

## Final boss — the complete Go scenario

1. Caller prepares a run and creates a cursor.
2. Caller pauses, plays, confirms no provider attempt started, then resumes.
3. Model proposes `search_docs({"query":"Hog"})` in fragmented chunks.
4. Hog validates input, executes once, validates output, and appends an observation.
5. Model returns invalid structured output and provider-reported usage.
6. Hog records validation issues and starts one visible repair attempt.
7. Model returns valid output and usage.
8. Hog returns a typed result and complete trace.

### Expected observable result

```text
status: completed
output: validated typed Go value
tool calls: 1
provider attempts: 3
usage.input_tokens: sum of unique known attempts
usage.output_tokens: sum of unique known attempts
usage.total_tokens: sum of unique known attempts
trace: gap-free from run.created through run.completed
```

### Boss passing criteria

- [ ] Pause before first work is deterministic.
- [ ] Tool input and output cross schemas.
- [ ] Invalid final output never escapes as typed output.
- [ ] Repair is bounded to one attempt.
- [ ] Each model attempt exposes input/output/total token usage or explicit unknown usage.
- [ ] Live cursor order equals completed trace order.
- [ ] Slow or abandoned cursors do not block completion.
- [ ] No hidden retry, network call, goroutine, or unbounded buffer exists.
- [ ] Limits fail truthfully with prior trace preserved.
- [ ] Fake and local Groq fixtures pass without credits.

## Deliverables after every level

- Production files for only that level.
- Unit tests and fixtures.
- A short README note recording semantics and rejected complexity.
- Benchmark delta when the hot path changes.
- `go test`, `go vet`, and `go test -race` output.
- No unrelated dependency or abstraction.

## Definition of done — Go v0

- [ ] A consumer imports Hog from another package.
- [ ] Core is provider-neutral; only one adapter knows Groq.
- [ ] Tool arguments, tool returns, and final output are locally validated.
- [ ] Play, pause, resume, abort, and cancellation semantics are deterministic and tested.
- [ ] Complete bounded trace includes every model attempt and per-attempt token usage.
- [ ] Aggregate input/output/total tokens are correct and missing usage stays explicit.
- [ ] Fake-provider tests spend zero credits.
- [ ] Groq adapter tests use local HTTP fixtures.
- [ ] Race, fuzz, cleanup, limit, benchmark, and memory gates pass.
- [ ] Core uses stdlib; the only recommended v0 third-party dependency is the Zog adapter.

## Reward badges

- **Stdlib Hog:** no third-party package in core.
- **Schema Tamer:** tool input, return, and final output reject adversarial fixtures.
- **Race-Free Wrangler:** stress tests pass under `go test -race`.
- **Token Accountant:** every attempt and aggregate token count reconcile.
- **Heap Miser:** performance lab meets calibrated allocation and retention gates.
- **Groq Gatekeeper:** fake and HTTP fixture contract suites agree.
- **Hog Go Finisher:** all 1,000 XP and the final boss pass.

## Further reading and future expansion — not v0 work

### Primary implementation references

- [Go `context`](https://pkg.go.dev/context)
- [Go memory model](https://go.dev/ref/mem)
- [Go race detector](https://go.dev/doc/articles/race_detector)
- [Go fuzzing](https://go.dev/doc/security/fuzz/)
- [Go diagnostics and pprof](https://go.dev/doc/diagnostics)
- [Go `net/http`](https://pkg.go.dev/net/http)
- [Go `encoding/json`](https://pkg.go.dev/encoding/json)
- [Zog documentation](https://zog.dev/)
- [Zog schema specification and JSON Schema status](https://zog.dev/experimental/zss/)
- [Groq API reference](https://console.groq.com/docs/api-reference)
- [Groq OpenAI compatibility](https://console.groq.com/docs/overview)

### Papers shared with the other tracks

- [ReAct](https://arxiv.org/abs/2210.03629): interleaving model actions and external observations; not a requirement to expose private reasoning.
- [Toolformer](https://arxiv.org/abs/2302.04761): model tool selection and arguments; Hog implements the deterministic host boundary.

### Add only after a measured need

- JSON Schema generation: add a generator adapter only when manual schema drift becomes a demonstrated problem.
- File-backed JSONL trace: use when 4 MiB is too small; it is not durable execution.
- OpenTelemetry export: translate stable Hog events at the edge.
- Parallel tool calls: first define ordering, cancellation, partial failure, and resource limits.
- Second provider: prove portability without changing runner or tool contracts.
- Durable suspend/replay: design checkpoints and tool idempotency; never serialize live goroutines, contexts, or HTTP clients.
- Alternate JSON codec or HTTP transport: require profiles and the unchanged contract suite.

Hog Go stays fast by owning little: one runner, one ledger, one schema seam, one provider seam, explicit limits, and measurements that punish accidental complexity.
