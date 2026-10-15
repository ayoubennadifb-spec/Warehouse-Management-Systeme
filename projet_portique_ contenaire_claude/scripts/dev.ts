/**
 * Développement : serveur API (redémarre à chaque modification) + Vite (rechargement à chaud).
 *   npm run dev   →  interface sur http://127.0.0.1:5173 (l'API est relayée vers le port PORT)
 */
import { spawn } from 'node:child_process';
import { RACINE } from '../src/server/config.ts';

const enfants = [
  spawn(process.execPath, ['--watch-path=src/server', '--watch-path=src/shared', 'src/server/index.ts'], { cwd: RACINE, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: RACINE, stdio: 'inherit' }),
];
const arreter = () => {
  for (const e of enfants) e.kill();
  process.exit(0);
};
process.on('SIGINT', arreter);
process.on('SIGTERM', arreter);
for (const e of enfants) e.on('exit', (code) => code && code !== 0 && console.error(`processus terminé (code ${code})`));
