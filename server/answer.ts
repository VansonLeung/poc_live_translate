import type { Request, Response } from "express";
import type { SettingsStore } from "./settings";
import { languageName, targetLanguages } from "../shared/languages";
import {
  MAX_HISTORY,
  MAX_QUESTION,
  streamLines,
  type AnswerEvent,
  type ChatMessage,
} from "../shared/qa";

/** Hide providers' optional inline reasoning, even when tags span packets. */
class AnswerText {
  private pending = "";
  private hidden = false;
  push(text: string, final = false) {
    this.pending += text;
    let output = "";
    while (this.pending) {
      const tag = this.hidden ? "</think>" : "<think>";
      const index = this.pending.indexOf(tag);
      if (index >= 0) {
        if (!this.hidden) output += this.pending.slice(0, index);
        this.pending = this.pending.slice(index + tag.length);
        this.hidden = !this.hidden;
        continue;
      }
      let keep = 0;
      if (!final)
        for (let n = 1; n < tag.length; n++)
          if (this.pending.endsWith(tag.slice(0, n))) keep = n;
      if (!this.hidden)
        output += this.pending.slice(0, this.pending.length - keep);
      this.pending = keep ? this.pending.slice(-keep) : "";
      break;
    }
    return output;
  }
}

export function answerHandler(
  settings: SettingsStore,
  fetchProvider: typeof fetch,
) {
  return async (req: Request, res: Response) => {
    const { question, history = [], language = "auto" } = req.body ?? {};
    if (
      typeof question !== "string" ||
      !question.trim() ||
      question.length > MAX_QUESTION ||
      !Array.isArray(history) ||
      history.length > 12 ||
      history.length % 2 ||
      history.some(
        (m, i) =>
          !m ||
          m.role !== (i % 2 ? "assistant" : "user") ||
          typeof m.content !== "string" ||
          !m.content.trim(),
      ) ||
      history.reduce((n, m) => n + m.content.length, 0) > MAX_HISTORY ||
      (language !== "auto" &&
        !targetLanguages.some((l) => l.value === language))
    ) {
      res
        .status(400)
        .json({
          error:
            "Provide a question up to 8,000 characters, valid conversation history, and an answer language.",
        });
      return;
    }
    const provider = settings.get().llm;
    if (!provider.baseUrl) {
      res
        .status(400)
        .json({ error: "Configure the LLM endpoint in Connections first." });
      return;
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120000),
    ]);
    const send = (event: AnswerEvent) => {
      if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
    };
    let upstream: globalThis.Response | undefined;
    try {
      upstream = await fetchProvider(
        `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            ...(provider.key
              ? { Authorization: `Bearer ${provider.key}` }
              : {}),
          },
          body: JSON.stringify({
            model: provider.model,
            stream: true,
            temperature: 0.3,
            max_tokens: 2048,
            chat_template_kwargs: { enable_thinking: false },
            messages: [
              {
                role: "system",
                content: `You are a conversational question-answering assistant. Answer the user's question directly and concisely. Use the conversation for follow-up context. Ask for clarification when necessary; acknowledge uncertainty instead of inventing facts. You have no web browsing or document access. ${language === "auto" ? "Answer in the language of the latest question." : `Answer in ${languageName(language)}.`} Return the answer without internal reasoning or think tags.`,
              },
              ...history.map((m: ChatMessage) => ({
                role: m.role,
                content: m.content,
              })),
              { role: "user", content: question.trim() },
            ],
          }),
        },
      );
      if (!upstream.ok) {
        res
          .status(502)
          .json({
            error: `LLM provider returned HTTP ${upstream.status}. Check Connections and model availability.`,
          });
        return;
      }
      if (!upstream.body) throw new Error("Empty stream");
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      const filter = new AnswerText();
      let answer = "";
      let finished = false;
      let truncated = false;
      const append = (content: unknown, final = false) => {
        const text = filter.push(
          typeof content === "string" ? content : "",
          final,
        );
        answer += text;
        if (answer.length > 32000) throw new Error("Answer limit");
        if (text) send({ type: "delta", text });
      };
      const accept = (data: string) => {
        if (data.trim() === "[DONE]") {
          finished = true;
          return;
        }
        const event = JSON.parse(data);
        if (event.error) throw new Error("Provider stream error");
        const choice = event.choices?.[0];
        append(choice?.delta?.content);
        if (choice?.finish_reason === "length") truncated = true;
        if (
          choice?.finish_reason === "stop" ||
          choice?.finish_reason === "length"
        )
          finished = true;
        if (
          choice?.finish_reason &&
          !["stop", "length"].includes(choice.finish_reason)
        )
          throw new Error("Unsupported completion");
      };
      if (upstream.headers.get("content-type")?.includes("application/json")) {
        const body = await upstream.json();
        append(body.choices?.[0]?.message?.content);
        truncated = body.choices?.[0]?.finish_reason === "length";
        finished = true;
      } else {
        let data: string[] = [];
        for await (const line of streamLines(upstream.body)) {
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          else if (!line && data.length) {
            accept(data.join("\n"));
            data = [];
            if (finished) break;
          }
        }
        if (data.length && !finished) accept(data.join("\n"));
      }
      append("", true);
      if (!finished) throw new Error("Incomplete stream");
      if (truncated)
        send({
          type: "error",
          error:
            "Answer reached the response limit. Ask again with a narrower question.",
        });
      else if (!answer.trim())
        send({
          type: "error",
          error: "The model returned no answer. Please retry.",
        });
      else send({ type: "done" });
    } catch {
      const error =
        "Answer failed or timed out. Check the LLM connection and retry.";
      if (!res.destroyed) {
        if (res.headersSent) send({ type: "error", error });
        else res.status(502).json({ error });
      }
    } finally {
      controller.abort();
      await upstream?.body?.cancel().catch(() => {});
      if (!res.destroyed) res.end();
    }
  };
}
