/**
 * harden.ts — sista försäkringen innan något lämnar host (R2: ingen hemlighet
 * någonsin ut som värde).
 *
 * Två olika risker, två olika regler:
 *   1) Fält som ÄR hemligheter (`apiKey`, `token`, `password`, …) stryks ALDRIG
 *      som värde — de får inte alls följa med ut. ConfigStore och ProviderRegistry
 *      returnerar redan bara {name,isSet}, men ett framtida provider-objekt som
 *      råkar bära sin nyckel fångas här.
 *   2) Strängar som råkar innehålla ett nyckelmönster (sk-…, nvapi-…, Bearer …)
 *      maskeras via maskSecrets() — med Undantag för fält som faktiskt är
 *      användardata (filinnehåll, diffar, terminal-output, bas64-attachment). Att
 *      skriva om en användares fil i transporten vore en annan sorts fel.
 *
 * AVVIKELSE/NOTERA: maskningsverktyget bor i @nexus/providers (secrets.ts) och
 * används av core:s logger internt; core exporterar ingen egen mask-funktion, så
 * host importerar den publika `maskSecrets` från providers — samma regexp, inget
 * eget dubbelarbete.
 */

import { maskSecrets, SECRET_MASK } from "@nexus/providers";

/** Fält som får innehålla råa användardata och därför inte får skrivas om. */
const VERBATIM_FIELDS = new Set([
  "content",
  "text",
  "fulltext",
  "unified",
  "preview",
  "summary",
  "detail",
  "output",
  "stdout",
  "stderr",
  "lines",
  "body",
  "databased64",
  "pngbased64",
  "audiobased64",
  "search",
  "replace",
  "prefix",
  "suffix",
  "command",
  "args",
  "message",
  "title",
  "label",
  "note",
  "hint",
  "code",
  "instruction",
  "query",
  "find",
  "path",
  "url",
]);

/** Fält som aldrig får lämna host som värde, oavsett innehåll. */
const SECRET_FIELDS = new Set([
  "apikey",
  "apikeyvalue",
  "key",
  "secret",
  "secretvalue",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "password",
  "passphrase",
  "clientsecret",
  "xapikey",
  "proxyauthorization",
  "bearer",
  "credentials",
]);

/** `apiKeyEnvName`/`keyEnvName` är NAMN, inte värden — de får passera. */
function isNameField(lower: string): boolean {
  return lower.endsWith("name") || lower.endsWith("envname") || lower.endsWith("keyname");
}

const MAX_DEPTH = 12;

function classifyKey(key: string): { drop: boolean; verbatim: boolean } {
  const lower = key.toLowerCase().replace(/[^a-z]/g, "");
  if (!isNameField(lower) && SECRET_FIELDS.has(lower)) return { drop: true, verbatim: false };
  return { drop: false, verbatim: VERBATIM_FIELDS.has(lower) };
}

function isRecord(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}

/**
 * Djup kopia som tar bort sekretfält och maskerar strängar (utom användardata).
 * Returnerar okänd och är aldrig kastbar: cirkulära referenser stoppas av
 * djupgräns, oförändrade löften (funktionar, symboler).blir null.
 */
export function hardenValue(value: unknown, keyHint?: string, depth = 0): unknown {
  const flags = keyHint === undefined ? { drop: false, verbatim: false } : classifyKey(keyHint);
  if (flags.drop && typeof value === "string" && value.length > 0) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return flags.verbatim ? value : maskSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[fördjupad structure trunkerad]";
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const hardened = hardenValue(item, keyHint, depth + 1);
      if (hardened !== undefined) out.push(hardened);
    }
    return out;
  }
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const hardened = hardenValue(entry, key, depth + 1);
    if (hardened === undefined) continue;
    result[key] = hardened;
  }
  return result;
}

/**
 * Fel och events går genom samma vakt, men med hårde regel: ett fel-
 * meddelande är ALDRIG användardata och maskeras därför alltid.
 */
export function hardenMessage(message: string): string {
  return maskSecrets(message);
}

/**
 * Fräsande kontroll använd i tester och i WS-transportens logning: finns ett
 * verkligt hemligt mönster kvar i det som ska ut?
 */
export function containsSecretShape(value: unknown): boolean {
  const probe = typeof value === "string" ? value : safeStringify(value);
  return /(\b(?:sk|sk-ant|nvapi|pk)-[A-Za-z0-9_-]{4,})|(\bBearer\s+[A-Za-z0-9._-]{8,})/i.test(probe);
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[okunnig struktur]";
  }
}

/** For diagnostics: returnerar vilka sekretfalt som stryks fran en payload. */
export function droppedSecretFields(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, key: string | undefined, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (typeof key === "string" && classifyKey(key).drop && typeof node === "string" && node.length > 0) {
      found.push(key);
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key, depth + 1);
      return;
    }
    if (node !== null && typeof node === "object" && isRecord(node)) {
      for (const [childKey, child] of Object.entries(node)) walk(child, childKey, depth + 1);
    }
  };
  walk(value, undefined, 0);
  return found;
}

export const SECRET_MASK_TOKEN = SECRET_MASK;
