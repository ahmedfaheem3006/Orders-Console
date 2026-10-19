import fs from "node:fs";
import path from "node:path";

// .env lives at the repository root, two levels above this file.
const envPath = path.resolve(import.meta.dirname, "../../.env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function readPort(): number {
  const raw = process.env.PORT ?? "3001";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

export const config = {
  port: readPort(),
};
