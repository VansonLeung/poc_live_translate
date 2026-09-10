import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Configuration,
  Provider,
  PublicSettings,
  SettingsInput,
} from "../shared/settings";

export function environmentConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Configuration {
  const provider = (prefix: string, model: string): Provider => ({
    baseUrl: env[`${prefix}_BASE_URL`] ?? "",
    key: env[`${prefix}_API_KEY`] ?? "",
    model: env[`${prefix}_MODEL`] ?? model,
  });
  return {
    asr: provider("ASR", "Qwen3-ASR-1.7B-bf16"),
    llm: provider("LLM", "Qwen3.5-35B-A3B-4bit"),
  };
}
export function normalizeProvider(
  input: unknown,
  previous: Provider,
): Provider {
  if (!input || typeof input !== "object")
    throw new Error("Provider settings are required.");
  const value = input as Record<string, unknown>;
  if (typeof value.baseUrl !== "string" || typeof value.model !== "string")
    throw new Error("Endpoint URL and model are required.");
  let url: URL;
  try {
    url = new URL(value.baseUrl.trim());
  } catch {
    throw new Error("Endpoint must be a valid HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.",
    );
  const baseUrl = url.toString().replace(/\/+$/, "");
  const model = value.model.trim();
  if (!model || model.length > 256)
    throw new Error("Enter a model ID of up to 256 characters.");
  if (
    value.apiKey !== undefined &&
    (typeof value.apiKey !== "string" ||
      value.apiKey.length > 4096 ||
      /[\r\n]/.test(value.apiKey))
  )
    throw new Error("Invalid API key.");
  if (value.clearApiKey !== undefined && typeof value.clearApiKey !== "boolean")
    throw new Error("Invalid API key option.");
  // A changed endpoint must never inherit the previous endpoint's secret.
  const unchangedEndpoint = baseUrl === previous.baseUrl.replace(/\/+$/, "");
  const key = value.clearApiKey
    ? ""
    : (value.apiKey as string | undefined)?.trim() ||
      (unchangedEndpoint ? previous.key : "");
  return { baseUrl, model, key };
}
export interface StorageOptions {
  path?: string;
  label?: string;
  encode?: (value: string) => Buffer;
  decode?: (value: Buffer) => string;
}
export class SettingsStore {
  private config: Configuration;
  constructor(
    defaults: Configuration,
    private storage: StorageOptions = {},
  ) {
    this.config = structuredClone(defaults);
    if (storage.path && existsSync(storage.path)) {
      try {
        const raw = readFileSync(storage.path);
        const saved = JSON.parse(
          storage.decode ? storage.decode(raw) : raw.toString("utf8"),
        );
        this.config = {
          asr: normalizeProvider(
            { ...saved.asr, apiKey: saved.asr?.key },
            { ...defaults.asr, key: "" },
          ),
          llm: normalizeProvider(
            { ...saved.llm, apiKey: saved.llm?.key },
            { ...defaults.llm, key: "" },
          ),
        };
      } catch {
        throw new Error(
          "Saved connection settings could not be read. Restore or move the settings file before restarting.",
        );
      }
    }
  }
  get(): Configuration {
    return structuredClone(this.config);
  }
  public(): PublicSettings {
    const view = ({ baseUrl, model, key }: Provider) => ({
      baseUrl,
      model,
      hasKey: Boolean(key),
    });
    return {
      asr: view(this.config.asr),
      llm: view(this.config.llm),
      storage: this.storage.label ?? "This session",
    };
  }
  resolve(input: unknown, kind: "asr" | "llm") {
    return normalizeProvider(input, this.config[kind]);
  }
  save(input: SettingsInput): PublicSettings {
    const next = {
      asr: this.resolve(input?.asr, "asr"),
      llm: this.resolve(input?.llm, "llm"),
    };
    if (this.storage.path) {
      const text = JSON.stringify(next, null, 2);
      const bytes = this.storage.encode
        ? this.storage.encode(text)
        : Buffer.from(text);
      mkdirSync(dirname(this.storage.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.storage.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, bytes, { mode: 0o600 });
      renameSync(temporary, this.storage.path);
      if (process.platform !== "win32") chmodSync(this.storage.path, 0o600);
    }
    this.config = next;
    return this.public();
  }
}
