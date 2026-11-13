import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AmoTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
};

export class TokenStore {
  constructor(private readonly file: string) {}

  async read(): Promise<AmoTokens> {
    const raw = await readFile(this.file, "utf8");
    const parsed = JSON.parse(raw) as Partial<AmoTokens>;
    if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_at) {
      throw new Error("Token file is incomplete. Run the authorization command first.");
    }
    return parsed as AmoTokens;
  }

  async write(tokens: AmoTokens): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }
}
