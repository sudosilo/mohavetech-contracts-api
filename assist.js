import Anthropic from "@anthropic-ai/sdk";
import { redis } from "./redis.js";

const MODEL = process.env.ASSIST_MODEL || "claude-sonnet-5";
const CALLS_PER_HOUR = 30;

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function assistReady() {
  return client !== null;
}

export async function assistAllowed(ip) {
  const key = `assist-calls:${ip}`;
  const calls = await redis.incr(key);
  if (calls === 1) await redis.expire(key, 60 * 60);
  return calls <= CALLS_PER_HOUR;
}

const CLEANUP_SYSTEM =
  "You edit the terms of a short agreement between two private individuals. " +
  "Fix spelling, grammar, punctuation, and unclear sentence structure. " +
  "Never change any name, amount, date, quantity, deadline, condition, or obligation, " +
  "and never add or remove a term. If a sentence is ambiguous, keep its original meaning " +
  "instead of guessing. Reply with only the corrected terms text: no preamble, no notes, " +
  "no quotation marks, no markdown.";

const DRAFT_SYSTEM =
  "You turn a plain, casual description of an agreement between two private individuals " +
  "into clear contract terms. Use only facts present in the description. Never invent an " +
  "amount, date, deadline, penalty, or condition; where something essential is missing, " +
  "write a bracketed blank such as [date] or [amount] for the parties to fill in. Write one " +
  "short paragraph per term in plain language. Refer to the parties by the names given, or " +
  "as Party A and Party B if names are missing. Reply with only the terms text: no title, " +
  "no preamble, no closing notes, no markdown.";

async function ask(system, userText) {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: userText }],
  });
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function cleanupTerms({ terms, contractType }) {
  return ask(CLEANUP_SYSTEM, `Contract type: ${contractType || "not given"}\n\nTerms:\n${terms}`);
}

export function draftTerms({ description, contractType, partyA, partyB }) {
  return ask(
    DRAFT_SYSTEM,
    `Contract type: ${contractType || "not given"}\n` +
      `Party A: ${partyA || "not given"}\n` +
      `Party B: ${partyB || "not given"}\n\n` +
      `Description:\n${description}`
  );
}
