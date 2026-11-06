import { Route, Routes } from 'react-router-dom';
import { Page } from '@strapi/strapi/admin';
import { DashboardPage } from './DashboardPage';

const App = () => (
  <Routes>
    <Route index element={<DashboardPage />} />
    <Route path="*" element={<Page.Error />} />
  </Routes>
);

export { App };
