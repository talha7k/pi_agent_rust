/**
 * Config loader — reads ~/.pi/agent/orchestrator.json and optional project-local override.
 *
 * Config schema:
 * {
 *   "defaultTimeout": 120,
 *   "defaultConcurrency": 4,
 *   "agents": {
 *     "coder": {
 *       "provider": "zai-anthropic",
 *       "model": "glm-5-turbo",
 *       "tools": ["read", "write", "edit", "bash"],
 *       "thinkingLevel": "low",
 *       "instructions": "You are a fast coder...",
 *       "timeout": 60
 *     },
 *     "reviewer": {
 *       "provider": "anthropic",
 *       "model": "claude-sonnet-4-5",
 *       "tools": ["read", "grep", "find", "ls"],
 *       "thinkingLevel": "medium",
 *       "instructions": "You are a code reviewer...",
 *       "timeout": 90
 *     }
 *   }
 * }
 *
 * Merge order: global ← project-local (project overrides global agents by name)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentDef {
  /** Provider name matching models.json (e.g. "anthropic", "openai", "zai-anthropic") */
  provider: string;
  /** Model ID (e.g. "claude-sonnet-4-5", "glm-5-turbo") */
  model: string;
  /** Tools to enable for this agent */
  tools?: string[];
  /** Thinking level: off, minimal, low, medium, high, xhigh */
  thinkingLevel?: string;
  /** System prompt instructions injected into the agent */
  instructions: string;
  /** Per-agent timeout in seconds. Falls back to defaultTimeout */
  timeout?: number;
}

export interface OrchestratorConfig {
  /** Default timeout in seconds for any agent without its own timeout */
  defaultTimeout?: number;
  /** Max concurrent agents in parallel mode (default: 4) */
  defaultConcurrency?: number;
  /** Agent definitions keyed by name */
  agents: Record<string, AgentDef>;
}

const DEFAULT_TIMEOUT = 120;
const DEFAULT_CONCURRENCY = 4;

export function loadConfig(cwd: string): OrchestratorConfig {
  const globalPath = join(homedir(), ".pi", "agent", "orchestrator.json");
  const projectPath = join(cwd, ".pi", "orchestrator.json");

  let globalConfig: OrchestratorConfig = { agents: {} };
  let projectConfig: OrchestratorConfig = { agents: {} };

  if (existsSync(globalPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
    } catch (err) {
      console.error(`orchestrator: failed to parse ${globalPath}:`, err);
    }
  }

  if (existsSync(projectPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
    } catch (err) {
      console.error(`orchestrator: failed to parse ${projectPath}:`, err);
    }
  }

  // Merge: project agents override global by name
  const merged: OrchestratorConfig = {
    defaultTimeout: projectConfig.defaultTimeout ?? globalConfig.defaultTimeout ?? DEFAULT_TIMEOUT,
    defaultConcurrency: projectConfig.defaultConcurrency ?? globalConfig.defaultConcurrency ?? DEFAULT_CONCURRENCY,
    agents: { ...globalConfig.agents, ...projectConfig.agents },
  };

  return merged;
}

/** Get effective timeout for an agent (agent-specific or global default) */
export function getAgentTimeout(agent: AgentDef, config: OrchestratorConfig): number {
  return agent.timeout ?? config.defaultTimeout ?? DEFAULT_TIMEOUT;
}
