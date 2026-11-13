import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, setPriority, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';
import { setTimeout as sleep } from 'node:timers/promises';
import { browserBinary, streamProfile } from './config.mjs';

export function lowerPriority(pid) {
  try { setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* standard users may be restricted */ }
}

class BrowserPipe {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.next = 0;
    this.closed = new Promise(resolve => child.once('close', resolve));
    const [input, output] = [child.stdio[3], child.stdio[4]];
    this.input = input;
    let partial = '';
    output.setEncoding('utf8');
    output.on('data', chunk => {
      partial += chunk;
      if (partial.length > 12 * 1024 * 1024) return child.kill();
      let end;
      while ((end = partial.indexOf('\0')) >= 0) {
        const raw = partial.slice(0, end);
        partial = partial.slice(end + 1);
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        const request = this.pending.get(message.id);
        if (request) request(message.error ? new Error('Chromium rejected a capture command.') : null, message.result);
      }
    });
    const disconnect = () => {
      this.disconnected = true;
      for (const settle of this.pending.values()) settle(new Error('Chromium closed the capture connection.'));
    };
    child.once('error', disconnect);
    child.once('exit', disconnect);
    input.on('error', disconnect);
    output.on('error', disconnect);
    output.once('end', disconnect);
    child.once('spawn', () => lowerPriority(child.pid));
  }

  send(method, params = {}, sessionId, timeout = 7000) {
    return new Promise((resolve, reject) => {
      if (this.disconnected || this.input.destroyed) return reject(new Error('Chromium closed the capture connection.'));
      const id = ++this.next;
      const timer = setTimeout(() => settle(new Error('Chromium timed out rendering the overlay.')), timeout);
      const settle = (error, value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      this.pending.set(id, settle);
      this.input.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const kill = setTimeout(() => this.child.kill(), 2200);
      try {
        if (!this.disconnected) void this.send('Browser.close', {}, undefined, 1500).catch(() => {});
        this.input.end();
        await this.closed;
      } finally { clearTimeout(kill); }
    })();
    return this.closing;
  }
}

const inspectScene = `(() => {
  const stage = document.getElementById('stage');
  const scene = !!stage?.querySelector('.live-item') && document.getElementById('live-msg')?.classList.contains('hidden');
  const widgets = [...(stage?.querySelectorAll('iframe') ?? [])];
  function widget(slug) { return widgets.find(frame => new URL(frame.src, location.href).pathname.includes('/widgets/' + slug + '/')); }
  const camera = widget('camera');
  const toolpath = widget('gcode-viz');
  const cameraDoc = camera?.contentDocument;
  const cameraOverlay = cameraDoc?.getElementById('camOverlay');
  const cameraImage = cameraDoc?.getElementById('camImg');
  const cameraCanvas = cameraDoc?.getElementById('camCanvas');
  // The RTSP widget hides its status as soon as bytes arrive. JSMpeg sizes
  // the canvas after it receives a video sequence header.
  const cameraStarted = cameraImage?.style.display === 'block'
    ? cameraImage.naturalWidth > 0
    : cameraCanvas?.hasAttribute('width') && cameraCanvas.hasAttribute('height');
  const toolpathDoc = toolpath?.contentDocument;
  const toolpathCanvas = toolpathDoc?.getElementById('gcodeCanvas');
  const toolpathOverlay = toolpathDoc?.getElementById('gcodeOverlay');
  const waitingForPrint = toolpathOverlay?.classList.contains('waiting') &&
    toolpathOverlay.textContent.trim() === 'Waiting for print…';
  return {
    url: location.origin + location.pathname, scene,
    camera: !camera ? 'Absent from scene' : cameraStarted && cameraOverlay && !cameraOverlay.classList.contains('show') ? 'Ready' : 'Waiting for camera',
    toolpath: !toolpath ? 'Absent from scene' : toolpathCanvas && toolpathOverlay?.style.display === 'none' && toolpathCanvas.style.visibility !== 'hidden'
      ? 'Rendering' : waitingForPrint ? 'Waiting for print' : 'Waiting for G-code or WebGL'
  };
})()`;

export async function openOverlay(config, overlay, profile, signal) {
  const binary = browserBinary(config.chromium);
  const directory = await mkdtemp(join(tmpdir(), 'bbstreamer-browser-'));
  let browser;
  const stop = async () => {
    signal?.removeEventListener('abort', abort);
    await browser?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 125 }).catch(() => {});
  };
  const abort = () => { void browser?.close().catch(() => {}); };
  try {
    signal?.throwIfAborted();
    const args = [
      '--headless', '--remote-debugging-pipe', `--user-data-dir=${directory}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
      `--window-size=${profile.width},${profile.height}`, 'about:blank',
    ];
    if (config.softwareWebgl) args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    browser = new BrowserPipe(spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }));
    signal?.addEventListener('abort', abort, { once: true });
    await browser.send('Browser.getVersion', {}, undefined, 10000);
    const { targetInfos } = await browser.send('Target.getTargets');
    const target = targetInfos.find(item => item.type === 'page') ?? await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const send = (method, params, timeout) => browser.send(method, params, sessionId, timeout);
    await send('Emulation.setDeviceMetricsOverride', {
      width: profile.width, height: profile.height, deviceScaleFactor: 1, mobile: false,
    });
    const navigation = await send('Page.navigate', { url: overlay }, 12000);
    if (navigation.errorText === 'net::ERR_CONNECTION_REFUSED') {
      throw new Error(`BambuBoard is unreachable at ${overlay}. Start BambuBoard on that address or update the /live URL in Settings.`);
    }
    if (navigation.errorText) throw new Error(`Could not open ${overlay} from the BBStreamer PC. Check that BambuBoard is running and the /live URL is correct.`);
    const expected = new URL(overlay);
    const inspect = async () => {
      const { result } = await send('Runtime.evaluate', { expression: inspectScene, returnByValue: true });
      return result.value;
    };
    let status;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      status = await inspect().catch(() => null);
      if (status?.scene && status.url === expected.origin + expected.pathname) break;
      if (status?.url === expected.origin + '/setup') throw new Error('Finish BambuBoard printer setup before capturing its /live page.');
      await sleep(300, undefined, { signal });
    }
    if (!status?.scene || status.url !== expected.origin + expected.pathname) {
      throw new Error('BambuBoard has no renderable /live scene. Complete its printer setup and publish a layout.');
    }
    const frame = async () => {
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 76, fromSurface: true, captureBeyondViewport: false });
      if (!data) throw new Error('Chromium returned an empty overlay frame.');
      return Buffer.from(data, 'base64');
    };
    return { stop, inspect, frame, first: await frame() };
  } catch (error) {
    await stop();
    throw error;
  }
}

const codecOptions = {
  libx264: ['-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2', '-sc_threshold', '0', '-x264-params', 'nal-hrd=cbr:force-cfr=1'],
  h264_nvenc: ['-preset', 'p2', '-tune', 'll', '-rc', 'cbr', '-zerolatency', '1'],
  h264_qsv: ['-preset', 'veryfast', '-look_ahead', '0', '-async_depth', '1'],
  h264_amf: ['-usage', 'lowlatency', '-quality', 'speed', '-rc', 'cbr'],
};

function videoArgs(profile, encoder) {
  const { bitrate, fps } = profile;
  return [
    '-c:v', encoder, ...codecOptions[encoder], '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-g', String(2 * fps), '-bf', '0', '-b:v', `${bitrate}k`, '-minrate', `${bitrate}k`,
    '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  ];
}

async function encoderWorks(bin, profile, encoder) {
  return new Promise(resolve => {
    const child = spawn(bin, [
      '-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-f', 'lavfi',
      '-i', `color=size=${profile.width}x${profile.height}:rate=${profile.fps}`,
      '-frames:v', '3', ...videoArgs(profile, encoder), '-f', 'null', '-',
    ], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('spawn', () => lowerPriority(child.pid));
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

export class Encoders {
  constructor() { this.cache = new Map(); }

  async choose(config, profile, avoid = new Set()) {
    const binary = config.ffmpeg || 'ffmpeg';
    const candidates = config.encoder === 'auto' ? Object.keys(codecOptions).slice(1).concat('libx264') : [config.encoder];
    for (const encoder of candidates) {
      if (avoid.has(encoder)) continue;
      const key = JSON.stringify([binary, profile.width, profile.height, profile.bitrate, encoder]);
      if (!this.cache.has(key)) this.cache.set(key, encoderWorks(binary, profile, encoder));
      if (await this.cache.get(key)) return encoder;
    }
    throw new Error('FFmpeg could not initialize H.264. Check the executable, graphics driver, or encoder setting.');
  }

  clear() { this.cache.clear(); }
}

export function ffmpegArgs(profile, encoder, destination, caFile) {
  const { width, height, fps } = profile;
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-nostats', '-stats_period', '1', '-progress', 'pipe:1',
    '-filter_threads', '1', '-probesize', '32', '-analyzeduration', '0', '-thread_queue_size', '4', '-threads', '1',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', `scale=${width}:${height}:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p`,
    ...videoArgs(profile, encoder),
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-flush_packets', '1',
  ];
  if (destination.startsWith('rtmps:')) args.push('-rw_timeout', '15000000', '-tls_verify', '1', '-ca_file', caFile);
  return [...args, '-flvflags', 'no_duration_filesize', '-f', 'flv', destination];
}

export async function trustBundle(directory) {
  const file = join(directory, 'youtube-ca.pem');
  await writeFile(file, getCACertificates('default').join('\n') + '\n');
  return file;
}

export class MediaError extends Error {
  constructor(message, { encoder, fallback } = {}) {
    super(message);
    this.encoder = encoder;
    this.fallback = fallback;
  }
}

function ffmpegError(stderr, encoder) {
  if (/encoder not found|error (?:while )?opening encoder|initializ.{0,30}encoder|no capable devices|mfx session|amf failed|cannot load (?:nvcuda|nvencode)|openencodesessionex failed|no free encode sessions/i.test(stderr)) {
    return new MediaError(`FFmpeg could not initialize ${encoder} for this stream.`, { encoder, fallback: true });
  }
  if (/certificate|TLS|SSL|handshake/i.test(stderr)) return new MediaError('FFmpeg could not verify the encrypted YouTube connection.');
  if (/badname|already.*publish|server error|not permitted/i.test(stderr)) return new MediaError('The ingest server rejected the encoder. Check the stream in YouTube Studio.');
  if (/timed out|refused|unreachable|broken pipe|reset by peer|resolve|input\/output/i.test(stderr)) {
    return new MediaError('The encoder connection was interrupted.');
  }
  return new MediaError(`FFmpeg exited while using ${encoder}. Check encoder settings and available resources.`);
}

export function encode({ overlay, config, profile, encoder, destination, caFile, onError }) {
  const child = spawn(config.ffmpeg || 'ffmpeg', ffmpegArgs(profile, encoder, destination, caFile), {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const metrics = { encoder, frames: 0, fps: 0, captureFps: 0, speed: 0 };
  let stopped = false;
  let stopping;
  let failure;
  let stderr = '';
  let progress = '';
  let lastFrame = overlay.first;
  let lastOutput = Date.now();
  let frameCount = 0;
  let sampleAt = Date.now();
  let timeout;
  let ticker;
  let health;
  let checking = false;
  const closed = new Promise(resolve => child.once('close', resolve));
  const fail = error => {
    if (stopped || failure) return;
    failure = error;
    onError(error);
  };
  child.once('spawn', () => lowerPriority(child.pid));
  child.once('error', () => fail(new MediaError('FFmpeg could not start. Check the executable in Settings.')));
  child.once('close', () => fail(ffmpegError(stderr, encoder)));
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.stdout.on('data', chunk => {
    progress += chunk.toString();
    const groups = progress.split(/progress=(?:continue|end)\r?\n/);
    progress = groups.pop().slice(-8192);
    for (const group of groups) {
      const fields = new URLSearchParams(group.trim().replaceAll('\r', '').replaceAll('\n', '&'));
      const frames = Number(fields.get('frame')) || 0;
      if (frames > metrics.frames) lastOutput = Date.now();
      metrics.frames = frames;
      metrics.fps = Number(fields.get('fps')) || 0;
      metrics.speed = Number(fields.get('speed')?.trim().replace(/x$/, '')) || 0;
    }
  });

  const capture = async () => {
    const startedAt = Date.now();
    try {
      lastFrame = await overlay.frame();
      frameCount++;
    } catch {
      fail(new MediaError('Chromium stopped capturing the BambuBoard overlay.'));
    }
    if (!stopped && !failure) timeout = setTimeout(capture, Math.max(0, 1000 / profile.captureFps - (Date.now() - startedAt)));
  };
  const streamStart = Date.now();
  let sent = 0;
  const sendFrame = () => {
    if (stopped || failure) return;
    if (!child.stdin.destroyed && !child.stdin.writableNeedDrain) {
      // Catch up a few frames after short pipe stalls without buffering a growing queue.
      const expected = Math.floor((Date.now() - streamStart) * profile.fps / 1000) + 1;
      for (let count = 0; count < 3 && sent < expected && !child.stdin.writableNeedDrain; count++, sent++) {
        child.stdin.write(lastFrame);
      }
    }
  };
  sendFrame();
  ticker = setInterval(sendFrame, 1000 / profile.fps);
  timeout = setTimeout(capture, 0);
  health = setInterval(async () => {
    if (stopped || failure) return;
    const now = Date.now();
    metrics.captureFps = Math.round(frameCount * 1000 / (now - sampleAt));
    frameCount = 0;
    sampleAt = now;
    if (now - lastOutput > (metrics.frames ? 18000 : 40000)) {
      fail(new MediaError('FFmpeg stopped sending frames. Check the encoder load or ingest connection.'));
    }
    if (checking) return;
    checking = true;
    try {
      const state = await overlay.inspect();
      metrics.camera = state?.camera;
      metrics.toolpath = state?.toolpath;
      if (!state?.scene || state.url !== config.overlay) fail(new MediaError('BambuBoard’s /live scene stopped rendering.'));
    } catch {
      fail(new MediaError('Chromium stopped responding.'));
    } finally { checking = false; }
  }, 7000);

  function stop() {
    if (stopping) return stopping;
    stopped = true;
    clearTimeout(timeout);
    clearInterval(ticker);
    clearInterval(health);
    stopping = (async () => {
      child.stdin.end();
      const kill = setTimeout(() => child.kill(), 2500);
      try { await Promise.all([closed, overlay.stop()]); }
      finally { clearTimeout(kill); }
    })();
    return stopping;
  }
  return { metrics, stop };
}

export async function previewOverlay(config, printer, signal) {
  const profile = streamProfile(config);
  const overlay = await openOverlay(config, printer.overlay, profile, signal);
  try {
    let scene;
    const until = Date.now() + 8000;
    do {
      await sleep(700, undefined, { signal });
      scene = await overlay.inspect();
    } while (Date.now() < until && (scene.camera === 'Waiting for camera' || scene.toolpath === 'Waiting for G-code or WebGL'));
    const image = await overlay.frame();
    return { image, ...scene };
  } finally { await overlay.stop(); }
}
