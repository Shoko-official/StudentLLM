import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import type { SpeechEngine } from './lib/speech-engine';
import './styles.css';

const injectedSpeechEngine = import.meta.env.DEV
  ? (window as Window & { __STUDENTLLM_E2E_SPEECH_ENGINE__?: SpeechEngine }).__STUDENTLLM_E2E_SPEECH_ENGINE__
  : undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App speechEngine={injectedSpeechEngine} />
  </StrictMode>,
);
