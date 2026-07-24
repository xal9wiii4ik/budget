import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main style={{ padding: '3rem 1.5rem', textAlign: 'center' }}>
      <h1>Page not found</h1>
      <p>The page you were looking for doesn&apos;t exist.</p>
      <Link to="/">Back to home</Link>
    </main>
  );
}
