/**
 * version.ts — host:s identitet. Hålls här i stället för att läsa package.json
 * eftersom `rootDir: src` förbjuder import ovanför paketrotsmappen.
 */

export const HOST_NAME = "@nexus/host";

/** Samma värde som packages/host/package.json → version (hålls i taket för hand). */
export const HOST_VERSION = "1.0.0";
