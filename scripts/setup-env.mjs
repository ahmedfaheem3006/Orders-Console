// Creates .env from .env.example with a freshly generated JWT_SECRET.
// Never overwrites an existing .env. Prints no secret.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

if (fs.existsSync(envPath)) {
  console.log(".env already exists; left unchanged.");
} else {
  const example = fs.readFileSync(examplePath, "utf8");
  const secret = randomBytes(32).toString("hex"); // 64 hex characters
  if (!/^JWT_SECRET=$/m.test(example)) throw new Error(".env.example must contain an empty JWT_SECRET= line");
  fs.writeFileSync(envPath, example.replace(/^JWT_SECRET=$/m, `JWT_SECRET=${secret}`));
  console.log("Created .env with a new random JWT_SECRET.");
}
