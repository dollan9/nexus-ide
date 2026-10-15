/**
 * bridge/context.tsx — React-kopplingen. Ingen komponent får hålla en egen löfteslogik:
 * de använder useBridge/useHostCall/useHostEvent så att fel hanteras konsekvent och
 * abonnemang alltid avbokas vid unmount.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { EventName, MethodName, ParamsOf, PayloadOf, ResultOf } from "@nexus/protocol";
import type { NexusHostBridge } from "./create-bridge";
import { NexusError } from "./frames";

const BridgeContext = createContext<NexusHostBridge | null>(null);

export interface BridgeProviderProps {
  readonly bridge: NexusHostBridge;
  readonly children: ReactNode;
}

export function BridgeProvider({ bridge, children }: BridgeProviderProps): ReactElement {
  return <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>;
}

export function useBridge(): NexusHostBridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error("useBridge() kräver <BridgeProvider> — annars har UI:t ingen host.");
  return bridge;
}

/** Abonnerar på ett host-event. Handleren byts utan att abonnemanget nollställs. */
export function useHostEvent<E extends EventName>(
  name: E,
  handler: (payload: PayloadOf<E>) => void,
): void {
  const bridge = useBridge();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const stable = (payload: PayloadOf<E>): void => {
      ref.current(payload);
    };
    return bridge.on(name, stable);
  }, [bridge, name]);
}

export interface HostCallState<R> {
  readonly data: R | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reload: () => void;
}

/**
 * Ett anrop per hook. Paramrarna serialiseras till en nyckel så att ett objekt-literaal per
 * render inte startar en oändlig request-loop; själva params läses via ref vid anropstillfället.
 */
export function useHostCall<M extends MethodName>(
  method: M,
  params: ParamsOf<M>,
  options: { readonly enabled?: boolean; readonly timeoutMs?: number } = {},
): HostCallState<ResultOf<M>> {
  const bridge = useBridge();
  const key = useMemo(() => stableKey(params), [params]);
  const enabled = options.enabled ?? true;
  const timeoutMs = options.timeoutMs;
  const paramsRef = useRef<ParamsOf<M>>(params);
  paramsRef.current = params;

  const [data, setData] = useState<ResultOf<M> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    bridge
      .request(method, paramsRef.current, timeoutMs)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof NexusError ? `${method}: ${err.message}` : `${method}: ${String(err)}`);
        setData(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, method, key, enabled, nonce, timeoutMs]);

  return { data, error, loading, reload };
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "oupprepelig-param";
  }
}

export interface ConnectionState {
  readonly connected: boolean;
  readonly detail: string;
}

export function useConnection(): ConnectionState {
  const bridge = useBridge();
  const [state, setState] = useState<ConnectionState>({
    connected: bridge.connected,
    detail: bridge.describe,
  });
  useEffect(
    () =>
      bridge.onConnection((connected, detail) => {
        setState({ connected, detail });
      }),
    [bridge],
  );
  return state;
}
