import { existsSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export const printerIds = ['x1c', 'h2c'];
const modelNames = { x1c: 'X1C', h2c: 'H2C' };
export const encoders = ['auto', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
export const videoSizes = { '720p': [1280, 720], '1080p': [1920, 1080] };

export const defaults = {
  automatic: false,
  privacy: 'unlisted',
  youtubePlaylistId: '',
  maxStreams: 2,
  resolution: '720p',
  captureFps: 12,
  bitrate: 4000,
  encoder: 'auto',
  ffmpeg: '',
  chromium: '',
  softwareWebgl: false,
  discordChannel: '',
  printers: Object.fromEntries(printerIds.map((id, i) => [id, {
    name: modelNames[id], host: '', port: 8883, serial: '',
    overlay: `http://127.0.0.1:${8080 + i}/live`, fingerprint: '',
  }])),
};

export class InputError extends Error {}

function fail(message) { throw new InputError(message); }

function choice(value, choices, label) {
  if (!choices.includes(value)) fail(`Choose a valid ${label}.`);
  return value;
}

function number(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be from ${min} to ${max}.`);
  return value;
}

function field(value, max, label) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} is invalid.`);
  return value.trim();
}

function matches(value, pattern, label) {
  if (value && !pattern.test(value)) fail(`${label} is invalid.`);
  return value;
}

function overlayUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { fail('Enter a complete BambuBoard /live address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/live' || url.search || url.hash) {
    fail('Use the published BambuBoard /live address without a login, query, or fragment.');
  }
  return url.href;
}

function playlistId(raw) {
  const value = field(raw, 512, 'YouTube playlist');
  if (!value) return '';
  const valid = /^[A-Za-z0-9_-]{10,100}$/;
  if (valid.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { fail('Enter a YouTube playlist link or ID.'); }
  const id = url.searchParams.get('list') ?? '';
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname) ||
      url.username || url.password || !valid.test(id)) fail('Enter a YouTube playlist link or ID.');
  return id;
}

export function readConfig(saved) {
  return {
    ...defaults,
    ...saved,
    printers: Object.fromEntries(printerIds.map(id => [id, { ...defaults.printers[id], ...saved?.printers?.[id] }])),
  };
}

export function configured(printer, credentials) {
  return Boolean(printer.host && printer.serial && credentials);
}

export function parseConfig(input, credentials) {
  const next = readConfig(input);
  const secrets = { ...credentials, printers: { ...credentials.printers } };
  const config = {
    automatic: next.automatic === true,
    privacy: choice(next.privacy, ['unlisted', 'private', 'public'], 'visibility'),
    youtubePlaylistId: playlistId(next.youtubePlaylistId),
    maxStreams: number(next.maxStreams, 1, 2, 'Simultaneous streams'),
    resolution: choice(next.resolution, Object.keys(videoSizes), 'resolution'),
    captureFps: number(next.captureFps, 5, 30, 'Capture frame rate'),
    bitrate: number(next.bitrate, 1000, 20000, 'Video bitrate'),
    encoder: choice(next.encoder, encoders, 'encoder'),
    ffmpeg: field(next.ffmpeg, 512, 'FFmpeg path'),
    chromium: field(next.chromium, 512, 'Chromium path'),
    softwareWebgl: next.softwareWebgl === true,
    discordChannel: matches(field(next.discordChannel, 24, 'Discord channel ID'), /^\d{17,20}$/, 'Discord channel ID'),
    printers: {},
  };

  for (const id of printerIds) {
    const printer = next.printers[id];
    const host = field(printer.host, 253, 'Printer address');
    if (host && !isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) fail('Enter a printer IP address or hostname.');
    const serial = matches(field(printer.serial, 40, 'Printer serial number'), /^[a-z0-9]+$/i, 'Printer serial number').toUpperCase();
    const code = field(printer.accessCode ?? '', 128, 'Printer access code');
    if (code) secrets.printers[id] = code;
    if (printer.clearAccessCode === true) delete secrets.printers[id];
    if (host && (!serial || !secrets.printers[id])) fail(`Enter the serial number and LAN access code for ${modelNames[id]}.`);
    config.printers[id] = {
      name: field(printer.name, 40, 'Printer name') || modelNames[id],
      host,
      port: number(printer.port, 1, 65535, 'MQTT port'),
      serial,
      overlay: overlayUrl(printer.overlay),
      fingerprint: matches(field(printer.fingerprint, 96, 'TLS fingerprint').replaceAll(':', '').toLowerCase(),
        /^[a-f0-9]{64}$/, 'SHA-256 TLS fingerprint'),
    };
  }
  const [x1c, h2c] = printerIds.map(id => config.printers[id]);
  if (x1c.host && h2c.host && (x1c.serial === h2c.serial || x1c.overlay === h2c.overlay)) {
    fail('Enter a different printer serial number and BambuBoard /live address for each printer.');
  }
  const token = field(input.discordToken ?? '', 300, 'Discord bot token');
  if (token) secrets.discordToken = token;
  if (input.clearDiscordToken === true) delete secrets.discordToken;
  return { config, secrets };
}

export function browserBinary(override) {
  if (override) {
    if (!existsSync(override) || !statSync(override).isFile()) throw new Error('The configured Chromium executable could not be found.');
    return override;
  }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (!root) continue;
    for (const suffix of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe', 'Chromium/Application/chrome.exe']) {
      const file = join(root, suffix);
      if (existsSync(file)) return file;
    }
  }
  throw new Error('Install Chrome or Edge, or enter a Chromium executable in Settings.');
}

export function streamProfile(config) {
  const [width, height] = videoSizes[config.resolution];
  return { width, height, bitrate: config.bitrate, captureFps: config.captureFps, fps: 30 };
}
