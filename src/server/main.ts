import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';

const app = createApp({
  dbPath: process.env.DB_PATH ?? 'data/chess.db',
  publicDir: process.env.PUBLIC_DIR ?? 'public',
  secureCookies: process.env.SECURE_COOKIES === '1',
});

app.server.listen(port, host, () => console.log(`chess server listening on http://${host}:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal}: shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
