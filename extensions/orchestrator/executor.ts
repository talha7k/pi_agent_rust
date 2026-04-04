/**
 * Generic subprocess executor — spawns `pi --mode json -p` per agent.
 *
 * - Reads agent config (provider, model, tools, instructions, timeout) from AgentDef
 * - Inlines system instructions into the task prompt (no temp files)
 * - Enforces per-agent timeout via AbortSignal.timeout()
 * - Parses JSONL output (message_end, tool_result_end events)
 */

import type { Message } from "@mariozechner/pi-ai";
import { spawn } from "node:child_process";
import type { AgentDef, OrchestratorConfig } from "./config.js";
import { getAgentTimeout } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export type OnUpdateCallback = (partial: {
  content: Array<{ type: string; text: string }>;
  running: boolean;
}) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function aggregateUsage(results: SingleResult[]): UsageStats {
  const total: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.contextTokens += r.usage.contextTokens;
    total.turns += r.usage.turns;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Single agent execution
// ---------------------------------------------------------------------------

export async function runSingleAgent(
  defaultCwd: string,
  config: OrchestratorConfig,
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  parentSignal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
  const agent = config.agents[agentName];

  if (!agent) {
    const available = Object.keys(config.agents).join(", ");
    return {
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: ${agentName}. Available: ${available}`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
      errorMessage: `Unknown agent: ${agentName}`,
    };
  }

  // Per-agent timeout with AbortSignal.timeout()
  const timeoutSec = getAgentTimeout(agent, config);
  const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);

  // Combine parent signal + timeout signal
  const combinedSignal = AbortSignal.any(
    parentSignal ? [parentSignal, timeoutSignal] : [timeoutSignal],
  );

  // Build CLI args
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.provider) args.push("--provider", agent.provider);
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  // Inline instructions directly into the prompt — no temp files
  const fullPrompt = agent.instructions.trim()
    ? `[System Instructions — follow these rules]:\n${agent.instructions}\n\n---\n\n[Task]: ${task}`
    : `Task: ${task}`;

  const currentResult: SingleResult = {
    agent: agentName,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    provider: agent.provider,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        running: true,
      });
    }
  };

  try {
    args.push(fullPrompt);

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      // Handle abort from parent signal or timeout
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };

      if (combinedSignal.aborted) {
        killProc();
      } else {
        combinedSignal.addEventListener("abort", killProc, { once: true });
      }
    });

    if (timeoutSignal.aborted) {
      currentResult.exitCode = 1;
      currentResult.errorMessage = `Agent timed out after ${timeoutSec}s`;
      currentResult.stopReason = "aborted";
    } else {
      currentResult.exitCode = exitCode;
    }

    return currentResult;
  } catch (err) {
    currentResult.exitCode = 1;
    currentResult.errorMessage = err instanceof Error ? err.message : String(err);
    return currentResult;
  }
}

// ---------------------------------------------------------------------------
// Parallel execution
// ---------------------------------------------------------------------------

export async function runParallel(
  defaultCwd: string,
  config: OrchestratorConfig,
  tasks: Array<{ agent: string; task: string; cwd?: string }>,
  concurrency: number,
  signal: AbortSignal | undefined,
  onUpdate: ((results: SingleResult[]) => void) | undefined,
): Promise<SingleResult[]> {
  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  const allResults: SingleResult[] = new Array(tasks.length);

  for (let i = 0; i < tasks.length; i++) {
    allResults[i] = {
      agent: tasks[i].agent,
      task: tasks[i].task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }

  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= tasks.length) return;

      const t = tasks[current];
      allResults[current] = await runSingleAgent(
        defaultCwd,
        config,
        t.agent,
        t.task,
        t.cwd,
        undefined,
        signal,
        onUpdate
          ? () => onUpdate([...allResults])
          : undefined,
      );
      onUpdate?.([...allResults]);
    }
  });

  await Promise.all(workers);
  return allResults;
}

// ---------------------------------------------------------------------------
// Chain execution (sequential, {previous} placeholder)
// ---------------------------------------------------------------------------

export async function runChain(
  defaultCwd: string,
  config: OrchestratorConfig,
  steps: Array<{ agent: string; task: string; cwd?: string }>,
  signal: AbortSignal | undefined,
  onUpdate: ((results: SingleResult[], stepIndex: number) => void) | undefined,
): Promise<SingleResult[]> {
  const results: SingleResult[] = [];
  let previousOutput = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

    const result = await runSingleAgent(
      defaultCwd,
      config,
      step.agent,
      taskWithContext,
      step.cwd,
      i + 1,
      signal,
      undefined,
    );

    results.push(result);

    const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
    if (isError) break;

    previousOutput = getFinalOutput(result.messages);
    onUpdate?.(results, i);
  }

  return results;
}
