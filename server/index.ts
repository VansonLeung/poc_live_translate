import "dotenv/config";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app";
import { environmentConfiguration, SettingsStore } from "./settings";

const settings = new SettingsStore(environmentConfiguration(), {
  path: resolve(process.env.SETTINGS_FILE ?? ".local/settings.json"),
  label: "Local server settings file",
});
const app = createApp(settings);
const dist = resolve("dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) => {
    res.sendFile(resolve(dist, "index.html"));
  });
}
app.listen(6006, "127.0.0.1", () =>
  console.log("Live Translate API: http://127.0.0.1:6006"),
);
