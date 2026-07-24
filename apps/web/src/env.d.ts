/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the budget API (e.g. http://localhost:8010). See .env.example. */
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
