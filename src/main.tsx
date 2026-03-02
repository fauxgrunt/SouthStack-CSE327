import React from 'react';
import ReactDOM from 'react-dom/client';
import { AgenticIDE } from './components/AgenticIDE';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AgenticIDE />
    </ErrorBoundary>
  </React.StrictMode>
);
