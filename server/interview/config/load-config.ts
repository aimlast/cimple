import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

interface AgentConfig {
  models: {
    interviewAgent: string;
    supportingAgents: string;
  };
  api: {
    maxTokens: number;
    temperature: number;
  };
  interview: {
    maxTurnsBeforeEndCheck: number;
    minTurnsBeforeEnd: number;
  };
}

function loadAgentConfig(): AgentConfig {
  try {
    const raw = readFileSync(join(__dir, "agent-config.json"), "utf-8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    // Fallback defaults if config file is missing
    return {
      models: {
        interviewAgent: "claude-opus-4-5-20250520",
        supportingAgents: "claude-sonnet-4-5-20250514",
      },
      api: { maxTokens: 4096, temperature: 1 },
      interview: { maxTurnsBeforeEndCheck: 30, minTurnsBeforeEnd: 10 },
    };
  }
}

export const agentConfig = loadAgentConfig();
