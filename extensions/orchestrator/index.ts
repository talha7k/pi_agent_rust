/**
 * Config-driven multi-agent orchestrator for Pi.
 *
 * Loads agent definitions from ~/.pi/agent/orchestrator.json (and optional
 * project-local .pi/orchestrator.json override). Everything — provider, model,
 * tools, instructions, timeout — comes from config. No hardcoded agents.
 *
 * Registers a `subagent` tool with three modes:
 *   - Single:  { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent, task }, ...] }
 *   - Chain:   { chain: [{ agent, task: "... {previous} ..." }, ...] }
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type OrchestratorConfig, loadConfig } from "./config.js";
import {
  type SingleResult,
  type UsageStats,
  aggregateUsage,
  formatUsageStats,
  getFinalOutput,
  runChain,
  runParallel,
  runSingleAgent,
} from "./executor.js";

// ============================================================================
// TOOL SCHEMA
// ============================================================================

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent (must match orchestrator.json)" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent (must match orchestrator.json)" }),
  task: Type.String({ description: "Task. Use {previous} to inject prior step output." }),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task description (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel: array of {agent, task}" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain. Use {previous} placeholder." })),
  cwd: Type.Optional(Type.String({ description: "Working directory override (single mode)" })),
  maxConcurrency: Type.Optional(Type.Number({ description: "Max parallel agents (default from config)", default: 4 })),
});

const MAX_PARALLEL_TASKS = 8;

// ============================================================================
// EXTENSION
// ============================================================================

export default function (pi: ExtensionAPI) {
  let config: OrchestratorConfig | null = null;

  // Load config on session start
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);

    const agentNames = Object.keys(config.agents);
    if (agentNames.length > 0) {
      const agentList = agentNames
        .map((name) => {
          const a = config!.agents[name];
          const modelTag = a.model ? ` (${a.model})` : "";
          const providerTag = a.provider ? ` @${a.provider}` : "";
          return `  - ${name}${modelTag}${providerTag}`;
        })
        .join("\n");
      ctx.ui.notify(`🤖 Orchestrator ready — ${agentNames.length} agents:\n${agentList}`, "info");
    } else {
      ctx.ui.notify("⚠️ Orchestrator: no agents configured. Create ~/.pi/agent/orchestrator.json", "warn");
    }
  });

  // Inject available agents into system prompt
  pi.on("before_agent_start", async (event) => {
    if (!config || Object.keys(config.agents).length === 0) return;

    const agentsList = Object.entries(config.agents)
      .map(([name, a]) => {
        const modelTag = a.model ? ` [${a.model}]` : "";
        const providerTag = a.provider ? ` @${a.provider}` : "";
        const toolsTag = a.tools?.length ? ` tools: ${a.tools.join(",")}` : "";
        return `- **${name}**${modelTag}${providerTag}${toolsTag}`;
      })
      .join("\n");

    return {
      systemPrompt:
        event.systemPrompt +
        `

## Multi-Agent Orchestration

You have access to a \`subagent\` tool that delegates tasks to specialized agents. Use it to parallelize work and match the right model to each task.

### Available Agents

${agentsList}

### Modes

**Single**: Delegate one task to one agent
\`\`\`json
{ "agent": "coder", "task": "Add input validation to src/api/users.ts" }
\`\`\`

**Parallel**: Multiple independent tasks simultaneously
\`\`\`json
{ "tasks": [
    { "agent": "coder", "task": "Implement feature A" },
    { "agent": "coder", "task": "Write tests for feature B" }
]}
\`\`\`

**Chain**: Sequential pipeline, use \`{previous}\` to pass output forward
\`\`\`json
{ "chain": [
    { "agent": "architect", "task": "Design the auth middleware refactoring" },
    { "agent": "coder", "task": "Implement the plan:\\n\\n{previous}" },
    { "agent": "reviewer", "task": "Review the implementation:\\n\\n{previous}" }
]}
\`\`\`
`,
    };
  });

  // Register the subagent tool
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents defined in orchestrator.json.",
      "Modes: single (agent+task), parallel (tasks[]), chain (sequential with {previous} placeholder).",
      "Agents are fully configurable — provider, model, tools, instructions, timeout — all from config.",
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Lazy-load config if session_start didn't fire
      if (!config) config = loadConfig(ctx.cwd);

      const maxConcurrency = params.maxConcurrency ?? config.defaultConcurrency ?? 4;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      // Validate: exactly one mode
      if (modeCount !== 1) {
        const available = Object.entries(config.agents)
          .map(([n, a]) => `${n} [${a.model || "default"}]`)
          .join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Error: Provide exactly one mode — \`agent+task\`, \`tasks[]\`, or \`chain[]\`.\n\nAvailable agents: ${available || "(none configured)"}`,
            },
          ],
        };
      }

      // ---- SINGLE MODE ----
      if (hasSingle && params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          config,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate
            ? (partial) =>
                onUpdate({
                  content: partial.content,
                })
            : undefined,
        );

        const isError =
          result.exitCode !== 0 ||
          result.stopReason === "error" ||
          result.stopReason === "aborted";

        if (isError) {
          const errorMsg =
            result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
          return {
            content: [{ type: "text", text: `✗ Agent ${params.agent} failed: ${errorMsg}` }],
            isError: true,
          };
        }

        const output = getFinalOutput(result.messages) || "(no output)";
        const usage = formatUsageStats(result.usage, result.model);
        const usageLine = usage ? `\n\n_Stats: ${usage}_` : "";

        return {
          content: [{ type: "text", text: `✓ **${params.agent}** completed:\n\n${output}${usageLine}` }],
        };
      }

      // ---- PARALLEL MODE ----
      if (hasTasks && params.tasks) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            isError: true,
          };
        }

        const results = await runParallel(
          ctx.cwd,
          config,
          params.tasks,
          maxConcurrency,
          signal,
          onUpdate
            ? (allResults) => {
                const done = allResults.filter((r) => r.exitCode >= 0).length;
                onUpdate({
                  content: [
                    {
                      type: "text",
                      text: `⏳ Parallel: ${done}/${allResults.length} completed...`,
                    },
                  ],
                });
              }
            : undefined,
        );

        const successCount = results.filter((r) => r.exitCode === 0).length;
        const summaries = results.map((r) => {
          const icon = r.exitCode === 0 ? "✓" : "✗";
          const output = getFinalOutput(r.messages);
          const preview = output.length > 150 ? `${output.slice(0, 150)}...` : output;
          const usage = formatUsageStats(r.usage);
          return `### ${icon} ${r.agent}\n${preview || "(no output)"}${usage ? `\n_Stats: ${usage}_` : ""}`;
        });

        const agg = aggregateUsage(results);
        const totalUsage = formatUsageStats(agg);

        return {
          content: [
            {
              type: "text",
              text: `**Parallel: ${successCount}/${results.length} succeeded**\n\n${summaries.join("\n\n---\n\n")}${totalUsage ? `\n\n---\n**Total:** ${totalUsage}` : ""}`,
            },
          ],
        };
      }

      // ---- CHAIN MODE ----
      if (hasChain && params.chain) {
        const results = await runChain(
          ctx.cwd,
          config,
          params.chain,
          signal,
          onUpdate
            ? (partialResults, stepIdx) => {
                onUpdate({
                  content: [
                    {
                      type: "text",
                      text: `⏳ Chain: step ${stepIdx + 1}/${params.chain!.length} (${partialResults[partialResults.length - 1]?.agent})...`,
                    },
                  ],
                });
              }
            : undefined,
        );

        const failedStep = results.find(
          (r) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted",
        );

        if (failedStep) {
          const errorMsg =
            failedStep.errorMessage || failedStep.stderr || getFinalOutput(failedStep.messages) || "(no output)";
          return {
            content: [
              {
                type: "text",
                text: `✗ Chain failed at step ${failedStep.step} (${failedStep.agent}): ${errorMsg}`,
              },
            ],
            isError: true,
          };
        }

        const stepSummaries = results.map((r) => {
          const output = getFinalOutput(r.messages);
          const preview = output.length > 200 ? `${output.slice(0, 200)}...` : output;
          const usage = formatUsageStats(r.usage);
          return `### Step ${r.step}: ${r.agent} ✓\n${preview}${usage ? `\n_Stats: ${usage}_` : ""}`;
        });

        const finalOutput = getFinalOutput(results[results.length - 1].messages);
        const agg = aggregateUsage(results);
        const totalUsage = formatUsageStats(agg);

        return {
          content: [
            {
              type: "text",
              text: `**Chain completed (${results.length} steps)**\n\n${stepSummaries.join("\n\n---\n\n")}\n\n---\n### Final Output\n\n${finalOutput}${totalUsage ? `\n\n**Total:** ${totalUsage}` : ""}`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: "Invalid parameters." }],
      };
    },
  });
}
