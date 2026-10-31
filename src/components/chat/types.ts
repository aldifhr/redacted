export type ThinkingEntry = string | { text: string; phase?: string };

export type Msg = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { tool: string; input: unknown }[];
  screenshots?: { url: string; image: string }[];
  artifacts?: { kind: string; file: string; meta: Record<string, unknown> }[];
  thinking?: ThinkingEntry[];
  model?: string;
  skills?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  browserActions?: number;
  artifactActions?: number;
  modelRounds?: number;
  requestedAreas?: string[];
  completedAreas?: string[];
  coverage?: { requestedAreas: string[]; visitedAreas: string[]; coveredAreas: string[]; missingAreas: string[] };
  stopReason?: "completed" | "action_limit" | "model_timeout" | "model_round_limit" | "budget_limit";
  time?: string;
};

export type Approval = {
  id: string;
  runId: string;
  tool: string;
  input: unknown;
};

export type Attachment = {
  name: string;
  text: string;
};

export type LightboxState = {
  list: { image: string; url: string }[];
  i: number;
} | null;

export function now() {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
