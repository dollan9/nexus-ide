/**
 * Fill-in-the-middle (FAS 7.6) — kropp och beskärning för autocomplete.
 *
 * Vi skickar både `prefix`/`suffix` (Ollama-format) och en ihopsatt prompt med
 * markeringar (OpenAI/vLLM/llama.cpp-format). En server som förstår sin egen mall
 * ignorerar det andra fältet; en server som inte förstår mallar får i alla fall en
 * prompt där avgränsarna finns med, och stopp-sekvenserna gör att svaret klips rätt.
 */

import type { CompletionRequest } from "@nexus/protocol";

export interface FimMarkers {
  readonly prefix: string;
  readonly middle: string;
  readonly suffix: string;
}

/**
 * Bygger specialtoken-strängar utan att skruta dem litteralt i källan — vissa
 * verktyg normaliserar `<`- och `|`-sekvenser, och en token som skrivs om är värre
 * än en token som byggs.
 */
function specialToken(name: string): string {
  return `<|${name}|>`;
}

export const FIM_PREFIX_TOKEN = specialToken("fim_prefix");
export const FIM_MIDDLE_TOKEN = specialToken("fim_middle");
export const FIM_SUFFIX_TOKEN = specialToken("fim_suffix");
export const IM_END_TOKEN = specialToken("im_end");

/** Standard för deepseek-coder / qwen-coder / codellama FIM-familjerna. */
export const DEFAULT_FIM_MARKERS: FimMarkers = {
  prefix: FIM_PREFIX_TOKEN,
  middle: FIM_MIDDLE_TOKEN,
  suffix: FIM_SUFFIX_TOKEN,
};

/** Sekvenser som alltid avslutar en completion, oavsett modell. */
const DEFAULT_FIM_STOPS = [IM_END_TOKEN, "</endoftext>"];

export interface FimBody {
  readonly prompt: string;
  readonly suffix: string;
  readonly stops: string[];
  readonly maxTokens: number;
}

/**
 * Bygger FIM-payloaden. Ren funktion — testerna kan assertions på exakt form utan
 * att en server alls är inblandad.
 */
export function buildFimBody(
  req: CompletionRequest,
  markers: FimMarkers = DEFAULT_FIM_MARKERS,
  defaultMaxTokens = 128,
): FimBody {
  const prompt = `${markers.prefix}${req.prefix}${markers.middle}${req.suffix}`;
  const stops = [markers.middle, markers.suffix, ...DEFAULT_FIM_STOPS];
  if (req.trimUntil !== undefined && req.trimUntil.length > 0) stops.push(req.trimUntil);
  const unique = stops.filter((stop, index) => stop.length > 0 && stops.indexOf(stop) === index);
  return {
    prompt,
    suffix: req.suffix,
    stops: unique,
    maxTokens: req.maxTokens ?? defaultMaxTokens,
  };
}

/**
 * Klipper svaret vid första stopp-sekvens och tar bort markörer som läckt igenom.
 * `trimUntil` är UI:s "sluta här om du ser det här"-avgränsare.
 */
export function trimFimCompletion(text: string, stops: readonly string[], markers: FimMarkers = DEFAULT_FIM_MARKERS): string {
  let out = text;
  for (const stop of [...stops, markers.suffix]) {
    const index = out.indexOf(stop);
    if (index >= 0) out = out.slice(0, index);
  }
  for (const marker of [markers.prefix, markers.middle, markers.suffix]) {
    out = out.split(marker).join("");
  }
  return out;
}
