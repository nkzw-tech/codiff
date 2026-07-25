import './App.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { trackKeyboardLayout } from './config/keyboard-layout.ts';

// Reading the layout is asynchronous, so it starts here rather than blocking
// the first paint. Shortcuts resolve against US key positions until it lands.
trackKeyboardLayout();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
