import { formatMoney } from '@budget/shared';

export default function App() {
  return <h1>Budget — {formatMoney(12345, 'USD', { locale: 'en-US' })}</h1>;
}
