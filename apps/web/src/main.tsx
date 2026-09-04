import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// Order matters: @font-face first, then the tokens every rule below reads, then
// the global baseline that consumes them.
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/global.css';
import { I18nProvider } from './i18n/I18nProvider';
import { queryClient } from './lib/query';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Inside the query provider: the chosen language lives on the server
          profile, so the resolver is a Query consumer like everything else. */}
      <I18nProvider>
        <App />
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
