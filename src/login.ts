// Login and logout: exchanges a pasted registry token for a verified identity (via
// whoami()) and stores it through credentials.ts, or removes a stored token. The token
// value itself never appears in a returned line; only writeToken/deleteToken ever see it.

import { deleteToken, writeToken } from "./credentials.js";
import { AgpmError } from "./errors.js";
import type { RegistryClient } from "./registry.js";

export async function runLogin(
  registryUrl: string,
  promptSecret: (msg: string) => Promise<string>,
  client: (token: string) => RegistryClient,
  homeDir: string,
): Promise<{ lines: string[] }> {
  const origin = new URL(registryUrl).origin;
  const token = (await promptSecret(`paste a token from ${origin}/settings/tokens: `)).trim();
  if (token === "") {
    throw new AgpmError("no token entered");
  }

  const whoami = await client(token).whoami();

  await writeToken(registryUrl, token, homeDir);

  const orgs = whoami.orgs.map((entry) => entry.org).join(", ");
  return { lines: [`logged in to ${registryUrl} as ${whoami.user} (orgs: ${orgs === "" ? "none" : orgs})`] };
}

export async function runLogout(registryUrl: string, homeDir: string): Promise<{ lines: string[] }> {
  const deleted = await deleteToken(registryUrl, homeDir);
  return { lines: [deleted ? `logged out of ${registryUrl}` : `no stored token for ${registryUrl}`] };
}
