import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RopeSwitcher } from './RopeSwitcher';
import './scene.css';

function App() {
  return <main className="scene">
    <div className="panel-stage"><RopeSwitcher /></div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
