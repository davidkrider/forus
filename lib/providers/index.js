// lib/providers/index.js
// Provider registry. To add a new backend, write a module that exports
//   async classify({ settings, system, user, signal }) -> Verdict[]
// where Verdict = { id, category, confidence, reason }, then register it here and add
// a defaults block in lib/config.js. Nothing else in the codebase needs to change.

import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import * as ollama from "./ollama.js";

const REGISTRY = { anthropic, openai, ollama };

export function getProvider(name) {
  const provider = REGISTRY[name];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}
