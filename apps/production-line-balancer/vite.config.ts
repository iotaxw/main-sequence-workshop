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
  const filePath = resolve(iconRoot, fileName);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.statusCode = 404;
    response.end('Icon not found');
    return;
  }
  response.setHeader('Content-Type', 'image/png');
  response.setHeader('Cache-Control', 'no-cache');
  createReadStream(filePath).pipe(response);
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
