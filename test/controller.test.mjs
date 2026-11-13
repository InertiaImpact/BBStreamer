import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.mjs';
import { Controller } from '../src/controller.mjs';
import { ServiceError } from '../src/integrations.mjs';
import { PrintReports } from '../src/printer.mjs';
import { Store } from '../src/store.mjs';

const testVault = { seal: value => JSON.stringify(value), unseal: value => JSON.parse(value) };
const fakeIngest = id => ({
  id, cdn: { ingestionInfo: { rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2', streamName: 'fixture-only' } },
});

function fixture(t, { maxStreams = 2, automatic = true, youtubePlaylistId = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bbstreamer-test-'));
  let time = 100000;
  let controller, store;
  const printers = {};
  const remotes = new Map();
  const messages = new Map();
  const counts = { inserted: 0, posted: 0, edited: 0, completed: 0, removed: 0, started: 0, stopped: 0 };
  const youtube = {
    ensureIngest: async (_channel, title) => fakeIngest(title.endsWith('X1C') ? 'ingest1' : 'ingest2'),
    findBroadcast: async job => remotes.get(job.id),
    insertBroadcast: async job => {
      const event = { id: 'event' + ++counts.inserted, status: { lifeCycleStatus: 'created' }, contentDetails: {} };
      remotes.set(job.id, event);
      return event;
    },
    broadcast: async job => remotes.get(job.id),
    bind: async job => {
      const event = remotes.get(job.id);
      event.status.lifeCycleStatus = 'ready';
      event.contentDetails.boundStreamId = job.ingestId;
      return event;
    },
    complete: async job => {
      counts.completed++;
      const event = remotes.get(job.id);
      event.status.lifeCycleStatus = 'complete';
      return event;
    },
    remove: async job => { counts.removed++; remotes.delete(job.id); },
  };
  const discord = {
    botId: async () => 'bot1',
    findMessage: async job => messages.get(job.id),
    payload: (_job, label) => label,
    post: async (job, payload) => {
      const message = { id: 'message' + ++counts.posted, payload };
      messages.set(job.id, message);
      return message;
    },
    edit: async (job, payload) => { counts.edited++; messages.get(job.id).payload = payload; },
  };
  const media = {
    encoders: { clear() {}, choose: async () => 'libx264' },
    openOverlay: async () => ({ stop: async () => {}, inspect: async () => ({ camera: 'Ready', toolpath: 'Rendering' }) }),
    encode: ({ onError }) => {
      counts.started++;
      media.onError = onError;
      return { metrics: { encoder: 'libx264', frames: 60 }, stop: async () => { counts.stopped++; } };
    },
  };
  const config = readConfig({
    automatic, maxStreams, youtubePlaylistId, discordChannel: '100000000000000001',
    printers: { x1c: { host: '127.0.0.1', serial: 'X1CTEST' }, h2c: { host: '127.0.0.2', serial: 'H2CTEST' } },
  });
  const credentials = { google: { channel: { id: 'channel' } }, discordToken: 'fixture', printers: { x1c: 'x1c', h2c: 'h2c' } };
  const open = () => {
    store = new Store(dir, testVault);
    if (!store.get('config')) store.saveSettings(config, credentials);
    controller = new Controller({
      store, youtube, discord, media, now: () => time,
      monitor(options) {
        printers[options.printer.serial === 'X1CTEST' ? 'x1c' : 'h2c'] = { ...options, reports: new PrintReports() };
        return { close() {}, pushAll() {} };
      },
    });
    controller.start();
    clearInterval(controller.timer);
  };
  open();
  t.after(async () => {
    await controller.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    counts, media, remotes, messages, youtube, discord, dir,
    get store() { return store; },
    get controller() { return controller; },
    async restart() { await controller.close(); store.close(); open(); },
    report(id, fields) {
      const monitor = printers[id];
      monitor.onStatus('Connected');
      monitor.onReport(monitor.reports.accept(fields, time));
    },
    disconnect(id) { printers[id].onStatus('Reconnecting'); },
    async step(ms = 3000) {
      time += ms;
      controller.tick();
      await Promise.allSettled(controller.work.values());
    },
    live(id) { remotes.get(store.active(id).id).status.lifeCycleStatus = 'live'; },
  };
}

test('partial MQTT reports preserve job data and ignore command acknowledgments', () => {
  const reports = new PrintReports();
  const first = reports.accept({ command: 'push_status', gcode_state: 'RUNNING', subtask_id: '6', subtask_name: 'Clip.3mf', mc_percent: 25 }, 1);
  const partial = reports.accept({ command: 'push_status', layer_num: 6 }, 2);
  assert.equal(partial.name, 'Clip');
  assert.equal(partial.progress, 25);
  assert.equal(partial.stateAt, 1);
  assert.equal(partial.observedAt, 2);
  assert.equal(partial.explicitState, null);
  assert.equal(partial.layer, 6);
  assert.equal(reports.accept({ command: 'stop', gcode_state: 'IDLE' }, 3), null);
  assert.equal(reports.accept({ gcode_state: 'FAILED', print_error: 0x0300400c }, 4).outcome, 'Canceled');
  assert.equal(reports.accept({ gcode_state: 'PREPARE', subtask_id: '7' }, 5).name, null);
  assert.equal(first.identity.subtask, '6');
});

test('two printers get distinct broadcasts; restart reuses the live broadcast and Discord message', async t => {
  const f = fixture(t);
  f.report('x1c', { gcode_state: 'PREPARE', subtask_id: '123', subtask_name: 'Same model' });
  f.report('h2c', { gcode_state: 'RUNNING', subtask_id: '321', subtask_name: 'Same model' });
  await f.step();
  const x1c = f.store.active('x1c'), h2c = f.store.active('h2c');
  assert.equal(f.counts.inserted, 2);
  assert.equal(f.counts.started, 2);
  assert.notEqual(x1c.broadcastId, h2c.broadcastId);
  assert.notEqual(x1c.ingestId, h2c.ingestId);
  f.live('x1c');
  f.live('h2c');
  await f.step();
  await f.step();
  assert.equal(f.counts.posted, 2);
  assert.equal(f.messages.get(x1c.id).payload, 'Live');
  await f.restart();
  await f.step();
  assert.equal(f.counts.started, 2, 'A persisted job needs a fresh report before it resumes');
  f.report('x1c', { gcode_state: 'PAUSE', subtask_id: '123', mc_percent: 64 });
  f.report('h2c', { gcode_state: 'RUNNING', subtask_id: '321', mc_percent: 30 });
  await f.step();
  await f.step();
  assert.equal(f.counts.started, 4);
  assert.equal(f.counts.inserted, 2);
  assert.equal(f.counts.posted, 2);
  assert.equal(f.messages.get(x1c.id).payload, 'Print paused');
  f.report('x1c', { gcode_state: 'FINISH', subtask_id: '123', mc_percent: 100 });
  f.report('h2c', { gcode_state: 'FAILED', subtask_id: '321' });
  f.report('h2c', { print_error: '0300_400C' });
  await f.step();
  await f.step();
  assert.equal(f.counts.completed, 2);
  assert.equal(f.messages.get(x1c.id).payload, 'Completed');
  assert.equal(f.messages.get(h2c.id).payload, 'Canceled');
  assert.deepEqual(f.store.unsettled(), []);
});

test('lost insert response and lost Discord response are reconciled', async t => {
  const f = fixture(t);
  const insert = f.youtube.insertBroadcast;
  f.youtube.insertBroadcast = async job => { await insert(job); throw new ServiceError('YouTube', 502); };
  const post = f.discord.post;
  f.discord.post = async (...args) => { await post(...args); throw new ServiceError('Discord', 0); };
  f.report('x1c', { gcode_state: 'RUNNING', subtask_id: '123', subtask_name: 'Bracket' });
  await f.step();
  assert.equal(f.counts.inserted, 1);
  await f.restart();
  f.report('x1c', { gcode_state: 'RUNNING', subtask_id: '123' });
  await f.step();
  assert.equal(f.counts.inserted, 1);
  f.live('x1c');
  await f.step();
  await f.step();
  assert.equal(f.counts.posted, 1);
  assert.equal(f.store.active('x1c').discordMessageId, undefined);
  await f.restart();
  f.report('x1c', { gcode_state: 'FINISH', subtask_id: '123', mc_percent: 100 });
  await f.step();
  await f.step();
  assert.equal(f.counts.posted, 1);
  assert.equal(f.counts.edited, 1);
  assert.equal(f.store.recent()[0].discordDone, true);
});

test('a resource cap defers the second print and preserves broadcasts through telemetry loss', async t => {
  const f = fixture(t, { maxStreams: 1 });
  f.report('x1c', { gcode_state: 'RUNNING', subtask_id: '123', subtask_name: 'X part' });
  f.report('h2c', { gcode_state: 'RUNNING', subtask_id: '456', subtask_name: 'H part' });
  await f.step();
  assert.equal(f.counts.started, 1);
  assert.equal(f.store.active('h2c').channelId, undefined);
  const jobId = f.store.active('x1c').id;
  f.live('x1c');
  await f.step();
  f.disconnect('x1c');
  await f.step(91000);
  assert.equal(f.counts.stopped, 1);
  assert.equal(f.store.active('x1c').id, jobId);
  assert.equal(f.counts.completed, 0);
  f.report('x1c', { gcode_state: 'RUNNING', subtask_id: '123' });
  await f.step();
  assert.equal(f.counts.started, 2);
  assert.equal(f.counts.inserted, 1);
  f.report('h2c', { gcode_state: 'RUNNING', subtask_id: '456' });
  f.report('x1c', { gcode_state: 'FINISH', subtask_id: '123' });
  await f.step();
  await f.step();
  assert.equal(f.store.active('h2c').broadcastId, 'event2');
});

test('an unused scheduled event is removed and repeated prints of the same file get new jobs', async t => {
  const f = fixture(t);
  f.report('x1c', { gcode_state: 'RUNNING', subtask_id: '0', gcode_file: 'fixture.gcode', mc_percent: 70 });
  await f.step();
  const first = f.store.active('x1c');
  f.report('x1c', { gcode_state: 'FINISH', subtask_id: '0', mc_percent: 100 });
  await f.step();
  await f.step();
  assert.equal(f.counts.removed, 1);
  assert.equal(f.counts.posted, 0);
  f.report('x1c', { gcode_state: 'PREPARE', subtask_id: '0', gcode_file: 'fixture.gcode', mc_percent: 0 });
  await f.step();
  assert.notEqual(f.store.active('x1c').id, first.id);
  assert.equal(f.store.active('x1c').broadcastId, 'event2');
});

test('monitoring stays active while automatic streaming is off', async t => {
  const f = fixture(t, { automatic: false });
  f.report('x1c', { gcode_state: 'RUNNING', subtask_name: 'Local print' });
  await f.step();
  assert.equal(f.store.active('x1c').printName, 'Local print');
  assert.equal(f.counts.inserted, 0);
  assert.equal(f.counts.started, 0);
});

test('a progress reset after a missed finish starts a fresh local-file job', async t => {
  const f = fixture(t);
  f.report('x1c', { gcode_state: 'RUNNING', gcode_file: 'fixture.gcode', mc_percent: 95 });
  await f.step();
  const first = f.store.active('x1c');
  f.live('x1c');
  await f.step();
  f.report('x1c', { gcode_state: 'RUNNING', gcode_file: 'fixture.gcode', mc_percent: 0 });
  assert.notEqual(f.store.active('x1c').id, first.id);
  assert.equal(f.store.job(first.id).outcome, 'Ended · next print detected');
  await f.step();
  await f.step();
  assert.equal(f.store.active('x1c').broadcastId, 'event2');
});

test('one controller holds the data folder and releases it on close', async t => {
  const f = fixture(t);
  assert.throws(() => new Store(f.dir, testVault), /already has this data folder open/);
  await f.restart();
  assert.ok(f.store.get('config'));
});

test('playlist archiving retries after restart without holding up Discord or the next broadcast', async t => {
  const f = fixture(t, { youtubePlaylistId: 'PL-fixture-playlist' });
  let attempts = 0;
  f.youtube.archive = async (job, beforeInsert) => {
    assert.equal(job.youtubePlaylistId, 'PL-fixture-playlist');
    assert.equal(job.broadcastLife, 'complete');
    assert.equal(job.privacy, 'unlisted');
    if (attempts++ === 0) {
      beforeInsert();
      throw new ServiceError('YouTube', 502);
    }
    // The first request succeeded remotely and its response was lost.
    assert.ok(job.playlistAttemptAt);
  };
  f.report('x1c', { gcode_state: 'RUNNING', subtask_id: '123', subtask_name: 'Wall Mount Bracket' });
  await f.step();
  const first = f.store.active('x1c');
  f.live('x1c');
  await f.step();
  await f.step();
  assert.equal(attempts, 0);
  f.report('x1c', { gcode_state: 'FINISH', subtask_id: '123', mc_percent: 100 });
  await f.step();
  await f.step();
  assert.equal(attempts, 1);
  assert.equal(f.store.job(first.id).discordDone, true);
  assert.equal(f.store.job(first.id).settled, false);

  await f.restart();
  f.report('x1c', { gcode_state: 'RUNNING', subtask_id: '456', subtask_name: 'Second print' });
  await f.step();
  await f.step();
  assert.equal(attempts, 2);
  assert.equal(f.store.job(first.id).playlistDone, true);
  assert.equal(f.store.job(first.id).settled, true);
  assert.equal(f.store.active('x1c').broadcastId, 'event2');
});
