import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {initAppThemeSync} from './stores/appThemeStore';

// V01：首帧同步水合全局明暗主题偏好（默认 'light'，零闪烁）
initAppThemeSync();

createRoot(document.getElementById('root')!).render(<App />);
