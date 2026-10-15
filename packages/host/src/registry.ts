/**
 * registry.ts — metodregistret som ar den enda giltiga implementationen av
 * MethodTable (protocol/src/index.ts).
 *
 * Varfor Map och inte ett object literal med mappad typ: ett literal tvingar
 * TypeScript att reducera en mappad typ over 78 nycklar, och det blir bade
 * lasbrabat och latt att tappa en metod i. `add<M>(name, handler)` är en ledtrad
 * — metodnamnet är en literal, genericen infereras, och params/result tvingas
 * per metod. Ett saknat namn syns i stallet i testet som jamfor registret med
 * ALL_METHOD_NAMES (bade riktningar), sa det ar strukturellt omojligt att dolja
 * en halvimplementerad metod.
 */

import type { MethodName, ParamsOf, ResultOf } from "@nexus/protocol";

/** En fardig handler: tar params, svarar med resultatet (eller ett HostError). */
export type MethodHandler<M extends MethodName> = (params: ParamsOf<M>) => Promise<ResultOf<M>> | ResultOf<M>;

/** Raderad form — endast router:n och registret anvander denna, aldrig metoder. */
export type ErasedHandler = (params: unknown) => Promise<unknown> | unknown;

export class HandlerRegistry {
  private readonly handlers = new Map<MethodName, ErasedHandler>();

  add<M extends MethodName>(name: M, handler: MethodHandler<M>): this {
    if (this.handlers.has(name)) {
      throw new Error(`Metod registrerad tvag ganger: ${name}`);
    }
    this.handlers.set(name, handler as ErasedHandler);
    return this;
  }

  get(name: MethodName): ErasedHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: MethodName): boolean {
    return this.handlers.has(name);
  }

  get size(): number {
    return this.handlers.size;
  }

  names(): MethodName[] {
    return [...this.handlers.keys()];
  }

  /**
   * Krosscheck mot protocol:s egn listing. Returnerar saknade och overlapmande
   * namn — testet som hall P0-ytan komplett anropar denna.
   */
  diff(expected: readonly MethodName[]): { missing: MethodName[]; extra: MethodName[] } {
    const expectedSet = new Set<string>(expected);
    const actualSet = new Set<string>(this.names());
    return {
      missing: expected.filter((name) => !actualSet.has(name)),
      extra: this.names().filter((name) => !expectedSet.has(name)),
    };
  }
}
