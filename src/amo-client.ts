import type { AppConfig } from "./config.js";
import { TokenStore, type AmoTokens } from "./token-store.js";

type Json = Record<string, unknown>;

export class AmoClient {
  private refreshInFlight?: Promise<AmoTokens>;

  constructor(
    private readonly config: AppConfig,
    private readonly store = new TokenStore(config.tokenFile),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async exchangeAuthorizationCode(code: string): Promise<void> {
    if (this.config.longLivedToken) {
      throw new Error("Authorization-code exchange is disabled when AMO_LONG_LIVED_TOKEN is set");
    }
    const payload = await this.exchange({
      grant_type: "authorization_code",
      code,
    });
    await this.store.write(payload);
  }

  async get<T = Json>(pathName: string, params: URLSearchParams = new URLSearchParams()): Promise<T> {
    if (!pathName.startsWith("/api/v4/")) throw new Error("Only amoCRM API v4 reads are allowed");
    const accessToken = this.config.longLivedToken || (await this.validToken()).access_token;
    const url = new URL(pathName, this.config.amoBaseUrl);
    url.search = params.toString();

    let response = await this.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 401 && !this.config.longLivedToken) {
      const refreshed = await this.refresh(true);
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${refreshed.access_token}` },
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`amoCRM GET ${pathName} failed (${response.status}): ${body.slice(0, 500)}`);
    }
    return (await response.json()) as T;
  }

  private async validToken(): Promise<AmoTokens> {
    const token = await this.store.read();
    if (token.expires_at > Math.floor(Date.now() / 1000) + 120) return token;
    return this.refresh();
  }

  private async refresh(force = false): Promise<AmoTokens> {
    if (this.refreshInFlight && !force) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const current = await this.store.read();
      if (!force && current.expires_at > Math.floor(Date.now() / 1000) + 120) return current;
      const next = await this.exchange({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
      });
      await this.store.write(next);
      return next;
    })();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async exchange(extra: Record<string, string>): Promise<AmoTokens> {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.redirectUri) {
      throw new Error("OAuth credentials are not configured");
    }
    const response = await this.fetchImpl(`${this.config.amoBaseUrl}/oauth2/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        ...extra,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`amoCRM OAuth failed (${response.status}): ${body.slice(0, 500)}`);
    }
    const result = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type?: string;
      server_time?: number;
    };
    return {
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_at: (result.server_time || Math.floor(Date.now() / 1000)) + result.expires_in,
      token_type: result.token_type || "Bearer",
    };
  }
}
