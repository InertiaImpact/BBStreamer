import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config.mjs';
import { Discord, GoogleLogin, YouTube } from '../src/integrations.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const channel = { id: 'channel', name: 'Fixture Channel' };
const sampleJob = {
  id: 'fe35c2c6-b7ef-475e-a6f8-9cc2e14afcf2', printerName: 'H2C', printName: 'Test @everyone',
  channelId: channel.id, discordChannel: '100000000000000001', privacy: 'unlisted',
  startedAt: Date.now(), broadcastId: 'video01', ingestId: 'ingest01',
};

test('Google desktop login uses PKCE and persists offline authorization after channel selection', async () => {
  const store = { credentials: {}, saveSettings(_config, secrets) { this.credentials = secrets; } };
  let exchanges = 0;
  const login = new GoogleLogin(store, async (url, options) => {
    if (String(url).includes('/token')) {
      exchanges++;
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      assert.ok(options.body.get('code_verifier').length > 43);
      return response({ access_token: 'access-only-in-memory', refresh_token: 'fixture-refresh', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer access-only-in-memory');
    return response({ items: [{ id: channel.id, snippet: { title: channel.name } }] });
  });
  const url = new URL(login.start({ id: 'test', secret: 'fixture-client' }, 'http://127.0.0.1:8085/oauth/callback'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.ok(!url.href.includes('fixture-client'));
  await assert.rejects(() => login.finish(new URLSearchParams({ state: 'invalid', code: '1' })), /expired/);
  assert.equal(exchanges, 0);
  assert.deepEqual(await login.finish(new URLSearchParams({ state: url.searchParams.get('state'), code: '1' })), channel);
  assert.equal(store.credentials.google.refresh, 'fixture-refresh');
  assert.equal(await login.access(), 'access-only-in-memory');
  assert.equal(exchanges, 1);
});

test('YouTube scopes broadcast recovery to the channel and a unique per-print marker', async () => {
  const login = { store: { credentials: { google: { channel } } }, access: async () => 'fixture-access' };
  const api = new YouTube(login, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture-access');
    assert.equal(url.pathname, '/youtube/v3/liveBroadcasts');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.snippet.title, 'Test @everyone | H2C');
      assert.equal(body.status.privacyStatus, 'unlisted');
      assert.equal(body.contentDetails.enableAutoStop, false);
      assert.equal(body.contentDetails.enableAutoStart, true);
      assert.ok(body.snippet.description.includes(sampleJob.id));
      return response({ id: sampleJob.broadcastId });
    }
    assert.equal(url.searchParams.get('mine'), 'true');
    if (!url.searchParams.get('pageToken')) return response({ items: [], nextPageToken: 'next' });
    return response({ items: [{ id: sampleJob.broadcastId, snippet: { description: api.marker(sampleJob) } }] });
  });
  assert.equal((await api.insertBroadcast(sampleJob)).id, sampleJob.broadcastId);
  assert.equal((await api.findBroadcast(sampleJob)).id, sampleJob.broadcastId);
  await assert.rejects(() => api.broadcast({ ...sampleJob, channelId: 'other' }), /owns this print/);
  assert.throws(() => YouTube.destination({ cdn: { ingestionInfo: {
    rtmpsIngestionAddress: 'rtmps://fake.invalid/live2', streamName: 'fixture-only',
  } } }), /unexpected ingest address/);
});

test('Discord suppresses mentions and applies the same durable message marker on create and edit', async () => {
  const store = { credentials: { discordToken: 'fixture-token' } };
  const api = new Discord(store, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bot fixture-token');
    assert.equal(url.pathname, '/api/v10/channels/100000000000000001/messages');
    const body = JSON.parse(options.body);
    assert.equal(body.enforce_nonce, true);
    assert.equal(body.nonce.length, 24);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.embeds[0].footer.text, api.marker(sampleJob));
    return response({ id: 'discord1' });
  });
  assert.equal((await api.post(sampleJob, api.payload(sampleJob, 'Live'))).id, 'discord1');
});

test('Discord honors rate limit delays without sending another request', async () => {
  let calls = 0;
  const api = new Discord({ credentials: { discordToken: 'fixture-token' } }, async () => {
    calls++;
    return response({ retry_after: 5 }, 429);
  });
  await assert.rejects(() => api.botId(), error => error.status === 429 && error.retryMs === 5000);
  await assert.rejects(() => api.botId(), error => error.status === 429);
  assert.equal(calls, 1);
});

test('playlist settings accept a YouTube link or ID', () => {
  const id = 'PL-fixture-playlist';
  assert.equal(parseConfig({ youtubePlaylistId: id }, {}).config.youtubePlaylistId, id);
  const url = 'https://www.youtube.com/playlist?list=' + id;
  assert.equal(parseConfig({ youtubePlaylistId: url }, {}).config.youtubePlaylistId, id);
  assert.throws(() => parseConfig({ youtubePlaylistId: 'https://example.com/playlist?list=' + id }, {}), /playlist link or ID/);
});

test('archive uses the replay video ID and skips re-insertion after a lost response', async () => {
  const job = { ...sampleJob, youtubePlaylistId: 'PL-fixture-playlist' };
  const login = { store: { credentials: { google: { channel } } }, access: async () => 'fixture-access' };
  let exists = false, writes = 0, publicPlaylist = false;
  const api = new YouTube(login, async (url, options) => {
    if (url.pathname.endsWith('/playlists')) {
      return response({ items: [{ snippet: { channelId: channel.id }, status: { privacyStatus: publicPlaylist ? 'public' : 'unlisted' } }] });
    }
    if (options.method === 'POST') {
      writes++;
      assert.deepEqual(JSON.parse(options.body), {
        snippet: { playlistId: job.youtubePlaylistId, resourceId: { kind: 'youtube#video', videoId: job.broadcastId } },
      });
      exists = true;
      return response({}, 502);
    }
    assert.equal(url.searchParams.get('playlistId'), job.youtubePlaylistId);
    assert.equal(url.searchParams.get('videoId'), job.broadcastId);
    return response({ items: exists ? [{ id: 'entry1' }] : [] });
  });
  await assert.rejects(() => api.archive(job, () => {}), { status: 502 });
  await api.archive(job, () => assert.fail('Replay already exists'));
  publicPlaylist = true;
  await assert.rejects(() => api.archive(job, () => assert.fail('Public playlist')), /Unlisted or Private/);
  assert.equal(writes, 1);
});
