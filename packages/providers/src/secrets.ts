/**
 * Hemlighetshygien (R2 — ingen mjuk start).
 *
 * En nyckel får aldrig skrivas till logg, felmeddelande eller testutskrift. Eftersom
 * transportfel kan innehålla hela request-dumpar (proxys och Someproviders gör det)
 * maskerar vi *allt* som passerar loggningslagret — inte bara de ställen vi rå kommer på.
 */

/** Ersättningssträngen är medvetet igenkännbar så tester kan hävda att den används. */
export const SECRET_MASK = "***REDACTED***";

/**
 * Mönster för de format som faktiskt förekommer hos våra leverantörer:
 *   sk-… / sk-ant-… / nvapi-… / pk-…   OpenAI, Anthropic, NVIDIA NIM, OpenRouter
 *   Bearer <token>                      alla bearer-scheman
 *   "api_key": "…"                      JSON-kroppar
 *   ?api_key=… / &key=…                 query-strängar (Google, OpenRouter)
 *   Authorization: … / x-api-key: …     headrar
 * Ordningen spelar roll: strukturella mönster först, råa nyckelmönster sist.
 */
export function maskSecrets(input: string): string {
  if (input.length === 0) return input;
  let out = input;
  // 1) JSON-fält: "api_key": "<värde>"
  out = out.replace(
    /("(?:api_?key|apikey|access_token|authorization|client_secret|x-api-key)"\s*:\s*")([^"]{3,})(")/gi,
    (_whole, open: string, _value: string, close: string) => `${open}${SECRET_MASK}${close}`,
  );
  // 2) query-sträng: ?api_key=<värde> eller &key=<värde>
  out = out.replace(
    /([?&](?:api_?key|access_token|token|key)=)([^&\s"']{3,})/gi,
    (_whole, prefix: string) => `${prefix}${SECRET_MASK}`,
  );
  // 3) huvudrad-form: "x-api-key: <värde>"
  out = out.replace(
    /\b(x-api-key|proxy-authorization)\s*:\s*([^\r\n"'{}]{3,})/gi,
    (_whole, name: string) => `${name}: ${SECRET_MASK}`,
  );
  // 4) Bearer-token
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+\/=]{4,}/gi, () => `Bearer ${SECRET_MASK}`);
  // 5) prefixade råa nycklar — fångar resten, inklusive nycklar inuti text
  out = out.replace(/\b(?:sk-ant-|sk-|pk-|nvapi-|key-)[A-Za-z0-9_\-]{3,}\b/g, () => SECRET_MASK);
  return out;
}

/** Headrar är den vanligaste läckagevägen — vi maskerar dem alltid, utan undantag. */
const SECRET_HEADER_NAMES = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "proxy-authorization",
  "openai-api-key",
];

export function maskHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADER_NAMES.includes(name.toLowerCase()) ? SECRET_MASK : maskSecrets(value);
  }
  return out;
}

/**
 * Fräsande kontroll: hittar texten ett hemligt mönster?
 * Används i tester för att hävda att en loggrad faktiskt är ren.
 */
export function looksLikeSecretLeak(input: string): boolean {
  return (
    /\b(?:sk|sk-ant|nvapi|pk)-[A-Za-z0-9_\-]{4,}/i.test(input) ||
    /\bBearer\s+[A-Za-z0-9._\-]{8,}/i.test(input) ||
    /[?&](?:api_?key|key)=[A-Za-z0-9_\-]{8,}/i.test(input)
  );
}
