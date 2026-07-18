import { Navigate, Route, Routes } from 'react-router-dom';
import '@rostering/ui/styles.css';

import { Layout } from './components/Layout.js';
import { CompaniesPage } from './pages/Companies/CompaniesPage.js';
import { CostDashboardPage } from './pages/CostDashboard/CostDashboardPage.js';
import { WorkerCostComparePage } from './pages/CostDashboard/WorkerCostComparePage.js';
import { WorkerCostDetailPage } from './pages/CostDashboard/WorkerCostDetailPage.js';
import { PublicSchedulePage } from './pages/PublicSchedule/PublicSchedulePage.js';
import { RequirementsPage } from './pages/Requirements/RequirementsPage.js';
import { RosterPage } from './pages/Roster/RosterPage.js';
import { WorkersPage } from './pages/Workers/WorkersPage.js';

function NotFoundPage(): JSX.Element {
  return (
    <div className="page">
      <div className="empty-state">
        <div className="empty-state__title">Not found</div>
        <p className="empty-state__body">This page doesn&apos;t exist.</p>
      </div>
    </div>
  );
}

/**
 * Every authenticated route renders inside `<Layout>` (topbar + nav shell). The public worker
 * schedule (`/schedule/:token`) deliberately does NOT — `PublicSchedulePage` is its own
 * self-contained layout with zero dependency on the authenticated store (see
 * `pages/PublicSchedule/PublicSchedulePage.architecture.test.ts`), matching
 * `docs/design/ui/README.md`'s "no authenticated chrome on an unauthenticated page" rule.
 */
export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/workers" replace />} />
      <Route
        path="/workers"
        element={
          <Layout>
            <WorkersPage />
          </Layout>
        }
      />
      <Route
        path="/companies"
        element={
          <Layout>
            <CompaniesPage />
          </Layout>
        }
      />
      <Route
        path="/requirements"
        element={
          <Layout>
            <RequirementsPage />
          </Layout>
        }
      />
      <Route
        path="/roster/:month"
        element={
          <Layout>
            <RosterPage />
          </Layout>
        }
      />
      <Route
        path="/cost/:month"
        element={
          <Layout>
            <CostDashboardPage />
          </Layout>
        }
      />
      <Route
        path="/cost/:month/worker/:workerId"
        element={
          <Layout>
            <WorkerCostDetailPage />
          </Layout>
        }
      />
      <Route
        path="/cost/:month/compare"
        element={
          <Layout>
            <WorkerCostComparePage />
          </Layout>
        }
      />
      <Route path="/schedule/:token" element={<PublicSchedulePage />} />
      <Route
        path="*"
        element={
          <Layout>
            <NotFoundPage />
          </Layout>
        }
      />
    </Routes>
  );
}
