import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  StreamOptions,
} from "@openclaw/llm-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  failTransportStream,
  transportAbortError,
} from "../../ai/src/transports/transport-stream-shared.js";
import { agentLoop, runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import { attachInternalToolBatchLifecycle } from "./internal-hooks.js";
import { createAssistantMessageEventStream } from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "./types.js";

const model: Model = {
  id: "abort-model",
  name: "Abort model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    usage: {
      input: 4,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 9,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 8,
  };
}

describe.each(["agentLoop", "runAgentLoop", "runAgentLoopContinue"] as const)(
  "returned transport abort ownership through %s",
  (entrypoint) => {
    it.each([
      { order: "runtime-first", runtime: true },
      { order: "external-first", runtime: false },
      { order: "runtime-then-external", runtime: true },
      { order: "provider-terminal-first", runtime: false },
      { order: "provider-abort-first", runtime: false },
      { order: "provider-control", runtime: false },
    ] as const)(
      "preserves the first owner and terminal metadata: $order",
      async ({ order, runtime }) => {
        const failure = new Error("opaque admission failure");
        const providerTerminalFirst =
          order === "provider-terminal-first" || order === "provider-abort-first";
        const external = new AbortController();
        const aborted = createDeferred();
        const fatalReady = createDeferred();
        const terminalObserved = createDeferred();
        const closed = vi.fn();
        const execute = vi.fn(async () => ({ content: [], details: {} }));
        const tool: AgentTool = {
          name: "lookup",
          label: "Lookup",
          description: "Lookup",
          parameters: Type.Object({}),
          execute,
        };
        const toolCall = {
          type: "toolCall" as const,
          id: "lookup",
          name: "lookup",
          arguments: {},
          async: true as const,
        };
        const existingDiagnostic = {
          type: "transport_context",
          timestamp: 7,
          details: { phase: "streaming" },
        };
        const output: AssistantMessage = {
          ...assistant([toolCall, { type: "text", text: "Remaining response fragment" }]),
          diagnostics: [existingDiagnostic],
          errorCode: "opaque-terminal-code",
          errorType: "opaque-terminal-type",
          errorBody: '{"detail":"retained"}',
        };
        let originalTerminal: AssistantMessage | undefined;
        let control: Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0] | undefined;
        const needsContinuation = vi
          .fn(() => false)
          .mockImplementationOnce(() => {
            if (order === "provider-control") {
              throw failure;
            }
            return false;
          });
        const commitReadyCalls = vi.fn(() => {
          if (order === "external-first") {
            external.abort(new Error("Caller cancelled"));
          }
          if (order === "provider-control") {
            control?.needsContinuation?.();
          }
          throw failure;
        });
        const releaseSkippedCalls = vi.fn();
        const config: AgentLoopConfig = {
          model,
          convertToLlm: (messages) => messages as Message[],
          onActiveResponse: (active) => {
            control = active;
          },
          beforeToolBatch: async () =>
            attachInternalToolBatchLifecycle({}, { commitReadyCalls, releaseSkippedCalls }),
          afterToolOutcome: async () => {
            fatalReady.resolve();
            if (providerTerminalFirst) {
              // Hold fatal batch settlement until the provider terminal fences the request.
              await terminalObserved.promise;
            }
            return undefined;
          },
        };
        const terminal = createAssistantMessageEventStream();
        const streamFn: StreamFn = (_model, _context, options) => {
          const signal = options?.signal;
          if (!signal) {
            throw new Error("Expected the provider execution signal");
          }
          const disconnect = options?.onActiveResponse?.({
            steer: async () => false,
            needsContinuation,
          });
          const onAbort = () => {
            if (order === "runtime-then-external") {
              external.abort(new Error("Caller cancelled after runtime abort"));
            }
            aborted.resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
              try {
                yield { type: "start", partial: assistant([]) };
                yield {
                  type: "toolcall_end",
                  contentIndex: 0,
                  toolCall,
                  partial: assistant([toolCall]),
                };
                await (providerTerminalFirst ? fatalReady.promise : aborted.promise);
                const error = providerTerminalFirst
                  ? new Error("Opaque provider failure")
                  : transportAbortError(signal);
                if (!providerTerminalFirst) {
                  expect(error).not.toBe(signal.reason);
                }
                failTransportStream({
                  stream: terminal,
                  output,
                  error,
                  signal: order === "provider-abort-first" ? AbortSignal.abort() : signal,
                });
                originalTerminal = structuredClone(output);
                Object.freeze(output.diagnostics);
                Object.freeze(output);
                yield* terminal;
              } finally {
                signal.removeEventListener("abort", onAbort);
                disconnect?.();
                closed();
              }
            },
            result() {
              terminalObserved.resolve();
              return terminal.result();
            },
          };
        };
        const prompt: AgentMessage = { role: "user", content: "look up", timestamp: 1 };
        const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
        const events: AgentEvent[] = [];
        const emit = (event: AgentEvent) => {
          events.push(event);
        };
        let messages: AgentMessage[];
        if (entrypoint === "agentLoop") {
          const stream = agentLoop([prompt], context, config, external.signal, streamFn);
          for await (const event of stream) {
            emit(event);
          }
          messages = await stream.result();
        } else if (entrypoint === "runAgentLoop") {
          messages = await runAgentLoop([prompt], context, config, emit, external.signal, streamFn);
        } else {
          context.messages.push(prompt);
          messages = await runAgentLoopContinue(context, config, emit, external.signal, streamFn);
        }
        const final = messages.findLast((message) => message.role === "assistant");
        if (!final || final.role !== "assistant") {
          throw new Error("Expected a terminal assistant message");
        }
        expect(final).toMatchObject({
          stopReason: order === "provider-terminal-first" ? "error" : "aborted",
          errorMessage: providerTerminalFirst ? "Opaque provider failure" : "Request was aborted",
          errorCode: output.errorCode,
          errorType: output.errorType,
          errorBody: output.errorBody,
          content: output.content.slice(1),
          usage: output.usage,
          timestamp: output.timestamp,
        });
        expect(final.diagnostics).toEqual([
          existingDiagnostic,
          ...(runtime ? [{ type: "synthesized_run_failure", timestamp: output.timestamp }] : []),
        ]);
        expect(output).toEqual(originalTerminal);
        expect(final).not.toBe(output);
        expect(events).toContainEqual({ type: "message_end", message: final });
        expect(commitReadyCalls).toHaveBeenCalledExactlyOnceWith([
          { toolCallId: "lookup", args: {} },
        ]);
        expect(releaseSkippedCalls).toHaveBeenCalledExactlyOnceWith(["lookup"]);
        expect(execute).not.toHaveBeenCalled();
        expect(closed).toHaveBeenCalledOnce();
      },
    );
  },
);
