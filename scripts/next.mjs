import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const command = process.argv[2];
if (!["build", "start", "dev"].includes(command)) throw new Error("Unsupported Next command");
const extra = process.argv.slice(3);
const args = [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), command];
if (command !== "build") { args.push("--hostname", "127.0.0.1"); if (!extra.includes("--port") && !extra.includes("-p")) args.push("--port", "3210"); }
args.push(...extra);
const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
