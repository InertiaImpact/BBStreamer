import { randomUUID } from 'node:crypto';
import { configured, printerIds, readConfig, streamProfile } from './config.mjs';
import { YouTube, watchUrl } from './integrations.mjs';
import { Encoders, encode, openOverlay, previewOverlay } from './media.mjs';
import { activeStates, differentJob, PrinterMonitor } from './printer.mjs';

const staleMs = 90000;
const offlineGraceMs = 90000;
const idleGraceMs = 15000;
const createGraceMs = 120000;

function jobProgress(report, job) {
  return {
    printName: report.name ?? job?.printName ?? null,
    identity: Object.fromEntries(Object.entries(report.identity).map(([key, value]) => [key, value ?? job?.identity?.[key] ?? null])),
    progress: report.progress ?? job?.progress ?? null,
    remaining: report.remaining ?? job?.remaining ?? null,
    layer: report.layer ?? job?.layer ?? null,
    layers: report.layers ?? job?.layers ?? null,
  };
}

function remoteState(broadcast) {
  return broadcast?.status?.lifeCycleStatus ?? (broadcast ? 'created' : 'removed');
}

const remoteEnded = state => ['complete', 'revoked', 'removed'].includes(state);

export class Controller {
  constructor({ store, youtube, discord, caFile, monitor = options => new PrinterMonitor(options),
    media = { openOverlay, encode, previewOverlay, encoders: new Encoders() }, now = Date.now }) {
    Object.assign(this, { store, youtube, discord, caFile, monitor, media, now });
    this.views = new Map();
    this.sessions = new Map();
    this.work = new Map();
    this.retries = new Map();
    this.nextYouTubePoll = new Map();
    this.avoidEncoders = new Map();
    this.events = [];
  }

  start() {
    this.applyConfig(readConfig(this.store.get('config')));
    this.timer = setInterval(() => this.tick(), 3000);
  }

  log(message) {
    this.events.unshift({ at: this.now(), message });
    this.events.length = Math.min(this.events.length, 40);
  }

  applyConfig(config) {
    this.config = config;
    this.retries.clear();
    this.media.encoders.clear();
    this.avoidEncoders.clear();
    for (const id of printerIds) {
      const printer = config.printers[id];
      const code = this.store.credentials.printers?.[id];
      const key = JSON.stringify([printer.host, printer.port, printer.serial, printer.fingerprint, code]);
      const view = this.views.get(id);
      if (view?.key === key) continue;
      view?.monitor?.close();
      const job = this.store.active(id);
      if (job && (!configured(printer, code) || (job.serial && job.serial !== printer.serial))) {
        this.finish(job, 'Printer configuration changed');
      }
      const next = { key, connection: configured(printer, code) ? 'Connecting' : 'Set up printer', report: null };
      this.views.set(id, next);
      if (!configured(printer, code)) continue;
      next.monitor = this.monitor({
        printer, code,
        onStatus: status => {
          if (this.closed || this.views.get(id) !== next) return;
          if (status === 'Connected') next.offlineAt = null;
          else if (next.connection !== status) next.offlineAt ??= this.now();
          if (next.connection !== status) {
            next.connection = status;
            this.log(`${this.config.printers[id].name} · ${status}`);
          }
        },
        onReport: report => {
          if (!this.closed && this.views.get(id) === next) this.observe(id, report);
        },
      });
    }
  }

  observe(id, report) {
    const view = this.views.get(id);
    view.report = report;
    let job = this.store.active(id);
    if (activeStates.has(report.state)) {
      if (job && (differentJob(job, report) || this.sameFileRestart(job, report, view))) {
        this.store.transaction(() => {
          this.finish(job, view.failed?.report.outcome ?? 'Ended · next print detected', view.failed?.report);
          this.createJob(id, report);
        });
        job = null;
      } else if (!job && (report.name || ['RUNNING', 'PAUSE'].includes(report.state))) {
        this.createJob(id, report);
      }
      view.idleAt = null;
      view.failed = null;
      if (!job) return;
      const fields = jobProgress(report, job);
      if (report.state !== job.printState || fields.printName !== job.printName ||
          Object.keys(fields.identity).some(key => fields.identity[key] !== job.identity?.[key]) ||
          this.now() - job.observedAt >= 10000) {
        this.store.patchJob(job.id, { ...fields, printState: report.state, observedAt: report.observedAt });
      }
      return;
    }
    if (!job) return;
    if (report.outcome && !differentJob(job, report)) {
      if (report.state === 'FAILED') {
        view.failed = { report, at: view.failed?.at ?? this.now() };
      } else {
        this.finish(job, report.outcome, report);
      }
    } else if (report.explicitState === 'IDLE' || (report.outcome && differentJob(job, report))) {
      view.idleAt ??= this.now();
    }
  }

  sameFileRestart(job, report, view) {
    if (report.identity.subtask || report.identity.started || view.failed) return false;
    return report.explicitState === 'PREPARE' && job.printState !== 'PREPARE' &&
      (job.progress ?? 0) >= 10 && report.progress != null && report.progress <= 2;
  }

  createJob(id, report) {
    const printer = this.config.printers[id];
    const job = this.store.saveJob({
      id: randomUUID(), printer: id, printerName: printer.name, serial: printer.serial,
      startedAt: this.now(), observedAt: report.observedAt, printState: report.state,
      ...jobProgress(report), settled: false,
    });
    this.log(`${job.printerName} · Print detected`);
    return job;
  }

  finish(job, outcome, report) {
    this.store.patchJob(job.id, {
      ...(report ? jobProgress(report, job) : {}),
      endedAt: this.now(), outcome, settled: !job.channelId,
    });
    this.nextYouTubePoll.delete(job.id);
    this.retries.delete(`YouTube:${job.id}`);
    this.stopSession(job.id);
    this.log(`${job.printerName} · ${outcome}`);
  }

  fresh(view) {
    return view?.connection === 'Connected' && view.report && this.now() - view.report.observedAt < staleMs;
  }

  refreshPrinters() {
    for (const [id, view] of this.views) {
      if (view.failed && this.now() - view.failed.at >= 2500) {
        const job = this.store.active(id);
        if (job) this.finish(job, view.failed.report.outcome, view.failed.report);
        view.failed = null;
      }
      if (view.idleAt != null && this.fresh(view) && !activeStates.has(view.report.state) &&
          this.now() - view.idleAt >= idleGraceMs) {
        const job = this.store.active(id);
        if (job) this.finish(job, 'Ended · printer reported no active print');
        view.idleAt = null;
      }
      if (view.monitor && this.now() >= (view.nextRefresh ?? 0) && (
        view.idleAt != null || view.connection === 'Waiting for telemetry' ||
        (view.connection === 'Connected' && this.now() - (view.report?.observedAt ?? 0) > 45000)
      )) {
        view.monitor.pushAll();
        view.nextRefresh = this.now() + 20000;
      }
    }
  }

  tick() {
    if (this.closed) return;
    this.refreshPrinters();
    const busy = new Set();
    for (let job of this.store.unsettled()) {
      if (job.endedAt) {
        this.stopSession(job.id);
        if (!job.youtubeDone && job.channelId) {
          busy.add(`${job.printer}:${job.channelId}`);
          if (this.now() >= (this.nextYouTubePoll.get(job.id) ?? 0)) this.run('YouTube', job, () => this.finalize(job));
        }
        if (!job.discordDone && (job.youtubeDone || job.liveAt)) this.run('Discord', job, () => this.announce(job));
        const archivePending = job.youtubeDone && job.broadcastLife === 'complete' && job.liveAt &&
          job.youtubePlaylistId && !job.playlistDone;
        if (archivePending) this.run('Playlist', job, () => this.archive(job));
        if ((!job.channelId || job.youtubeDone) && (!job.discordChannel || job.discordDone) && !archivePending) {
          this.store.patchJob(job.id, { settled: true });
          this.nextYouTubePoll.delete(job.id);
          this.avoidEncoders.delete(job.id);
        }
        continue;
      }

      const view = this.views.get(job.printer);
      const channel = job.channelId || this.store.credentials.google?.channel.id;
      const fresh = this.fresh(view) && activeStates.has(view.report.state);
      if (!fresh && this.now() - (view?.offlineAt ?? view?.report?.observedAt ?? job.observedAt) >= offlineGraceMs) {
        this.stopSession(job.id);
      }
      if (!job.remoteClosed && !busy.has(`${job.printer}:${channel}`) && !this.previewing && fresh && this.now() - job.startedAt >= 2500) {
        const session = this.sessions.get(job.id);
        if (session?.media && !session.stopping) {
          if (this.now() >= (this.nextYouTubePoll.get(job.id) ?? 0)) {
            this.run('YouTube', job, () => this.checkBroadcast(job));
          }
        } else if (!session && this.sessions.size < this.config.maxStreams &&
            channel && (job.channelId || this.config.automatic)) {
          this.run('YouTube', job, async () => {
            if (this.sessions.size >= this.config.maxStreams || this.previewing) return;
            if (!job.channelId) {
              job = this.store.patchJob(job.id, {
                channelId: this.store.credentials.google.channel.id, privacy: this.config.privacy,
                youtubePlaylistId: this.config.youtubePlaylistId || null,
                discordChannel: this.config.discordChannel || null,
              });
            }
            await this.startSession(job);
          });
        }
      }
      if (job.liveAt && job.discordChannel) this.run('Discord', job, () => this.announce(job));
    }
  }

  run(lane, job, action) {
    const key = `${lane}:${job.id}`;
    if (this.work.has(key) || this.now() < (this.retries.get(key)?.at ?? 0)) return;
    const promise = Promise.resolve().then(() => {
      if (this.closed) return;
      // The two printers can reach this point in the same tick. startSession rechecks capacity.
      return action();
    }).then(() => this.retries.delete(key)).catch(error => {
      if (!this.closed && error.name !== 'AbortError') this.backoff(lane, job, error);
    }).finally(() => this.work.delete(key));
    this.work.set(key, promise);
  }

  backoff(lane, job, error) {
    const key = `${lane}:${job.id}`;
    const previous = this.retries.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const delay = Math.min(300000, 3000 * 2 ** Math.min(failures, 7));
    const quota = /quotaExceeded|dailyLimitExceeded/.test(error.reason ?? '') ? 1800000 : 0;
    const message = error.message || 'Connection interrupted.';
    this.retries.set(key, { at: this.now() + Math.max(delay, quota, error.retryMs ?? 0), message, failures });
    if (previous?.message !== message) this.log(`${job.printerName} · ${lane} · ${message}`);
  }

  assertRunning(job, session) {
    if (this.closed || this.store.job(job.id).endedAt || session.abort.signal.aborted) {
      throw new DOMException('Capture stopped.', 'AbortError');
    }
  }

  async startSession(job) {
    if (this.sessions.size >= this.config.maxStreams || this.sessions.has(job.id) ||
        [...this.sessions.values()].some(session => session.printer === job.printer) ||
        this.previewing || this.store.job(job.id).endedAt) return;
    const config = { ...this.config, overlay: this.config.printers[job.printer].overlay };
    const profile = streamProfile(config);
    const session = { printer: job.printer, abort: new AbortController() };
    this.sessions.set(job.id, session);
    try {
      const encoder = await this.media.encoders.choose(config, profile, this.avoidEncoders.get(job.id));
      this.assertRunning(job, session);
      session.overlay = await this.media.openOverlay(config, config.overlay, profile, session.abort.signal);
      this.assertRunning(job, session);
      const key = `ingest:${job.channelId}:${job.printer}`;
      let installation = this.store.get('installation');
      if (!installation) {
        installation = randomUUID().slice(0, 12);
        this.store.set('installation', installation);
      }
      const stream = await this.youtube.ensureIngest(job.channelId, `BBStreamer ${installation} ${job.printer.toUpperCase()}`, this.store.get(key));
      this.store.set(key, stream.id);
      const destination = YouTube.destination(stream);
      this.assertRunning(job, session);
      job = this.store.patchJob(job.id, { ingestId: stream.id });

      let broadcast = job.broadcastId ? await this.youtube.broadcast(job) : await this.findOrCreate(job, session);
      job = this.saveBroadcast(job, broadcast);
      this.assertRunning(job, session);
      if (job.remoteClosed) return;

      const bound = broadcast?.contentDetails?.boundStreamId;
      if (bound && bound !== job.ingestId && !['created', 'ready'].includes(job.broadcastLife)) {
        throw new Error('The active YouTube broadcast is bound to another ingest stream.');
      }
      if (bound !== job.ingestId) {
        broadcast = await this.youtube.bind(job);
        job = this.saveBroadcast(job, broadcast);
        this.assertRunning(job, session);
      }

      const info = await session.overlay.inspect();
      this.assertRunning(job, session);
      session.media = this.media.encode({
        overlay: session.overlay, config, profile, encoder, destination, caFile: this.caFile,
        onError: error => {
          if (this.closed || this.sessions.get(job.id) !== session || session.stopping) return;
          if (error.fallback && config.encoder === 'auto') {
            const avoid = this.avoidEncoders.get(job.id) ?? new Set();
            avoid.add(encoder);
            this.avoidEncoders.set(job.id, avoid);
          }
          this.backoff('YouTube', job, error);
          this.stopSession(job.id);
        },
      });
      Object.assign(session.media.metrics, { camera: info?.camera, toolpath: info?.toolpath });
      session.startedAt = this.now();
      this.nextYouTubePoll.set(job.id, this.now() + 3000);
      this.log(`${job.printerName} · Encoder started using ${encoder}`);
    } finally {
      if (!session.media) {
        try { await session.overlay?.stop(); }
        finally { if (this.sessions.get(job.id) === session) this.sessions.delete(job.id); }
      }
    }
  }

  async findOrCreate(job, session) {
    if (job.insertAttemptAt) {
      const found = await this.youtube.findBroadcast(job);
      if (found) return found;
      const remaining = createGraceMs - (this.now() - job.insertAttemptAt);
      if (remaining > 0) {
        const error = new Error('Checking whether YouTube created the scheduled broadcast.');
        error.retryMs = remaining;
        throw error;
      }
    }
    this.assertRunning(job, session);
    job = this.store.patchJob(job.id, { insertAttemptAt: this.now() });
    try {
      const broadcast = await this.youtube.insertBroadcast(job);
      if (!broadcast?.id) throw new Error('YouTube returned no broadcast ID. Checking for the scheduled broadcast.');
      return broadcast;
    } catch (error) {
      if (error.uncertain === false) this.store.patchJob(job.id, { insertAttemptAt: null });
      throw error;
    }
  }

  saveBroadcast(job, broadcast) {
    const state = remoteState(broadcast);
    const latest = this.store.job(job.id);
    const actualStart = Date.parse(broadcast?.snippet?.actualStartTime);
    return this.store.patchJob(job.id, {
      broadcastId: broadcast?.id || latest.broadcastId,
      broadcastLife: state,
      liveAt: latest.liveAt || (Number.isFinite(actualStart) ? actualStart : state === 'live' ? this.now() : null),
      remoteClosed: remoteEnded(state),
    });
  }

  async checkBroadcast(job) {
    const broadcast = await this.youtube.broadcast(job);
    const current = this.saveBroadcast(job, broadcast);
    if (current.remoteClosed) {
      this.stopSession(job.id);
      this.log(`${job.printerName} · YouTube broadcast closed`);
      return;
    }
    const live = current.broadcastLife === 'live';
    if (live && !job.liveAt) this.log(`${job.printerName} · Broadcast live on YouTube`);
    this.nextYouTubePoll.set(job.id, this.now() + (live ? 120000 : 10000));
    const session = this.sessions.get(job.id);
    if (live || !session?.media || this.now() - session.startedAt <= 90000) return;
    if (current.broadcastLife === 'ready') {
      const stream = await this.youtube.stream(job.channelId, current.ingestId);
      if (stream?.status?.streamStatus === 'active' && !this.store.job(job.id).endedAt) {
        this.saveBroadcast(current, await this.youtube.goLive(current));
        return;
      }
    }
    if (this.now() - session.startedAt > 150000) {
      this.stopSession(job.id);
      throw new Error('YouTube did not take the broadcast live. Retrying the existing broadcast.');
    }
  }

  async finalize(job) {
    if (!job.broadcastId && job.insertAttemptAt) {
      const found = await this.youtube.findBroadcast(job);
      if (found) job = this.saveBroadcast(job, found);
      else if (this.now() - job.insertAttemptAt < createGraceMs) {
        const error = new Error('Checking whether YouTube created a broadcast before the print ended.');
        error.retryMs = createGraceMs - (this.now() - job.insertAttemptAt);
        throw error;
      }
    }
    if (!job.broadcastId || job.remoteClosed) {
      this.store.patchJob(job.id, { youtubeDone: true });
      return;
    }
    const remote = await this.youtube.broadcast(job);
    job = this.saveBroadcast(job, remote);
    if (job.remoteClosed) {
      this.store.patchJob(job.id, { youtubeDone: true });
      return;
    }
    if (['live', 'testing'].includes(job.broadcastLife)) {
      const result = await this.youtube.complete(job);
      this.nextYouTubePoll.set(job.id, this.now() + 6000);
      if (result?.status?.lifeCycleStatus === 'complete') {
        this.saveBroadcast(job, result);
        this.store.patchJob(job.id, { youtubeDone: true });
      }
      return;
    }
    if (['liveStarting', 'testStarting'].includes(job.broadcastLife)) {
      this.nextYouTubePoll.set(job.id, this.now() + 6000);
      return;
    }
    if (['created', 'ready'].includes(job.broadcastLife) && !job.liveAt) {
      try { await this.youtube.remove(job); }
      catch (error) { if (error.status !== 404) throw error; }
      this.store.patchJob(job.id, { youtubeDone: true, remoteClosed: true, broadcastLife: 'removed' });
      return;
    }
    throw new Error('YouTube is still changing the broadcast state. Checking again.');
  }

  async archive(job) {
    await this.youtube.archive(job, () => {
      const wait = job.playlistAttemptAt ? 30000 - (this.now() - job.playlistAttemptAt) : 0;
      if (wait > 0) {
        const error = new Error('Checking whether YouTube already added the replay to the playlist.');
        error.retryMs = wait;
        throw error;
      }
      this.store.patchJob(job.id, { playlistAttemptAt: this.now() });
    });
    this.store.patchJob(job.id, { playlistDone: true });
    this.log(`${job.printerName} · Replay added to YouTube playlist`);
  }

  async announce(job) {
    job = this.store.job(job.id);
    if (!job.discordChannel || job.discordDone) return;
    if (!job.liveAt) {
      if (job.endedAt && job.youtubeDone) this.store.patchJob(job.id, { discordDone: true });
      return;
    }
    const view = this.views.get(job.printer);
    const session = this.sessions.get(job.id);
    const label = job.outcome || (job.remoteClosed ? 'Broadcast ended · print ongoing' :
      !this.fresh(view) ? 'Printer connection interrupted' :
      !session?.media?.metrics.frames || session.stopping ? 'Stream reconnecting' :
      view.report.state === 'PAUSE' ? 'Print paused' : 'Live');
    if (job.discordMessageId && job.discordLabel === label && !job.endedAt &&
        this.now() - job.discordUpdatedAt < 600000) return;
    const token = this.store.credentials.discordToken;
    const bot = await this.discord.botId(token);
    if (job.discordBotId && job.discordBotId !== bot) throw new Error('Reconnect the Discord bot that owns this print announcement.');
    if (!job.discordMessageId) {
      const found = job.discordAttemptAt ? await this.discord.findMessage(job, token) : null;
      if (found) job = this.store.patchJob(job.id, { discordMessageId: found.id });
      else {
        job = this.store.patchJob(job.id, { discordBotId: bot, discordAttemptAt: job.discordAttemptAt || this.now() });
        const posted = await this.discord.post(job, this.discord.payload(job, label), token);
        if (!posted?.id) throw new Error('Discord returned no message ID. Checking channel history.');
        this.store.patchJob(job.id, {
          discordMessageId: posted.id, discordLabel: label, discordUpdatedAt: this.now(), discordDone: Boolean(job.endedAt),
        });
        this.log(`${job.printerName} · Discord announcement posted`);
        return;
      }
    }
    try { await this.discord.edit(job, this.discord.payload(job, label), token); }
    catch (error) { if (error.status !== 404) throw error; }
    this.store.patchJob(job.id, { discordLabel: label, discordUpdatedAt: this.now(), discordDone: Boolean(job.endedAt) });
  }

  stopSession(id) {
    const session = this.sessions.get(id);
    if (!session || session.stopping) return session?.stopping;
    session.abort.abort();
    if (!session.media) return;
    session.stopping = session.media.stop().catch(() => {
      this.log('The capture process reported an error while closing.');
    }).finally(() => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
    return session.stopping;
  }

  preview(id) {
    if (this.previewing || this.sessions.size) throw new Error('Preview is available while the encoders are idle.');
    const abort = new AbortController();
    const promise = this.media.previewOverlay(this.config, this.config.printers[id], abort.signal)
      .finally(() => { this.previewing = null; });
    this.previewing = { abort, promise };
    return promise;
  }

  snapshot() {
    const printers = Object.fromEntries(printerIds.map(id => {
      const view = this.views.get(id);
      const job = this.store.active(id);
      const session = this.sessions.get(job?.id);
      const error = job && this.retries.get(`YouTube:${job.id}`);
      const discordError = job && this.retries.get(`Discord:${job.id}`);
      const phase = !job ? 'Idle' : job.remoteClosed ? 'Broadcast ended' :
        session?.media && !session.stopping ? job.broadcastLife === 'live' && session.media.metrics.frames > 0 ? 'On air' : 'Sending to YouTube' :
        session && !session.stopping ? 'Starting' :
        error ? 'Retrying' : this.config.automatic || job.channelId ? 'Waiting to stream' : 'Monitoring';
      return [id, {
        connection: view.connection === 'Connected' && !this.fresh(view) ? 'Telemetry stale' : view.connection,
        observedAt: view.report?.observedAt, report: view.report, phase, job, metrics: session?.media?.metrics,
        error, discordError, url: job?.broadcastId ? watchUrl(job.broadcastId) : null,
      }];
    }));
    return {
      printers, events: this.events, channel: this.store.credentials.google?.channel ?? null,
      automatic: this.config.automatic, streamCount: this.sessions.size, maxStreams: this.config.maxStreams,
      recent: this.store.recent().filter(job => job.endedAt).slice(0, 8).map(job => ({
        ...job, url: job.liveAt && job.broadcastId ? watchUrl(job.broadcastId) : null,
        error: this.retries.get(`YouTube:${job.id}`) ?? this.retries.get(`Discord:${job.id}`) ??
          this.retries.get(`Playlist:${job.id}`),
      })),
    };
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const view of this.views.values()) view.monitor?.close();
    this.previewing?.abort.abort();
    await Promise.allSettled([
      this.previewing?.promise,
      ...[...this.sessions.keys()].map(id => this.stopSession(id)),
      ...this.work.values(),
    ]);
  }
}
