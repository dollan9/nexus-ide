/**
 * Ambientliga moduler för Vite-byggd renderer.
 *
 * @nexus/ui byggs av Vite i apps/desktop (se CONVENTIONS.md: renderer är undantaget som
 * aliasas från src), och tsc-buildet ovanför är bara ett typ-/portbarhets-gate. Därför
 * deklarerar vi Vites import-suffix här istället för att kräva `vite/client` i paketet.
 */

declare module "*.css" {
  const css: string;
  export default css;
}

declare module "*?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

declare module "*?worker&inline" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

declare module "*?raw" {
  const text: string;
  export default text;
}
