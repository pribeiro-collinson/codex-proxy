export const COMPACTION_PREFIX = "cxp1:";

export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

const RETAINED_CHAR_BUDGET = 20_000 * 4;

export function encodeCompactionSummary(summary: string): string {
  return COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

export function decodeCompactionSummary(encryptedContent: string): string | null {
  if (!encryptedContent.startsWith(COMPACTION_PREFIX)) return null;
  try {
    return Buffer.from(encryptedContent.slice(COMPACTION_PREFIX.length), "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function extractUserTexts(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as { type?: string; role?: string; content?: unknown };
    if (rec.type !== undefined && rec.type !== "message") continue;
    if (rec.role !== "user") continue;
    let text = "";
    if (typeof rec.content === "string") text = rec.content;
    else if (Array.isArray(rec.content)) {
      text = rec.content
        .map((block) => {
          if (!block || typeof block !== "object") return "";
          const part = block as { type?: string; text?: string };
          return (part.type === "input_text" || part.type === "text") && typeof part.text === "string"
            ? part.text
            : "";
        })
        .join("");
    }
    if (text.trim()) out.push(text);
  }
  return out;
}

export function buildCompactV1Output(userMessages: string[], summary: string): Record<string, unknown>[] {
  const selected: string[] = [];
  let remaining = RETAINED_CHAR_BUDGET;
  for (let i = userMessages.length - 1; i >= 0 && remaining > 0; i--) {
    const msg = userMessages[i];
    if (msg === undefined) continue;
    if (msg.length <= remaining) {
      selected.push(msg);
      remaining -= msg.length;
    } else {
      let tailStart = msg.length - remaining;
      if (tailStart > 0 && tailStart < msg.length) {
        const first = msg.charCodeAt(tailStart);
        if (first >= 0xdc00 && first <= 0xdfff) tailStart += 1;
      }
      selected.push(msg.slice(tailStart));
      break;
    }
  }
  selected.reverse();
  const summaryText = summary.trim() ? `${SUMMARY_PREFIX}\n${summary}` : "(no summary available)";
  const asItem = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
  return [...selected.map(asItem), asItem(summaryText)];
}
