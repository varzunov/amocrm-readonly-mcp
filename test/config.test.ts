import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const keys = [
  "AMO_BASE_URL",
  "AMO_LONG_LIVED_TOKEN",
  "AMO_CLIENT_ID",
  "AMO_CLIENT_SECRET",
  "AMO_REDIRECT_URI",
] as const;

function withEnv(values: Partial<Record<(typeof keys)[number], string>>, fn: () => void) {
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try {
    fn();
  } finally {
    for (const key of keys) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("accepts a long-lived token without OAuth credentials", () => {
  withEnv({ AMO_BASE_URL: "https://example.amocrm.ru", AMO_LONG_LIVED_TOKEN: "token" }, () => {
    const config = loadConfig();
    assert.equal(config.longLivedToken, "token");
    assert.equal(config.clientId, undefined);
  });
});

test("requires either a long-lived token or a complete OAuth configuration", () => {
  withEnv({ AMO_BASE_URL: "https://example.amocrm.ru" }, () => {
    assert.throws(() => loadConfig(), /AMO_LONG_LIVED_TOKEN/);
  });
});
