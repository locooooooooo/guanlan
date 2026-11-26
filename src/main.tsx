import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {initAppThemeSync} from './stores/appThemeStore';

initAppThemeSync();

createRoot(document.getElementById('root')!).render(<App />);
