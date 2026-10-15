/**
 * errors.ts — fel- och nedbrytningskontrakt inuti host (CONVENTIONS §Fel och nedbrytning).
 *
 * Ingen metod i host får kasta råa fel till transporten. Allt som kastas inuti en
 * handler måste vara ett HostError (med ErrorCode) eller bli ett: okända fel blir
 * Internal med maskerat meddelande, aldrig ett stack trace till renderer.
 */

import { ErrorCode, type ErrorCodeValue } from "@nexus/protocol";
import { AiServiceError } from "@nexus/core";
import { ProviderError } from "@nexus/providers";
import { maskSecrets } from "@nexus/providers";
import { McpConfigError } from "@nexus/mcp-client";

/** Ett fel som redan vet vilken ErrorCode UI:t ska rendera. */
export class HostError extends Error {
  readonly code: ErrorCodeValue;
  readonly data?: unknown;

  constructor(code: ErrorCodeValue, message: string, data?: unknown) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.data = data;
  }

  static badRequest(message: string, data?: unknown): HostError {
    return new HostError(ErrorCode.BadRequest, message, data);
  }

  static invalidParams(message: string, data?: unknown): HostError {
    return new HostError(ErrorCode.InvalidParams, message, data);
  }

  static internal(message: string, data?: unknown): HostError {
    return new HostError(ErrorCode.Internal, message, data);
  }

  static methodNotFound(method: string): HostError {
    return new HostError(ErrorCode.MethodNotFound, `Metoden finns inte i protocol: ${method}`, { method });
  }

  static checkpointMissing(id: string): HostError {
    return new HostError(ErrorCode.CheckpointNotFound, `Checkpoint finns inte: ${id}`, { id });
  }

  static noModel(message: string, data?: unknown): HostError {
    return new HostError(ErrorCode.NoModelAvailable, message, data);
  }

  static approvalDenied(message: string, data?: unknown): HostError {
    return new HostError(ErrorCode.ApprovalDenied, message, data);
  }
}

export interface RpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Normalisering av vad som helst till ett transport-säkert felobjekt.
 * Ordningen spelar roll: de specifika lagertyperna först, råa fel sist.
 */
export function toRpcError(err: unknown, fallbackMethod?: string): RpcErrorPayload {
  if (err instanceof HostError) {
    return { code: err.code, message: maskSecrets(err.message), data: err.data };
  }
  if (err instanceof ProviderError) {
    const mapped = err.toRpcError();
    return { code: mapped.code, message: maskSecrets(err.userMessage() === mapped.message ? mapped.message : `${mapped.message}: ${err.userMessage()}`), data: mapped.data };
  }
  if (err instanceof AiServiceError) {
    return { code: err.code === ErrorCode.RateLimited ? ErrorCode.RateLimited : ErrorCode.AiServiceOffline, message: maskSecrets(err.message) };
  }
  if (err instanceof McpConfigError) {
    return { code: ErrorCode.BadRequest, message: maskSecrets(err.message), data: { issues: err.issues.slice(0, 12) } };
  }
  if (err instanceof Error) {
    const code = classifyKnownMessage(err.message);
    return { code, message: maskSecrets(err.message), ...(fallbackMethod === undefined ? {} : { data: { method: fallbackMethod } }) };
  }
  return { code: ErrorCode.Internal, message: maskSecrets(String(err)), ...(fallbackMethod === undefined ? {} : { data: { method: fallbackMethod } }) };
}

/**
 * Kärnan kastar ibland plain Error med svenska budskap. Vi känner igen de
 * frequency fall där UI:t har ett eget tillstånd — allt annat är Internal.
 */
function classifyKnownMessage(message: string): ErrorCodeValue {
  const lower = message.toLowerCase();
  if (lower.includes("checkpoint finns inte")) return ErrorCode.CheckpointNotFound;
  if (lower.includes("flyr ur workspacet")) return ErrorCode.BadRequest;
  if (lower.includes("tom sökväg") || lower.includes("ogiltigt miljönyckelnamn")) return ErrorCode.InvalidParams;
  if (lower.includes("godkännande nekades")) return ErrorCode.ApprovalDenied;
  if (lower.includes("verktyg finns inte")) return ErrorCode.ToolNotFound;
  if (lower.includes("ingen modell")) return ErrorCode.NoModelAvailable;
  return ErrorCode.Internal;
}

/** Timeout-vektor för transporten — ett välformat fel, aldrig ett häng. */
export function timeoutError(method: string, timeoutMs: number): RpcErrorPayload {
  return {
    code: ErrorCode.Internal,
    message: `Metoden ${method} svarade inte inom ${String(timeoutMs)} ms och avbröts.`,
    data: { method, timeoutMs },
  };
}
