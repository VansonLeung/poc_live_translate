import electronPath from "electron";
import { spawn } from "node:child_process";

// Electron-based IDEs may export this flag to child shells; the desktop needs GUI mode.
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [".", ...process.argv.slice(2)], { stdio: "inherit", env: environment });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
