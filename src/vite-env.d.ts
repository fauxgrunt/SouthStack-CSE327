/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly VITE_VISION_API_URL?: string;
  readonly VITE_VISION_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
