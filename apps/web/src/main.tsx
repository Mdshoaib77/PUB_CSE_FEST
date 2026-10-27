import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './lib/auth';
import { MotionConfig } from 'framer-motion';
import { ConfirmProvider, ToastProvider } from './components/ui';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/figtree';
import './index.css';

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000, refetchOnWindowFocus: false } } });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MotionConfig reducedMotion="user">
          <ToastProvider>
            <ConfirmProvider>
              <AuthProvider>
                <App />
              </AuthProvider>
            </ConfirmProvider>
          </ToastProvider>
        </MotionConfig>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);

// Hide the static splash from index.html once React has painted (BrandLoader takes over seamlessly while data loads).
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('out');
    setTimeout(() => boot.remove(), 400);
  }),
);
