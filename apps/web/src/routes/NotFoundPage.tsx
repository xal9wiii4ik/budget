import { Link } from 'react-router';

import { useT } from '../i18n/context';

export function NotFoundPage() {
  const t = useT();
  return (
    <main style={{ padding: '3rem 1.5rem', textAlign: 'center' }}>
      <h1>{t('notFound.title')}</h1>
      <p>{t('notFound.body')}</p>
      <Link to="/">{t('notFound.back')}</Link>
    </main>
  );
}
