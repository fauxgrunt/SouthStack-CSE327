/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly VITE_PEER_SIGNAL_HOST?: string;
  readonly VITE_PEER_SIGNAL_PORT?: string;
  readonly VITE_PEER_SIGNAL_PATH?: string;
  readonly VITE_PEER_SIGNAL_SECURE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
