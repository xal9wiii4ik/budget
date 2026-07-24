import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';

describe('App', () => {
  it('renders a formatted amount from @budget/shared', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('$123.45');
  });
});
