import { createHash, randomUUID } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';
import { connect as connectTls } from 'node:tls';
import mqtt from 'mqtt';

const states = new Set(['SLICING', 'PREPARE', 'RUNNING', 'PAUSE', 'IDLE', 'FINISH', 'FAILED', 'CANCELLED', 'CANCELED', 'STOPPED']);
export const activeStates = new Set(['SLICING', 'PREPARE', 'RUNNING', 'PAUSE']);
const printFields = ['gcode_state', 'subtask_id', 'task_id', 'subtask_name', 'task_name', 'gcode_file',
  'mc_percent', 'mc_remaining_time', 'layer_num', 'total_layer_num', 'print_error', 'gcode_start_time'];

function stateOf(value) {
  const state = typeof value === 'string' ? value.toUpperCase() : '';
  return states.has(state) ? state : null;
}

function reportId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text && !/^(?:0+|-1|none|null|undefined)$/i.test(text) ? text.slice(0, 80) : null;
}

function nonNegative(value, max) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? Math.round(number) : null;
}

function newPrintProgress(previous, next) {
  const prior = nonNegative(previous, 100);
  const current = nonNegative(next, 100);
  return prior != null && prior >= 90 && current != null && current <= 2;
}

function printName(raw) {
  const name = [raw.subtask_name, raw.task_name, raw.gcode_file].find(value => typeof value === 'string' && value.trim());
  return name?.split(/[/\\]/).at(-1).replace(/(?:\.gcode)?\.(?:3mf|gcode)$/i, '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 100) || null;
}

export class PrintReports {
  snapshot = {};
  stateAt = 0;
  observedAt = 0;

  accept(print, now) {
    if (!print || typeof print !== 'object' || (print.command && print.command !== 'push_status')) return null;
    const nextState = stateOf(print.gcode_state);
    const previousState = this.snapshot.gcode_state;
    const jobChanged = ['subtask_id', 'gcode_start_time'].some(key => {
      const previous = reportId(this.snapshot[key]);
      const next = reportId(print[key]);
      return previous && next && previous !== next;
    });
    if ((nextState && !activeStates.has(previousState) && activeStates.has(nextState)) ||
        (activeStates.has(nextState || previousState) && (jobChanged ||
          newPrintProgress(this.snapshot.mc_percent, print.mc_percent)))) {
      this.snapshot = { gcode_state: nextState || previousState };
    }

    let updated = false;
    for (const key of printFields) {
      if (!Object.hasOwn(print, key) || (key === 'gcode_state' && !nextState)) continue;
      this.snapshot[key] = key === 'gcode_state' ? nextState : print[key];
      updated = true;
    }
    if (nextState) this.stateAt = now;
    // A status heartbeat may contain only temperatures or AMS information.
    if (updated || print.command === 'push_status') this.observedAt = now;
    if (!this.snapshot.gcode_state || !(updated || print.command === 'push_status')) return null;

    const raw = this.snapshot;
    return {
      state: raw.gcode_state, explicitState: nextState, stateAt: this.stateAt, observedAt: this.observedAt,
      name: printName(raw),
      identity: { subtask: reportId(raw.subtask_id), task: reportId(raw.task_id), started: reportId(raw.gcode_start_time) },
      progress: nonNegative(raw.mc_percent, 100), remaining: nonNegative(raw.mc_remaining_time, 100000),
      layer: nonNegative(raw.layer_num, 100000), layers: nonNegative(raw.total_layer_num, 100000),
      outcome: outcomeOf(raw),
    };
  }
}

function outcomeOf(raw) {
  if (raw.gcode_state === 'FINISH') return 'Completed';
  if (['CANCELLED', 'CANCELED', 'STOPPED'].includes(raw.gcode_state)) return 'Canceled';
  if (raw.gcode_state === 'FAILED') {
    const code = String(raw.print_error ?? '').toUpperCase().replace(/^0X/, '').replaceAll('_', '');
    if (code === '0300400C' || Number(raw.print_error) === 0x0300400c) return 'Canceled';
    return 'Failed';
  }
  return null;
}

export function differentJob(prior, report) {
  let sameJob = false;
  for (const key of ['subtask', 'started']) {
    const left = prior.identity?.[key];
    const right = report.identity[key];
    if (!left || !right) continue;
    if (left !== right) return true;
    sameJob = true;
  }
  if (sameJob) return false;
  if (prior.identity?.task && report.identity.task && prior.identity.task !== report.identity.task) return true;
  if (activeStates.has(report.state) && newPrintProgress(prior.progress, report.progress)) return true;
  return Boolean(prior.printName && report.name && prior.printName !== report.name &&
    ((report.explicitState === 'PREPARE' && (prior.progress ?? 0) > 0) ||
      ((prior.progress ?? 0) >= 10 && report.progress != null && report.progress < prior.progress - 5)));
}

function printerTransport({ host, port, fingerprint }, onFailure) {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const transport = Duplex.from({ readable: inbound, writable: outbound });
  const socket = connectTls({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
  socket.once('secureConnect', () => {
    const cert = socket.getPeerCertificate();
    if (fingerprint && (!cert?.raw || createHash('sha256').update(cert.raw).digest('hex') !== fingerprint)) {
      onFailure('Certificate mismatch');
      socket.destroy();
      return;
    }
    outbound.pipe(socket);
    socket.pipe(inbound);
  });
  socket.on('error', () => {
    onFailure('Connection unavailable');
    transport.destroy();
  });
  socket.once('close', () => transport.destroy());
  transport.once('close', () => socket.destroy());
  return transport;
}

export class PrinterMonitor {
  constructor({ printer, code, onStatus, onReport }) {
    this.printer = printer;
    this.onStatus = onStatus;
    this.onReport = onReport;
    this.reports = new PrintReports();
    this.sequence = 23000 + Math.floor(Math.random() * 10000);
    const { serial } = printer;
    this.topic = `device/${serial}/report`;
    this.request = `device/${serial}/request`;

    // Stock printers use their own certificate. Hold the MQTT login until optional
    // fingerprint verification finishes.
    this.client = new mqtt.MqttClient(() => printerTransport(printer, reason => { this.lastError = reason; }), {
      clientId: `bbstreamer_${randomUUID().slice(0, 12)}`,
      protocolVersion: 4, username: 'bblp', password: code, clean: true, keepalive: 30,
      connectTimeout: 8000, reconnectPeriod: 0, resubscribe: false,
      manualConnect: true,
    });

    this.client.on('connect', () => {
      if (this.closed) return;
      clearTimeout(this.reconnect);
      this.reports = new PrintReports();
      this.failures = 0;
      this.lastError = null;
      this.onStatus('Waiting for telemetry');
      this.client.subscribe(this.topic, { qos: 0 }, (error, grants) => {
        if (error || !grants?.length || grants[0].qos === 128) {
          this.lastError = 'Subscription rejected';
          this.client.stream?.destroy();
        } else if (this.client.connected && !this.closed) {
          this.pushAll();
          clearInterval(this.poll);
          this.poll = setInterval(() => this.pushAll(), 300000);
          clearTimeout(this.firstStatus);
          this.firstStatus = setTimeout(() => {
            if (!this.reports.stateAt) this.pushAll();
          }, 15000);
        }
      });
    });
    this.client.on('message', (topic, payload, packet) => {
      if (this.closed || topic !== this.topic || packet.retain || payload.length > 1024 * 1024) return;
      let data;
      try { data = JSON.parse(payload); } catch { return; }
      const report = this.reports.accept(data?.print, Date.now());
      if (!report) return;
      this.onStatus('Connected');
      this.onReport(report);
      if (!report.name && ['SLICING', 'PREPARE', 'RUNNING'].includes(report.state) &&
          Date.now() - (this.lastPush ?? 0) >= 5000) this.pushAll();
    });
    this.client.on('error', error => {
      if (this.closed) return;
      if (error.code === 4 || error.code === 5) this.lastError = 'Access rejected';
      else this.lastError ??= 'Connection unavailable';
    });
    this.client.on('close', () => {
      clearInterval(this.poll);
      clearTimeout(this.firstStatus);
      if (this.closed) return;
      this.onStatus(this.lastError || 'Reconnecting');
      clearTimeout(this.reconnect);
      const delay = Math.min(60000, 2000 * 2 ** Math.min(this.failures ?? 0, 5));
      this.failures = (this.failures ?? 0) + 1;
      this.reconnect = setTimeout(() => {
        this.lastError = null;
        this.client.reconnect();
      }, delay + Math.floor(Math.random() * 750));
    });
    this.client.connect();
  }

  pushAll() {
    if (!this.closed && this.client.connected) {
      this.lastPush = Date.now();
      this.client.publish(this.request, JSON.stringify({
        pushing: { sequence_id: ++this.sequence, command: 'pushall' },
      }), { qos: 0 });
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnect);
    clearTimeout(this.firstStatus);
    clearInterval(this.poll);
    this.client.end(true);
  }
}
