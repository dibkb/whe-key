# Hog Go track — primary-source research

Checked 2026-09-21. Links below are language/vendor documentation or the owning project's repository; recommendations are explicitly labelled as such.

## Decision summary

- **Recommendation:** keep the core to the Go standard library: `context`, `net/http`, `encoding/json`, `bufio`, `errors`, `sync`, and `testing`/`pprof`. Put Groq behind a small provider interface which accepts a request and yields model events; do not make an SDK's types the core model.
- **Recommendation:** begin with hand-authored, versioned JSON Schema documents plus tool-specific JSON decoding/validation. Add one schema dependency only when generated schemas demonstrably remove enough duplication. A JSON Schema generator is a better fit than a general “Zod-like” validator for the provider boundary.
- **Recommendation:** do not adopt an unofficial Groq Go SDK as the foundation. Groq officially supports REST/OpenAI compatibility and officially lists Python and JavaScript/TypeScript client libraries, but no Go library was found as of this date.

## Cancellation, lifetime, and bounded streaming

The standard `context` contract is the appropriate public cancellation API. A derived context's `Done` channel closes on its own cancel, its deadline, or parent cancellation; `Err` then reports `Canceled` or `DeadlineExceeded`. The documentation says to call a returned `CancelFunc` as soon as work completes so associated resources are released, and says values are for request-scoped data crossing APIs—not optional function parameters. [context package](https://pkg.go.dev/context) · [official guidance against storing contexts in structs](https://go.dev/blog/context-and-structs)

- **Recommendation:** make `context.Context` the first parameter of each provider call and tool invocation. Derive one run deadline at the entrypoint, a shorter deadline for each HTTP attempt/tool call, and always `defer cancel` at the scope that created it. Keep dependencies (client, tracer, tool registry) as explicit fields/arguments, not context values.
- **Recommendation:** when a user pauses/cancels, cancel the run context. A request made with `http.NewRequestWithContext` is cancelled over its whole lifetime, including connection acquisition, sending, and reading the response body. That gives one cancellation path for normal completions and streams. [net/http Request documentation](https://pkg.go.dev/net/http#NewRequestWithContext)
- **Recommendation:** use a pull-style stream or a deliberately bounded event channel. If an adapter must send to a channel, select on both the send and `ctx.Done()`; never create an unbounded queue of text deltas. Stop reading and close the response body when the consumer exits. This is the Go mechanism that supplies backpressure without a separate framework.

## HTTP, SSE, and Groq

Groq's documented chat endpoint is `POST https://api.groq.com/openai/v1/chat/completions`; its API is OpenAI-compatible and uses Bearer authentication. [Groq API reference](https://console.groq.com/docs/api-reference) · [OpenAI compatibility](https://console.groq.com/docs/openai)

For a streaming response, treat the HTTP response body as the SSE byte stream and decode complete SSE events before interpreting their JSON. `net/http` requires a successful response body to be closed; reading it to EOF and closing it enables persistent-connection reuse. Reuse a long-lived `http.Client`/transport rather than constructing one per request. [net/http client/response-body contract](https://pkg.go.dev/net/http#Client.Do) · [Groq streaming text chat](https://console.groq.com/docs/text-chat) · [Groq streaming tool use](https://console.groq.com/docs/tool-use/local-tool-calling)

`bufio.Scanner` is fine for line-oriented SSE only with an intentional maximum event-line size: its default maximum token is 64 KiB, scanning cannot recover after an oversized token, and `Scanner.Buffer` must be set before scanning. Use `bufio.Reader` instead when large tool-argument fragments or more precise framing/error handling need to be supported. [bufio.Scanner contract](https://pkg.go.dev/bufio#Scanner)

**Groq capability constraint (fact, current at check date):** the Structured Outputs documentation says streaming and tool use are not currently supported together with `json_schema` Structured Outputs. The agent loop therefore needs separate modes: streamed tool calling with local post-validation, or a non-streamed strict structured-output turn—not a configuration that assumes all three work together. [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs)

### Official Go SDK status

Groq's own client-library page says it provides Python and JavaScript/TypeScript libraries; the verified Groq GitHub organization likewise identifies `groq-python` and `groq-typescript` as official API clients. The official quickstart offers curl, Python, and JavaScript material, not Go. [Groq client libraries](https://console.groq.com/docs/libraries) · [Groq GitHub organization](https://github.com/groq) · [Quickstart](https://console.groq.com/docs/quickstart)

**Decision:** implement the small Groq adapter with standard `net/http` and `encoding/json`. This is an absence-of-official-SDK finding, not a promise that Groq will never release one. A discovered Go client explicitly brands itself an “Unofficial Groq SDK,” so it should not be described as vendor-supported. [ZaguanLabs/groq-go](https://github.com/ZaguanLabs/groq-go)

## Heterogeneous tools: generics at construction, erasure at the registry

Go interfaces hold dynamic concrete values, and type assertions provide the checked conversion back to a concrete type. `any` is an alias for `interface{}`. [Go specification: interface values and assertions](https://go.dev/ref/spec#Interface_types) · [Go specification: type assertions](https://go.dev/ref/spec#Type_assertions)

The Go team's generic-design guidance is especially relevant: when code only needs to call a method on values, use an interface rather than a type parameter; type parameters are not generally faster than interfaces. [When To Use Generics](https://go.dev/blog/when-generics) · [Generic interfaces guidance](https://go.dev/blog/generic-interfaces)

**Recommendation:** tools should be heterogeneous behind one non-generic, erased registry entry: name/description, provider JSON Schema bytes, and an invocation boundary that consumes raw JSON and returns raw JSON plus error. A generic constructor may decode raw arguments into a typed input and invoke a typed function, but it should erase that type before registration. This keeps a `[]Tool` possible without `any` leaking through the agent loop, makes schemas inspectable before a request, and avoids pretending a heterogeneous collection is a homogeneous `[]Tool[T]`.

For correctness, model-emitted arguments are untrusted: decode/validate at the erased boundary, return a compact tool error suitable for the next model turn, and preserve the raw payload only in constrained trace data. This is an architectural recommendation, not a special Groq requirement.

## Zod-like validation and JSON Schema

[Oudwins/zog](https://github.com/Oudwins/zog) is a fluent, Zod-inspired Go runtime parser/validator with zero core dependencies, coercion, rich issues, `Parse`, and `Validate`. It can be suitable as an **optional local Go-struct validator**, but it has material caveats for Hog:

- It is still v0 and its own documentation says API stability is not promised across minor releases; pin an exact module version. [Zog API-stability statement](https://zog.dev/#api-stability) · [v0.23.0 release](https://github.com/Oudwins/zog/releases/tag/v0.23.0)
- JSON decoding via `zjson` parses into structs only, not arbitrary destination data types. That is awkward for a general tool boundary whose arguments may be heterogeneous. [Zog `zjson` documentation](https://zog.dev/packages/zjson/)
- **Current answer to “does Zog emit JSON Schema?”: yes, but experimentally.** v0.23.0 exposes a two-step conversion from `EXPERIMENTAL_TO_ZSS` to a JSON Schema, including Draft 2020-12. ZSS and the first conversion are explicitly experimental; conversion options include handling for unknown kinds/tests, so representability is not guaranteed for every custom schema. [Zog ZSS status](https://zog.dev/experimental/zss/) · [JSON Schema converter API](https://pkg.go.dev/github.com/Oudwins/zog/pkgs/zss/jsonschema) · [Draft 2020-12 converter API](https://pkg.go.dev/github.com/Oudwins/zog/pkgs/zss/jsonschema/draft2020_12)

Groq strict output schemas require all fields to be `required` and every object to set `additionalProperties: false`; generated Zog schema must therefore be snapshot-tested and checked against Groq's requirements before it is sent. [Groq Structured Outputs requirements](https://console.groq.com/docs/structured-outputs)

An alternative when JSON Schema emission is the primary job is [invopop/jsonschema](https://github.com/invopop/jsonschema): it reflects Go types into JSON Schema Draft 2020-12 and supports common JSON-Schema constraints. It is also v0 and currently requires Go 1.24+, so it is an optional, pinned dependency rather than a universal core assumption. It generates schemas; it is not presented as a general runtime validator. [project README and compatibility notes](https://github.com/invopop/jsonschema)

**Decision:** do not make Zog a required dependency for the minimal release. If adopted later, pin it, generate schemas during tests/build rather than per request, and test both local validation and the exact JSON Schema payload sent to Groq. Prefer hand-authored schema plus standard-library decode initially; choose `invopop/jsonschema` only when Go-struct-to-schema generation is the concrete need.

## Race, allocation, and memory evidence

- Use `go test -race` on concurrent unit/integration paths. It detects only races exercised at runtime, so realistic cancellation/stream-disconnect tests matter. [official race detector](https://go.dev/doc/articles/race_detector)
- Measure small hot paths with `go test -bench` and allocation stats (`-benchmem` / `B.ReportAllocs`). The testing API exposes allocation reporting specifically for this purpose. [testing benchmark API](https://pkg.go.dev/testing#B.ReportAllocs)
- Use CPU and memory profiles to locate real costs before adding pooling. The `allocs` profile reports total bytes allocated since program start, including garbage-collected allocations; it is not the same question as live heap retention. [runtime/pprof](https://pkg.go.dev/runtime/pprof#Profile)
- Do not equate Go heap metrics with process RSS. `runtime/metrics` exposes runtime-defined memory classes, whereas the process can also contain runtime mappings, stacks, cgo allocations, and other OS mappings. Use RSS as an external process measurement alongside Go allocation/heap profiles, and label them separately. [runtime/metrics](https://pkg.go.dev/runtime/metrics)

**Performance recommendation:** benchmark an end-to-end stream (parse → event → consumer cancellation) with allocation counts and a representative maximum SSE line. Only introduce `sync.Pool`, custom byte reuse, or a third-party SSE client after profiles identify a persistent allocation/latency bottleneck; those mechanisms otherwise make cancellation and ownership harder to audit.

## Minimal dependency policy

1. **Required:** Go standard library only; raw HTTP Groq adapter, context-aware stream, erased tool registry, explicit JSON Schema documents, and focused decoder/validator per tool.
2. **Allowed only behind a measured need:** one pinned schema generator/validator. Prefer `invopop/jsonschema` for Go-type schema generation; use Zog only when its fluent local-validation ergonomics outweigh its v0/experimental conversion risk.
3. **Defer:** community Groq SDKs, generic agent frameworks, an SSE dependency, object pools, durable workflow engines, and broad validation frameworks. Each adds a compatibility and cancellation surface which the initial design does not require.

## Uncertainty ledger

- The “no official Go SDK” conclusion is based on Groq's official libraries page, quickstart, and verified GitHub organization as checked on 2026-09-21. It is an evidence-backed absence claim and can change.
- Zog's experimental ZSS page still says JSON Schema is planned, while its later v0.23.0 release and published converter packages expose conversion. This report treats the dated release and package APIs as the stronger current evidence, but calls the pathway experimental as its own docs do.
- Provider/model capability is not a stable language-level guarantee. Re-check Groq's Structured Outputs and model-support documentation when selecting a production model or combining streaming, tools, and strict schemas.
