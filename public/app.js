const byId = id => document.getElementById(id);
const form = byId('config');
const fields = form.elements;
const printerIds = ['x1c', 'h2c'];
const cards = {};
const printerFields = {};
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
let config, csrf, snapshot, googleSaved;
let polling = false;
let previewRun = 0;

const names = { SLICING: 'Slicing', PREPARE: 'Preparing', RUNNING: 'Printing', PAUSE: 'Paused' };
const codecs = { h264_nvenc: 'NVENC', h264_qsv: 'Quick Sync', h264_amf: 'AMF', libx264: 'Software' };

function notice(message, error = false) {
  const element = byId('notice');
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle('error', error);
}

async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BB-CSRF': csrf }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function show(page) {
  byId('overview').hidden = page !== 'overview';
  byId('settings').hidden = page !== 'settings';
  for (const id of ['overview', 'settings']) {
    const button = byId('show-' + id);
    if (page === id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

for (const id of printerIds) {
  const card = byId('printer-card').content.firstElementChild.cloneNode(true);
  card.querySelector('.preview-button').addEventListener('click', () => preview(id));
  byId('printer-grid').append(card);
  cards[id] = card;

  const editor = byId('printer-form').content.firstElementChild.cloneNode(true);
  editor.querySelector('h3').textContent = id.toUpperCase();
  byId('printer-settings').append(editor);
  printerFields[id] = Object.fromEntries([...editor.querySelectorAll('[data-field]')].map(field => [field.dataset.field, field]));
}

async function settings() {
  const data = await api('config');
  config = data.config;
  csrf = data.csrf;
  googleSaved = data.saved.google;
  byId('youtube-signin-location').hidden = !data.signInOnHost;
  byId('youtube-connect').textContent = googleSaved ? 'Reconnect YouTube' : 'Connect YouTube';
  for (const key of Object.keys(config)) {
    if (key === 'printers') continue;
    if (fields[key].type === 'checkbox') fields[key].checked = config[key];
    else fields[key].value = config[key];
  }
  for (const id of printerIds) {
    for (const [key, field] of Object.entries(printerFields[id])) {
      field.value = config.printers[id][key] ?? '';
    }
    printerFields[id].accessCode.placeholder = data.saved.printers[id] ? 'Saved · leave blank to keep' : '';
    const link = cards[id].querySelector('.overlay-link');
    const overlay = new URL(config.printers[id].overlay);
    if (data.signInOnHost && ['127.0.0.1', 'localhost'].includes(overlay.hostname)) overlay.hostname = location.hostname;
    link.href = overlay.href;
  }
  fields.discordToken.value = '';
  fields.discordToken.placeholder = data.saved.discord ? 'Saved · leave blank to keep' : 'Optional';
}

function list(id, items, empty, makeItem) {
  const element = byId(id);
  element.replaceChildren();
  if (!items.length) {
    const row = document.createElement('li');
    row.className = 'empty';
    row.textContent = empty;
    element.append(row);
    return;
  }
  for (const item of items) {
    const row = document.createElement('li');
    makeItem(row, item);
    element.append(row);
  }
}

function draw(state) {
  snapshot = state;
  const activity = state.streamCount ? ` · ${state.streamCount} of ${state.maxStreams} capture slots in use` : '';
  byId('automation-summary').textContent = (state.automatic ? 'Automatic streaming enabled' : 'Automatic streaming off') + activity;
  byId('google-status').textContent = state.channel ? `Connected to ${state.channel.name}` : 'No channel connected';
  for (const id of printerIds) {
    const card = cards[id];
    const { connection, report, phase, job, metrics, error, discordError, url } = state.printers[id];
    const set = (selector, value) => { card.querySelector(selector).textContent = value; };
    set('h2', config?.printers[id]?.name ?? id.toUpperCase());
    set('.connection', connection);
    set('.pill', phase);
    card.querySelector('.pill').classList.toggle('live', phase === 'On air');
    set('.print-name', job?.printName ?? (job ? '3D print' : 'No active print'));
    set('.print-state', job ? names[report?.state] ?? names[job.printState] ?? 'Print detected' : 'Print progress');
    const percent = job ? report?.progress ?? job.progress : null;
    set('.percent', percent == null ? '—' : `${percent}%`);
    card.querySelector('progress').value = percent ?? 0;
    const layer = job ? report?.layer ?? job.layer : null;
    const layers = job ? report?.layers ?? job.layers : null;
    const remaining = job ? report?.remaining ?? job.remaining : null;
    set('.layer', layer == null ? '—' : layers ? `${layer} / ${layers}` : layer);
    set('.remaining', remaining == null ? '—' : remaining >= 60 ? `${Math.floor(remaining / 60)} h ${remaining % 60} m` : `${remaining} min`);
    set('.encoder', metrics?.encoder ? codecs[metrics.encoder] : '—');
    const health = [metrics?.captureFps ? `${metrics.captureFps} fps capture` : '',
      metrics?.fps ? `${Math.round(metrics.fps)} fps encoded` : '',
      metrics?.camera ? `Camera · ${metrics.camera}` : '', metrics?.toolpath ? `3D · ${metrics.toolpath}` : ''].filter(Boolean).join('  ·  ');
    set('.card-health', health);
    card.querySelector('.card-health').hidden = !health;
    const errors = [error?.message, discordError?.message].filter(Boolean).join(' ');
    set('.card-error', errors);
    card.querySelector('.card-error').hidden = !errors;
    const watch = card.querySelector('.watch-link');
    watch.hidden = !job?.liveAt || !url;
    if (url) watch.href = url;
    card.querySelector('.preview-button').disabled = state.streamCount > 0;
  }
  list('recent', state.recent, 'Completed prints will appear here.', (row, job) => {
    row.append(document.createTextNode(`${job.printerName} · ${job.printName || '3D print'}`));
    const detail = document.createElement('small');
    detail.textContent = `${job.outcome}${job.playlistDone ? ' · Added to playlist' : ''}${job.error ? ' · ' + job.error.message : ''}`;
    row.append(detail);
    if (job.url) {
      const link = document.createElement('a');
      Object.assign(link, { href: job.url, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open YouTube broadcast' });
      row.append(link);
    }
  });
  list('activity', state.events.slice(0, 6), 'No activity yet.', (row, event) => {
    const at = document.createElement('time');
    at.dateTime = new Date(event.at).toISOString();
    at.textContent = time.format(event.at);
    row.append(at, document.createTextNode('  ·  ' + event.message));
  });
}

async function refresh() {
  if (polling || document.hidden) return;
  polling = true;
  try { draw(await api('state')); }
  catch { notice('The controller is unreachable. Check that BBStreamer is running.', true); }
  finally { polling = false; }
}

async function preview(id) {
  const run = ++previewRun;
  const dialog = byId('preview');
  byId('preview-title').textContent = `${config.printers[id].name} overlay preview`;
  byId('preview-status').textContent = 'Capturing the published scene…';
  byId('preview-image').hidden = true;
  dialog.showModal();
  try {
    const result = await api('preview', { printer: id });
    if (run !== previewRun || !dialog.open) return;
    byId('preview-image').src = 'data:image/jpeg;base64,' + result.image;
    byId('preview-image').hidden = false;
    byId('preview-status').textContent = `Camera · ${result.camera}     3D · ${result.toolpath}`;
  } catch (error) {
    if (run === previewRun) byId('preview-status').textContent = error.message;
  }
}

byId('show-overview').addEventListener('click', () => show('overview'));
byId('show-settings').addEventListener('click', () => show('settings'));
byId('configure').addEventListener('click', () => show('settings'));

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  const input = { printers: {}, discordToken: fields.discordToken.value };
  for (const key of Object.keys(config).filter(key => key !== 'printers')) {
    const field = fields[key];
    input[key] = field.type === 'checkbox' ? field.checked :
      ['maxStreams', 'captureFps', 'bitrate'].includes(key) ? Number(field.value) : field.value;
  }
  for (const id of printerIds) {
    input.printers[id] = Object.fromEntries(Object.entries(printerFields[id]).map(([key, field]) =>
      [key, field.type === 'number' ? Number(field.value) : field.value]));
  }
  try {
    await api('config', input);
    await settings();
    await refresh();
    notice('Settings saved.');
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

byId('youtube-connect').addEventListener('click', async event => {
  const file = byId('oauth-file').files[0];
  if ((!file && !googleSaved) || file?.size > 16384) {
    notice('Choose the Google OAuth Desktop client JSON file.', true);
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    let client;
    try { if (file) client = JSON.parse(await file.text()); }
    catch { throw new Error('The OAuth client file is not valid JSON.'); }
    const result = await api('youtube/connect', { client });
    if (result.openedOnHost) notice('Finish Google sign-in in the browser on the BBStreamer PC.');
    else location.assign(result.url);
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

byId('discord-check').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api('discord/check', { channel: fields.discordChannel.value.trim(), token: fields.discordToken.value.trim() });
    notice(`Connected as ${result.name} in #${result.channel}.`);
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
});

try {
  await settings();
  await refresh();
  const outcome = new URLSearchParams(location.search).get('youtube');
  if (outcome) {
    history.replaceState(null, '', '/');
    show('settings');
    if (outcome === 'connected') notice(`YouTube connected${snapshot?.channel ? ' to ' + snapshot.channel.name : ''}.`);
    else notice('YouTube could not connect. Check Activity and try again.', true);
  }
} catch { notice('The controller is unreachable. Check that BBStreamer is running.', true); }
setInterval(refresh, 4000);
