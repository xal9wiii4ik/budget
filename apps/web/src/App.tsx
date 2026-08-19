import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { useAuthListener } from './auth/useAuthListener';
import { AccountsPage } from './routes/AccountsPage';
import { AdvisorPage } from './routes/AdvisorPage';
import { CategoriesPage } from './routes/CategoriesPage';
import { GoalsPage } from './routes/GoalsPage';
import { LoginPage } from './routes/LoginPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { ProtectedLayout } from './routes/ProtectedLayout';
import { RecurringPage } from './routes/RecurringPage';
import { RegisterPage } from './routes/RegisterPage';
import { SettingsPage } from './routes/SettingsPage';
import { StatsPage } from './routes/StatsPage';
import { TransactionsPage } from './routes/TransactionsPage';

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
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/recurring" element={<RecurringPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/advisor" element={<AdvisorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
