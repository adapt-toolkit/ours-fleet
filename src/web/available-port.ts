import { createServer } from 'node:net';
/** Bind the preferred loopback port; only EADDRINUSE permits an OS-selected replacement. */
export async function availableWebPort(preferred: number): Promise<number> {
  const server = createServer();
  const listen = (port: number) => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  try { await listen(preferred); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; await listen(0); }
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No loopback port selected');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
