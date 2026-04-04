# pi-orchestrator

Config-driven multi-agent orchestration for [Pi](https://github.com/Dicklesworthstone/pi_agent_rust). Define agents with any provider, model, tools, instructions, and timeouts in a single JSON config file.

## Quick Start

Create `~/.pi/agent/orchestrator.json`:

```json
{
  "defaultTimeout": 120,
  "defaultConcurrency": 4,
  "agents": {
    "coder": {
      "provider": "zai-anthropic",
      "model": "glm-5-turbo",
      "tools": ["read", "write", "edit", "bash"],
      "thinkingLevel": "low",
      "instructions": "You are a fast coder. Read files, make precise edits, run verification commands.",
      "timeout": 60
    },
    "reviewer": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "tools": ["read", "grep", "find", "ls"],
      "instructions": "You are a code reviewer. Analyze for bugs, security issues, and improvements.",
      "timeout": 90
    },
    "architect": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "tools": ["read", "grep", "find", "ls"],
      "thinkingLevel": "high",
      "instructions": "You are an architect. Design solutions and break down complex tasks into subtasks."
    },
    "scout": {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "tools": ["read", "grep", "find", "ls"],
      "instructions": "You are a scout. Search and summarize code quickly.",
      "timeout": 30
    }
  }
}
```

Project-level override: `.pi/orchestrator.json` (merges on top of global config, agents override by name).

## Usage

The extension registers a `subagent` tool available in any Pi session.

### Single Task
```json
{ "agent": "coder", "task": "Add input validation to src/api/users.ts" }
```

### Parallel Tasks
```json
{
  "tasks": [
    { "agent": "coder", "task": "Add input validation to src/api/users.ts" },
    { "agent": "coder", "task": "Write unit tests for src/api/users.ts" }
  ]
}
```

### Chain (Sequential)
```json
{
  "chain": [
    { "agent": "architect", "task": "Design the auth middleware refactoring" },
    { "agent": "coder", "task": "Implement the plan:\n\n{previous}" },
    { "agent": "reviewer", "task": "Review the implementation:\n\n{previous}" }
  ]
}
```

The `{previous}` placeholder is replaced with the output of the prior step.

## Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultTimeout` | number | 120 | Fallback timeout in seconds |
| `defaultConcurrency` | number | 4 | Max parallel agents |
| `agents` | object | {} | Agent definitions keyed by name |

### Agent Definition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | yes | Provider name (e.g. "anthropic", "openai", "zai-anthropic") |
| `model` | string | yes | Model ID (e.g. "claude-sonnet-4-5", "glm-5-turbo") |
| `tools` | string[] | no | Tools to enable (e.g. ["read", "write", "edit", "bash"]) |
| `thinkingLevel` | string | no | off, minimal, low, medium, high, xhigh |
| `instructions` | string | yes | System prompt injected into the agent |
| `timeout` | number | no | Per-agent timeout in seconds (falls back to defaultTimeout) |

## Files

| File | Purpose |
|------|---------|
| `config.ts` | Loads + merges `orchestrator.json` from `~/.pi/agent/` and `.pi/`, resolves per-agent timeout |
| `executor.ts` | Spawns `pi --mode json -p` subprocess per agent, inlines instructions, enforces timeout via `AbortSignal.timeout()`, parses JSONL output |
| `index.ts` | `session_start` loads config + notifies user, `before_agent_start` injects agent list into system prompt, registers `subagent` tool |

## How It Works

Each subagent invocation spawns a separate `pi` process:

```bash
pi --mode json -p --no-session \
   --provider anthropic \
   --model claude-sonnet-4-5 \
   --tools read,grep,find,ls \
   "[System Instructions]: ... 
---
[Task]: Review the auth module"
```

The parent session receives JSONL events (`message_end`, `tool_result_end`) and extracts the final assistant message as the result.

## Installation

```bash
pi install /path/to/pi-orchestrator
```

## License

MIT
