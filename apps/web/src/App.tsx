import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { useAuthListener } from './auth/useAuthListener';
import { AccountsPage } from './routes/AccountsPage';
import { AdvisorPage } from './routes/AdvisorPage';
import { CategoriesPage } from './routes/CategoriesPage';
import { DepositsPage } from './routes/DepositsPage';
import { GoalPlanPage } from './routes/GoalPlanPage';
import { GoalsPage } from './routes/GoalsPage';
import { ImportPage } from './routes/ImportPage';
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
          {/* deposits W1: its own screen because deposit money is deliberately
              absent from /accounts and from every total (task.md §3). */}
          <Route path="/deposits" element={<DepositsPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/recurring" element={<RecurringPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          {/* One goal as a PLAN. Its own route, not a card expander: the tree,
              its attachments and its operations do not fit in a list card, and a
              plan has to survive F5 and a shared URL. */}
          <Route path="/goals/:goalId" element={<GoalPlanPage />} />
          {/* statement-import S4: one import session as a screen, not a modal.
              A preview of up to a thousand lines with a decision on each is a
              place you come back to (and reload), so it has a URL; the session
              id is the whole state, and everything on it is re-read from the
              server. */}
          <Route path="/imports/:importId" element={<ImportPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/advisor" element={<AdvisorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
