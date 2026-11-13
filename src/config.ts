import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export type AppConfig = {
  amoBaseUrl: string;
  longLivedToken?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  tokenFile: string;
  host: string;
  port: number;
};

export function loadConfig(): AppConfig {
  const amoBaseUrl = required("AMO_BASE_URL").replace(/\/$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.amocrm\.ru$/i.test(amoBaseUrl)) {
    throw new Error("AMO_BASE_URL must look like https://your-account.amocrm.ru");
  }

  const longLivedToken = process.env.AMO_LONG_LIVED_TOKEN?.trim();
  const clientId = process.env.AMO_CLIENT_ID?.trim();
  const clientSecret = process.env.AMO_CLIENT_SECRET?.trim();
  const redirectUri = process.env.AMO_REDIRECT_URI?.trim();
  if (!longLivedToken && (!clientId || !clientSecret || !redirectUri)) {
    throw new Error(
      "Set AMO_LONG_LIVED_TOKEN, or set AMO_CLIENT_ID, AMO_CLIENT_SECRET and AMO_REDIRECT_URI",
    );
  }

  return {
    amoBaseUrl,
    longLivedToken,
    clientId,
    clientSecret,
    redirectUri,
    tokenFile: path.resolve(process.env.AMO_TOKEN_FILE || "/data/amocrm-tokens.json"),
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: Number(process.env.PORT || 3000),
  };
}
