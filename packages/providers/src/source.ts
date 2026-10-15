/**
 * Källklassificering — sandheten om var ett svar kommer ifrån.
 *
 * Enligt CONVENTIONS §"Äkthet i tester" får ingen som returnerar modellavtryck påstå
 * att en riktig modell svarade. Därför är det här den enda platsen som bestämmer
 * `ModelSource`, och en test-adapter måste uttryckligen ange `"stub"`.
 */

import type { ModelSource } from "@nexus/protocol";

/** IPv4-private nät, enl. RFC1918 (192.168/16, 10/8, 172.16/12) plus loopback. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]", "::ffff:127.0.0.1"]);

/**
 * `classifySource(baseUrl)` → "local" för loopback och 192.168.x, i övrigt "cloud".
 * Slår också 127.0.0.1:* (hamnar i URL:ens host-del med port — vi klipper bort den).
 */
export function classifySource(baseUrl: string): "local" | "cloud" {
  const host = hostOf(baseUrl);
  if (host === undefined || host.length === 0) return "cloud";
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOCAL_HOSTS.has(bare) || LOCAL_HOSTS.has(host.toLowerCase())) return "local";
  if (bare === "localhost" || bare.endsWith(".localhost")) return "local";
  if (bare.startsWith("127.")) return "local";
  if (bare.startsWith("192.168.")) return "local";
  if (bare.startsWith("10.")) return "local";
  if (isPrivate172(bare)) return "local";
  if (bare === "host.docker.internal") return "local";
  if (bare.startsWith("::ffff:127.")) return "local";
  return "cloud";
}

function isPrivate172(bare: string): boolean {
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts[0] !== "172") return false;
  const second = Number(parts[1] ?? "0");
  return second >= 16 && second <= 31;
}

/**
 * Extraherar host utan port. Försöker URL-parsaren och faller på rak stränghantering
 * för de "127.0.0.1:11434"-format som förekommer i config utan schema.
 */
export function hostOf(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return "";
  try {
    const url = new URL(trimmed);
    return url.hostname;
  } catch {
    const withoutScheme = trimmed.replace(/^[a-z]+:\/\//i, "");
    const hostPart = withoutScheme.split(/[/?#]/)[0] ?? "";
    if (hostPart.startsWith("[")) {
      const end = hostPart.indexOf("]");
      return end > 0 ? hostPart.slice(0, end + 1) : hostPart;
    }
    return hostPart.split(":")[0] ?? "";
  }
}

/**
 * Källan för ett faktiskt svar. Adapters anropar den här med sin eigen baseUrl och
 * sin eventuella `sourceOverride` (test-dockor sätter "stub").
 */
export function sourceForResponse(baseUrl: string, override?: ModelSource): ModelSource {
  if (override === "stub") return "stub";
  if (override === "none") return "none";
  if (override === "local" || override === "cloud") return override;
  return classifySource(baseUrl);
}

/** Källan för en modell-nivåpost (ModelEntry) — lokala modeller är alltid "local". */
export function sourceForModel(baseUrl: string, override?: ModelSource): ModelSource {
  return sourceForResponse(baseUrl, override);
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  return classifySource(baseUrl) === "local";
}
