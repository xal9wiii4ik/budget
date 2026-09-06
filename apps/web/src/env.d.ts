/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the budget API (e.g. http://localhost:8010). See .env.example. */
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The raw --l-* / --d-* palette, served by the paletteCss plugin in vite.config.ts
    from @budget/shared. Side-effect CSS import, no exports. */
declare module 'virtual:palette.css';
