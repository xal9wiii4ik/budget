import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';

describe('App', () => {
  it('renders and pulls a value from @budget/shared', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('@budget/shared');
  });
});
