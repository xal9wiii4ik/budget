import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { useAuthListener } from './auth/useAuthListener';
import { LoginPage } from './routes/LoginPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { ProtectedLayout } from './routes/ProtectedLayout';
import { RegisterPage } from './routes/RegisterPage';
import { TransactionsStubPage } from './routes/TransactionsStubPage';

export default function App() {
  // Clears the Query cache on sign-out transitions (external effect, not syncing).
  useAuthListener();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/" element={<Navigate to="/transactions" replace />} />
        <Route element={<ProtectedLayout />}>
          <Route path="/transactions" element={<TransactionsStubPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
