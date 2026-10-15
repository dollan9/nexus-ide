/**
 * Små, strikt typade helpers för att skala okända JSON-svar från leverantörer.
 *
 * Regel: ingen `any`, ingen blind cast. Det vi inte kan visa med en typguard blir
 * undefined och hanteras av anroparen — så här undviker vi krascher (R5).
 */

import type { TokenUsage, ToolCall } from "./internal-types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringAt(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (obj === undefined) return undefined;
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

export function numberAt(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  if (obj === undefined) return undefined;
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanAt(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (obj === undefined) return undefined;
  const value = obj[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Innehållet i ett OpenAI-liknande message-fält kan vara en sträng eller en array av
 * content parts. Vi fogar textdelen och ignorerar det vi inte känner igen.
 */
export function flattenContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const obj = recordOf(item);
      if (obj === undefined) continue;
      const text = stringAt(obj, "text");
      if (text !== undefined) parts.push(text);
    }
    return parts.join("");
  }
  return "";
}

export function dataUrl(base64: string, mime: string): string {
  if (base64.startsWith("data:")) return base64;
  return `data:${mime};base64,${base64}`;
}

/**
 * L2-normalisering av en embeddings-vektor.
 * Råvektorer från olika servrar har olika längdskalning, vilket gör cosinuslikhet
 * opålitlig. Normaliserat gränssnitt gör RAG-delen deterministisk och testbar.
 */
export function normalizeVector(vector: readonly number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum <= 0) return vector.slice();
  const magnitude = Math.sqrt(sum);
  return vector.map((value) => value / magnitude);
}

export function normalizeVectors(vectors: readonly number[][]): number[][] {
  return vectors.map(normalizeVector);
}

export function parseVectorArray(value: unknown): number[] {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((n): n is number => typeof n === "number");
    } catch {
      return [];
    }
    return [];
  }
  if (Array.isArray(value)) return value.filter((n): n is number => typeof n === "number");
  return [];
}

export function parseJsonObject(raw: string | undefined): unknown {
  if (raw === undefined || raw.length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Delvis JSON under streaming eller skräp från servern — bevarar rådata för UI:t.
    return { raw };
  }
}

/** OpenAI-formaterade tool_calls → våra egna ToolCall-poster. */
export function parseToolCalls(value: unknown): ToolCall[] {
  return arrayOf(value).flatMap((item): ToolCall[] => {
    const call = recordOf(item);
    const fn = recordOf(call?.["function"]);
    const name = stringAt(fn, "name") ?? stringAt(call, "name");
    if (call === undefined || name === undefined) return [];
    const rawArgs = stringAt(fn, "arguments") ?? "";
    return [
      {
        callId: stringAt(call, "id") ?? name,
        name,
        args: parseJsonObject(rawArgs.length > 0 ? rawArgs : stringAt(call, "arguments")),
        rawArgs,
      },
    ];
  });
}

export function mapUsage(value: unknown): TokenUsage | undefined {
  const obj = recordOf(value);
  if (obj === undefined) return undefined;
  const prompt = numberAt(obj, "prompt_tokens") ?? numberAt(obj, "input_tokens") ?? 0;
  const completion = numberAt(obj, "completion_tokens") ?? numberAt(obj, "output_tokens") ?? 0;
  const total = numberAt(obj, "total_tokens") ?? prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return undefined;
  return { prompt, completion, total };
}

/**
 * Extraherar modell-id ur de tre /models-format vi möter:
 *   { data: [{ id }] }          OpenAI, vLLM, LM Studio, mock-servern
 *   { models: [{ name|id }] }  återförsäljare med egen form
 *   [ "a", "b" ]                llama.cpp-servern i vissa lägen
 */
export function extractModelIds(doc: unknown): string[] {
  const root = recordOf(doc);
  const candidates: unknown[] = [];
  if (Array.isArray(root?.["data"])) candidates.push(...arrayOf(root?.["data"]));
  if (Array.isArray(root?.["models"])) candidates.push(...arrayOf(root?.["models"]));
  if (Array.isArray(doc)) candidates.push(...arrayOf(doc));
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        ids.push(candidate);
      }
      continue;
    }
    const obj = recordOf(candidate);
    const id = stringAt(obj, "id") ?? stringAt(obj, "name") ?? stringAt(obj, "model");
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0 && Array.isArray(root?.["data"]) === false && Array.isArray(root?.["models"]) === false) {
    // Okänt format: loggas men får appen att fortsätta med konfigurerade modeller.
    return [];
  }
  return ids;
}

export function extractModelRecords(doc: unknown): Record<string, unknown>[] {
  const root = recordOf(doc);
  const raw: unknown[] = [];
  if (Array.isArray(root?.["data"])) raw.push(...arrayOf(root["data"]));
  else if (Array.isArray(root?.["models"])) raw.push(...arrayOf(root["models"]));
  else if (Array.isArray(doc)) raw.push(...arrayOf(doc));
  return raw.filter(isRecord);
}

/**
 * Klipper en completion vid första förekomst av någon stoppsekvens. Servrar gör
 * inte alltid detta själva, och autocomplete får aldrig innehålla överflödig text.
 */
export function cutAtStop(text: string, stops: readonly string[]): string {
  if (text.length === 0) return text;
  let cut = text.length;
  for (const stop of stops) {
    if (stop.length === 0) continue;
    const index = text.indexOf(stop);
    if (index >= 0 && index < cut) cut = index;
  }
  return text.slice(0, cut);
}

export function estimateVramMb(sizeBytes: number | undefined): number | undefined {
  if (sizeBytes === undefined || sizeBytes <= 0) return undefined;
  // 1,15x model filstorlek är vår lokala tumregel för viktarna plus KV-cache.
  return Math.round((sizeBytes / (1024 * 1024)) * 1.15);
}

