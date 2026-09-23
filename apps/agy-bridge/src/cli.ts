import { join } from 'node:path';
import { open, readFile, unlink } from 'node:fs/promises';
import qrcode from 'qrcode-terminal';
import { initialize, loadConfig, fingerprint, protect } from './config.js';
import { Store } from './store.js';
import { Controller } from './controller.js';
import { AgyPeer } from './agy.js';
import { createServer } from './server.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] ?? fallback : fallback; };

async function main(): Promise<void> {
  if (args[0] === 'init') {
    const config = await initialize(flag('url', 'https://127.0.0.1:8788'), flag('host', '0.0.0.0'), Number(flag('port', '8788')));
    console.log(`Created ${join(config.dataDir, 'config.json')}. Next: node dist/cli.js serve`);
    return;
  }

  const config = await loadConfig();
  let unlock: (() => Promise<void>) | undefined;

  if (args[0] === 'serve') {
    const path = join(config.dataDir, 'server.lock');
    try {
      const previous = Number(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(previous) && previous > 0) {
        try { process.kill(previous, 0); throw new Error('Bridge is already running for this data directory'); }
        catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      }
      await unlink(path);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(String(process.pid)); await handle.close();
    unlock = () => unlink(path).catch(() => {});
  }

  const store = new Store(join(config.dataDir, 'bridge.sqlite'), args[0] === 'serve');
  await protect(join(config.dataDir, 'bridge.sqlite'));

  if (args[0] === 'pair') {
    const pair = store.createPair();
    const payload = JSON.stringify({ version: 1, url: flag('url', config.publicUrl), fingerprint: args.includes('--public-ca') ? null : await fingerprint(config), ...pair });
    console.log('WARNING: a paired device can read/write files and execute commands as this host user. Share only with your own device.');
    qrcode.generate(payload, { small: true });
    console.log(payload); store.close(); return;
  }

  if (args[0] === 'devices') { console.table(store.devices()); store.close(); return; }
  if (args[0] === 'revoke') { if (!args[1]) throw new Error('Provide a device ID'); store.revoke(args[1]); store.close(); return; }
  if (args[0] !== 'serve') { store.close(); throw new Error('Commands: init | serve | pair | devices | revoke DEVICE_ID'); }

  const agy = new AgyPeer();
  const controller = new Controller(store, agy);
  let app: Awaited<ReturnType<typeof createServer>>;

  try {
    await agy.start();
    app = await createServer(controller, config);
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await agy.stop();
    store.close();
    await unlock?.();
    throw error;
  }

  console.log(`Agy Bridge 0.1.0 | ${config.publicUrl} | authenticated HTTPS/WSS | agy CLI`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await app.close(); await agy.stop(); store.close(); await unlock?.(); process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Bridge failed'); process.exitCode = 1; });
