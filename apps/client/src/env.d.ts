/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ZORIA_SERVER?: string;
  readonly VITE_ZORIA_PROD_FINGERPRINT?: string;
  readonly VITE_ZORIA_STAND_FINGERPRINT?: string;
  /** Optional override of the stand address, e.g. the local mock: http://localhost:8787/api/v1 */
  readonly VITE_ZORIA_STAND_API?: string;
}
