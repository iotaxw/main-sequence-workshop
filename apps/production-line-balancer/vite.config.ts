import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';

const iconRoot = resolve(process.cwd(), '.tools/icons');

function serveGameIcons(request: Connect.IncomingMessage, response: import('node:http').ServerResponse, next: Connect.NextFunction) {
  if (!request.url?.startsWith('/icons/')) {
    next();
    return;
  }
  const fileName = basename(decodeURIComponent(request.url.slice('/icons/'.length)));
  if (!/^[A-Za-z0-9_]+\.png$/.test(fileName)) {
    response.statusCode = 400;
    response.end('Invalid icon');
    return;
  }
  for (const candidate of [fileName, ...iconAliases(fileName)]) {
    const filePath = resolve(iconRoot, candidate);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      response.setHeader('Content-Type', 'image/png');
      response.setHeader('Cache-Control', 'no-cache');
      createReadStream(filePath).pipe(response);
      return;
    }
  }
  response.statusCode = 404;
  response.end('Icon not found');
}

// The vendored icon set keeps the game asset prefix (DAT_/CRAFT_), while the UI
// asks for `<itemId>.png`. Map the id form onto the vendored file names.
function iconAliases(fileName: string): string[] {
  const stem = fileName.slice(0, -'.png'.length);
  const bare = stem.replace(/^ITEM_/, '');
  return [`DAT_${bare}.png`, `CRAFT_${bare}.png`, `DAT_${bare.replace(/s$/, '')}.png`];
}

function gameIcons(): Plugin {
  return {
    name: 'game-icons',
    configureServer(server) {
      server.middlewares.use(serveGameIcons);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveGameIcons);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), gameIcons()],
});
