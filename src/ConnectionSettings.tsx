import { useEffect, useState } from "react";
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Space,
  Spin,
} from "antd";
import type {
  ProviderInput,
  PublicSettings,
  SettingsInput,
} from "../shared/settings";

export default function ConnectionSettings({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm<SettingsInput>();
  const [saved, setSaved] = useState<PublicSettings>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState<"asr" | "llm">();
  const [checks, setChecks] = useState<
    Partial<
      Record<"asr" | "llm", { ok: boolean; text: string; models?: string[] }>
    >
  >({});
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setChecks({});
    setSaved(undefined);
    form.resetFields();
    fetch("/api/settings", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Could not load connection settings.");
        const settings: PublicSettings = await response.json();
        setSaved(settings);
        form.setFieldsValue({
          asr: {
            baseUrl: settings.asr.baseUrl,
            model: settings.asr.model,
            apiKey: "",
            clearApiKey: false,
          },
          llm: {
            baseUrl: settings.llm.baseUrl,
            model: settings.llm.model,
            apiKey: "",
            clearApiKey: false,
          },
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, form]);
  const check = async (kind: "asr" | "llm") => {
    try {
      await form.validateFields([
        [kind, "baseUrl"],
        [kind, "model"],
      ]);
      setChecking(kind);
      const provider: ProviderInput = form.getFieldValue(kind);
      const response = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, provider }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Connection failed.");
      setChecks((current) => ({
        ...current,
        [kind]: {
          ok: result.modelFound,
          text: result.modelFound
            ? `Connected. Model listed (${result.elapsedMs} ms).`
            : "Connected, but this model is not listed. Check the model ID.",
          models: result.models,
        },
      }));
    } catch (error) {
      if (error instanceof Error)
        setChecks((current) => ({
          ...current,
          [kind]: { ok: false, text: error.message },
        }));
    } finally {
      setChecking(undefined);
    }
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      setError("");
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not save settings.");
      form.resetFields();
      onSaved();
      onClose();
    } catch (error) {
      if (error instanceof Error) setError(error.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Connections"
      open={open}
      onCancel={onClose}
      width={620}
      maskClosable={!saving && !checking}
      closable={!saving && !checking}
      footer={
        <Space>
          <Button disabled={saving || Boolean(checking)} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={() => void save()}
            loading={saving}
            disabled={loading || !saved || Boolean(checking)}
          >
            Save connections
          </Button>
        </Space>
      }
    >
      {error && <Alert type="error" showIcon title={error} />}
      <Spin spinning={loading}>
        <Form
          form={form}
          layout="vertical"
          disabled={loading || saving || Boolean(checking)}
          onValuesChange={(changed) =>
            setChecks((current) => ({
              ...current,
              ...Object.fromEntries(
                Object.keys(changed).map((key) => [key, undefined]),
              ),
            }))
          }
        >
          {(["asr", "llm"] as const).map((kind) => (
            <section className="connection-section" key={kind}>
              <h3>
                {kind === "asr"
                  ? "Speech recognition (ASR)"
                  : "Translation (LLM)"}
              </h3>
              <Form.Item
                name={[kind, "baseUrl"]}
                label="API base URL"
                htmlFor={`${kind}-base-url`}
                rules={[
                  { required: true, message: "Enter the API base URL." },
                  { type: "url", message: "Enter a valid HTTP or HTTPS URL." },
                ]}
                extra="Include the API prefix, for example https://server.example/v1."
              >
                <Input
                  id={`${kind}-base-url`}
                  autoComplete="off"
                  placeholder="https://server.example/v1"
                />
              </Form.Item>
              <Form.Item
                name={[kind, "model"]}
                label="Model ID"
                htmlFor={`${kind}-model`}
                rules={[
                  {
                    required: true,
                    whitespace: true,
                    message: "Enter the model ID.",
                  },
                ]}
              >
                <AutoComplete
                  id={`${kind}-model`}
                  options={checks[kind]?.models?.map((value) => ({ value }))}
                  placeholder={
                    kind === "asr"
                      ? "Qwen3-ASR-1.7B-bf16"
                      : "Qwen3.5-35B-A3B-4bit"
                  }
                />
              </Form.Item>
              <Form.Item
                name={[kind, "apiKey"]}
                label="API key"
                htmlFor={`${kind}-api-key`}
                extra={
                  saved?.[kind].hasKey
                    ? "Leave blank to keep the saved key. Changing the URL clears it unless you enter a key again."
                    : "Optional for endpoints that do not require authentication."
                }
              >
                <Input.Password
                  id={`${kind}-api-key`}
                  autoComplete="new-password"
                  placeholder={saved?.[kind].hasKey ? "Saved key" : "Optional"}
                />
              </Form.Item>
              {saved?.[kind].hasKey && (
                <Form.Item name={[kind, "clearApiKey"]} valuePropName="checked">
                  <Checkbox>Remove saved API key</Checkbox>
                </Form.Item>
              )}
              <Button
                onClick={() => void check(kind)}
                loading={checking === kind}
                disabled={Boolean(checking) || loading || saving}
              >
                {kind === "asr" ? "Test ASR connection" : "Test LLM connection"}
              </Button>
              {checks[kind] && (
                <Alert
                  className="connection-result"
                  showIcon
                  type={checks[kind]!.ok ? "success" : "warning"}
                  title={checks[kind]!.text}
                />
              )}
            </section>
          ))}
          <p className="settings-note">
            OpenAI-compatible APIs. Connection tests check the model list; they
            do not run inference. Storage: {saved?.storage ?? "…"}.
          </p>
        </Form>
      </Spin>
    </Modal>
  );
}
