import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AmoClient } from "./amo-client.js";
import { loadConfig } from "./config.js";

const rl = createInterface({ input: stdin, output: stdout });
try {
  const code = (await rl.question("Paste the one-time amoCRM authorization code: ")).trim();
  if (!code) throw new Error("Authorization code is empty");
  await new AmoClient(loadConfig()).exchangeAuthorizationCode(code);
  console.log("Authorization succeeded. Tokens were stored with restricted file permissions.");
} finally {
  rl.close();
}
