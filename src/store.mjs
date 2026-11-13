import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function dpapi(operation, value) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
    `$result = [Security.Cryptography.ProtectedData]::${operation}($data, $null, 'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: value, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('Windows could not access the saved credentials. Run BBStreamer under the Windows account that saved them.');
  }
  return result.stdout.trim();
}

const windowsVault = {
  seal: data => dpapi('Protect', Buffer.from(JSON.stringify(data)).toString('base64')),
  unseal: blob => JSON.parse(Buffer.from(dpapi('Unprotect', blob), 'base64').toString('utf8')),
};

export class Store {
  constructor(directory, vault = windowsVault) {
    this.vault = vault;
    mkdirSync(directory, { recursive: true });
    // Windows releases this SQLite lock when the controller process exits, including after a crash.
    this.lock = new DatabaseSync(join(directory, 'controller-lock.sqlite'));
    try {
      this.lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    } catch (error) {
      this.lock.close();
      if (error.errcode === 5) throw new Error('BBStreamer already has this data folder open.');
      throw error;
    }
    try {
      this.db = new DatabaseSync(join(directory, 'controller.sqlite'));
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, printer TEXT NOT NULL, started INTEGER NOT NULL,
          ended INTEGER, settled INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS active_printer_job ON jobs(printer) WHERE ended IS NULL;
        CREATE INDEX IF NOT EXISTS job_work ON jobs(settled, started);
      `);
      this.credentials = this.get('vault') ? this.vault.unseal(this.get('vault')) : {};
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  }

  set(key, value) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = action();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  saveSettings(config, credentials) {
    const encrypted = this.vault.seal(credentials);
    this.transaction(() => {
      if (config) this.set('config', config);
      this.set('vault', encrypted);
    });
    this.credentials = credentials;
  }

  job(id) {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }

  active(printer) {
    const row = this.db.prepare('SELECT data FROM jobs WHERE printer = ? AND ended IS NULL').get(printer);
    return row ? JSON.parse(row.data) : null;
  }

  recent() {
    return this.db.prepare('SELECT data FROM jobs ORDER BY started DESC LIMIT 16').all()
      .map(row => JSON.parse(row.data));
  }

  unsettled() {
    return this.db.prepare('SELECT data FROM jobs WHERE settled = 0 ORDER BY started').all()
      .map(row => JSON.parse(row.data));
  }

  saveJob(job) {
    this.db.prepare(`
      INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ended = excluded.ended, settled = excluded.settled, data = excluded.data
    `).run(job.id, job.printer, job.startedAt, job.endedAt ?? null, job.settled ? 1 : 0, JSON.stringify(job));
    return job;
  }

  patchJob(id, changes) {
    return this.saveJob({ ...this.job(id), ...changes });
  }

  close() {
    this.db?.close();
    this.lock.close();
  }
}
