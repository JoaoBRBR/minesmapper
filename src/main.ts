import './style.css';
import { artReady, installIcons } from './icons';
import { start } from './app';

await artReady;
installIcons();
await start();
