import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './design-system.css';

async function start() {
  if (import.meta.env.VITE_PUBLIC_DEMO === 'true') {
    const nativeFetch = window.fetch.bind(window);
    const { installPublicRuntime } = await import('./public-runtime');
    await installPublicRuntime({ ai: {
      status: async () => {
        const response = await nativeFetch('/api/ai/status');
        if (!response.ok) throw new Error('Starea AI nu poate fi verificată.');
        return response.json();
      },
      extract: async (input) => {
        const statusResponse = await nativeFetch('/api/ai/status');
        const status = statusResponse.ok ? await statusResponse.json() : null;
        if (!status?.configured) throw new Error('AI public neconfigurat. Textul nu a fost trimis.');
        const response = await nativeFetch('/api/ai/extract', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-TeamCreator-AI': '1' }, body: JSON.stringify(input) });
        const result = await response.json().catch(() => ({ error: 'Autentificarea AI nu este disponibilă. Deschide conexiunea și reîncearcă.' }));
        if (!response.ok) throw new Error(result.error || 'Extragerea AI a eșuat.');
        return result;
      },
    } });
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
}
void start().catch(error => {
  const element = document.getElementById('root')!;
  element.textContent = `TeamCreator nu poate deschide spațiul din browser: ${error instanceof Error ? error.message : 'eroare necunoscută'}. Permite stocarea locală și reîncarcă pagina.`;
});
