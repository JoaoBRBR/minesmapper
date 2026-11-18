import './style.css';
import { initI18n } from './i18n';
import { artReady, installIcons } from './icons';
import { start } from './app';

await artReady;
initI18n();
installIcons();
await start();
