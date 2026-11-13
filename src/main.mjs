import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createWriteStream, existsSync, renameSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, parseConfig, printerIds } from './config.mjs';
import { Controller } from './controller.mjs';
import { Discord, GoogleLogin, ServiceError, YouTube, oauthClient } from './integrations.mjs';
import { lanBinding } from './lan.mjs';
import { lowerPriority, trustBundle } from './media.mjs';
import { Store } from './store.mjs';

const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function openBrowser(url) {
  const opener = spawn('explorer.exe', [url], { stdio: 'ignore', windowsHide: true });
  opener.on('error', () => {});
  opener.unref();
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new InputError('The settings request is too large.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError('The settings request is invalid.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('The settings request is invalid.');
  return body;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('BBStreamer runs on Windows.');
  const directory = resolve(argument('--data-dir') || join(process.env.LOCALAPPDATA, 'BBStreamer'));
  const port = Number(argument('--port') ?? 8085);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port from 1024 to 65535.');
  const origin = `http://127.0.0.1:${port}`;
  const lanOption = argument('--lan-address');
  if (process.argv.includes('--lan-address') && (!lanOption || lanOption.startsWith('--'))) {
    throw new Error('Enter a private IPv4 address or off after --lan-address.');
  }
  const logFile = join(directory, 'bbstreamer.log');
  const store = new Store(directory);
  if (existsSync(logFile) && statSync(logFile).size > 1024 * 1024) {
    renameSync(logFile, join(directory, 'bbstreamer.previous.log'));
  }
  const log = createWriteStream(logFile, { flags: 'a' });
  log.on('error', () => console.error('BBStreamer could not write its local log.'));
  let controller, server, lanServer;
  try {
    const caFile = await trustBundle(directory);
    const login = new GoogleLogin(store);
    const youtube = new YouTube(login);
    const discord = new Discord(store);
    controller = new Controller({ store, youtube, discord, caFile });
    const statusLog = controller.log.bind(controller);
    controller.log = message => {
      statusLog(message);
      if (!log.destroyed) log.write(`${new Date().toISOString()} ${message.replace(/[\r\n]/g, ' ')}\n`);
    };
    const csrf = randomBytes(32).toString('base64url');
    const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
    const assets = new Map(await Promise.all([
      ['/', 'index.html', 'text/html; charset=utf-8'],
      ['/app.css', 'app.css', 'text/css; charset=utf-8'],
      ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ].map(async ([path, file, type]) => [path, { type, data: await readFile(join(publicDir, file)) }])));

    const makeServer = (binding, dashboardOrigin) => createServer(
      { requestTimeout: 20000, headersTimeout: 10000 }, (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com");
      const send = (status, data) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(data));
      };
      void (async () => {
        if (request.headers.host !== new URL(dashboardOrigin).host ||
            (binding && !binding.includes(request.socket.remoteAddress))) {
          send(403, { error: 'Open BBStreamer at its configured address.' });
          return;
        }
        const url = new URL(request.url, dashboardOrigin);
        if (url.origin !== dashboardOrigin) {
          send(403, { error: 'Invalid local request.' });
          return;
        }
        const path = url.pathname;
        if (request.method === 'GET' && assets.has(path)) {
          const { data, type } = assets.get(path);
          response.writeHead(200, { 'Content-Type': type });
          response.end(data);
          return;
        }
        if (request.method === 'GET' && path === '/oauth/callback') {
          if (binding) {
            send(403, { error: 'Finish Google sign-in in the browser on the BBStreamer PC.' });
            return;
          }
          try {
            const channel = await login.finish(url.searchParams);
            controller.log(`YouTube connected · ${channel.name}`);
            controller.applyConfig(controller.config);
            response.writeHead(303, { Location: '/?youtube=connected' }).end();
          } catch (error) {
            controller.log(`YouTube · ${error.message}`);
            response.writeHead(303, { Location: '/?youtube=failed' }).end();
          }
          return;
        }
        if (request.method === 'GET' && path === '/api/state') {
          send(200, controller.snapshot());
          return;
        }
        if (request.method === 'GET' && path === '/api/config') {
          send(200, {
            config: controller.config, csrf, signInOnHost: Boolean(binding),
            saved: {
              printers: Object.fromEntries(printerIds.map(id => [id, Boolean(store.credentials.printers?.[id])])),
              discord: Boolean(store.credentials.discordToken), google: Boolean(store.credentials.google),
            },
          });
          return;
        }
        if (request.method !== 'POST' || !path.startsWith('/api/')) {
          send(404, { error: 'Page not found.' });
          return;
        }
        if (request.headers.origin !== dashboardOrigin || request.headers['x-bb-csrf'] !== csrf ||
            !request.headers['content-type']?.startsWith('application/json')) {
          send(403, { error: 'Reload the local page and try again.' });
          return;
        }
        const body = await readBody(request);
        if (path === '/api/config') {
          const previous = controller.config;
          const { config, secrets } = parseConfig(body, store.credentials);
          if (config.automatic && !secrets.google) throw new InputError('Connect YouTube before enabling automatic streaming.');
          if (config.discordChannel && !secrets.discordToken) throw new InputError('Enter a bot token for the Discord channel.');
          if (config.youtubePlaylistId && secrets.google &&
              (config.youtubePlaylistId !== previous.youtubePlaylistId ||
               (config.automatic && !previous.automatic))) {
            await youtube.checkPlaylist(secrets.google.channel.id, config.youtubePlaylistId);
            // Google may have refreshed its token while checking the playlist.
            if (controller.config !== previous || store.credentials.google?.channel.id !== secrets.google.channel.id) {
              throw new InputError('The saved settings changed. Reload and try again.');
            }
            secrets.google = store.credentials.google;
          }
          store.saveSettings(config, secrets);
          controller.applyConfig(config);
          controller.log('Settings saved');
          send(200, { ok: true });
          return;
        }
        if (path === '/api/youtube/connect') {
          const client = body.client ? oauthClient(body.client) : store.credentials.google?.client;
          if (!client) throw new InputError('Choose the Google OAuth Desktop client JSON file.');
          const url = login.start(client, origin + '/oauth/callback');
          if (binding) {
            openBrowser(url);
            send(200, { openedOnHost: true });
          } else {
            send(200, { url });
          }
          return;
        }
        if (path === '/api/discord/check') {
          const channel = typeof body.channel === 'string' && /^\d{17,20}$/.test(body.channel) ? body.channel : controller.config.discordChannel;
          const token = typeof body.token === 'string' && /^[a-zA-Z0-9._-]{20,300}$/.test(body.token) ? body.token : undefined;
          if (!channel) throw new InputError('Enter a Discord channel ID.');
          send(200, await discord.check(channel, token));
          return;
        }
        if (path === '/api/preview' && printerIds.includes(body.printer)) {
          const { image, camera, toolpath } = await controller.preview(body.printer);
          send(200, { image: image.toString('base64'), camera, toolpath });
          return;
        }
        send(404, { error: 'Page not found.' });
      })().catch(error => {
        // Browser/network errors are translated at their source. Never return raw OS/SQL exception details.
        const known = error instanceof InputError || error instanceof ServiceError || error.constructor === Error && !error.code;
        send(known ? 400 : 500, { error: known ? error.message : 'BBStreamer could not finish that request. Check the local log.' });
        if (!known) controller.log('A settings or status request could not be completed.');
      });
    });
    const listen = (listener, address) => new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, address, resolve);
    });
    server = makeServer(null, origin);
    await listen(server, '127.0.0.1');
    lowerPriority(process.pid);
    controller.start();
    const lanAddress = lanOption ?? store.get('lanAddress');
    if (lanAddress === 'off') store.set('lanAddress', null);
    else if (lanAddress) {
      try {
        const binding = lanBinding(lanAddress);
        const lanOrigin = `http://${binding.address}:${port}`;
        lanServer = makeServer(binding, lanOrigin);
        await listen(lanServer, binding.address);
        if (lanOption) store.set('lanAddress', binding.address);
        controller.log(`Wi-Fi dashboard available at ${lanOrigin}`);
      } catch (error) {
        lanServer?.close();
        lanServer = null;
        controller.log(`Wi-Fi dashboard · ${error.message}`);
        if (lanOption) console.error(error.message);
      }
    }
    controller.log(`BBStreamer is ready at ${origin}`);
    console.log(`BBStreamer is ready at ${origin}`);
    if (process.argv.includes('--open')) openBrowser(origin);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      server.close();
      lanServer?.close();
      await controller.close();
      server.closeAllConnections();
      lanServer?.closeAllConnections();
      store.close();
      log.end();
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
  } catch (error) {
    server?.close();
    lanServer?.close();
    await controller?.close();
    store.close();
    log.end();
    throw error;
  }
}

main().catch(error => {
  console.error(error.code === 'EADDRINUSE' ? 'The BBStreamer port is already in use. Choose another with --port.' : error.message);
  process.exitCode = 1;
});
