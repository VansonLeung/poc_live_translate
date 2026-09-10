export interface Provider {
  baseUrl: string;
  key: string;
  model: string;
}
export interface Configuration {
  asr: Provider;
  llm: Provider;
}
export interface PublicProvider {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}
export interface PublicSettings {
  asr: PublicProvider;
  llm: PublicProvider;
  storage: string;
}
export interface ProviderInput {
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
}
export interface SettingsInput {
  asr: ProviderInput;
  llm: ProviderInput;
}
export interface AppConfiguration {
  asrModel: string;
  llmModel: string;
  configured?: boolean;
  desktop?: boolean;
  platform?: string;
}
