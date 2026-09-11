export const MAX_QUESTION = 8000;
export const MAX_HISTORY = 16000;
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
export interface QATurn {
  id: string;
  question: string;
  answer: string;
  status: "answering" | "complete" | "stopped" | "error";
  error?: string;
}
export type AnswerEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

export function conversationHistory(turns: QATurn[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let characters = 0;
  for (const turn of turns.slice().reverse()) {
    if (turn.status !== "complete") continue;
    const size = turn.question.length + turn.answer.length;
    if (characters + size > MAX_HISTORY || result.length >= 12) break;
    result.unshift(
      { role: "user", content: turn.question },
      { role: "assistant", content: turn.answer },
    );
    characters += size;
  }
  return result;
}

/** Decode text lines across arbitrary network packets, including split UTF-8 characters. */
export async function* streamLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        yield buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 262144) throw new Error("Stream event is too large.");
      if (done) {
        if (buffer) yield buffer.replace(/\r$/, "");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
