import React from 'react';
import ReactDOM from 'react-dom/client';
import { AgenticIDE } from './components/AgenticIDE';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AgenticIDE />
  </React.StrictMode>
);
