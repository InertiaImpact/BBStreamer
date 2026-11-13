import { createHash, randomBytes } from 'node:crypto';

const googleScope = 'https://www.googleapis.com/auth/youtube.force-ssl';
const youtubeBase = 'https://www.googleapis.com/youtube/v3/';
const discordBase = 'https://discord.com/api/v10/';
const broadcastParts = 'snippet,status,contentDetails';

export class ServiceError extends Error {
  constructor(service, status, reason = '', retryMs = 0) {
    const safeReason = /^[a-zA-Z0-9_]{1,70}$/.test(reason) ? reason : '';
    const explanation = safeReason ? ` (${safeReason})` : '';
    super(status ? `${service} returned HTTP ${status}${explanation}.` : `${service} could not be reached.`);
    this.status = status;
    this.reason = safeReason;
    this.retryMs = retryMs;
    this.uncertain = status === 0 || status >= 500 || status === 408;
  }
}

async function request(fetcher, service, url, { headers, body, method, form } = {}) {
  let response, data;
  try {
    response = await fetcher(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : form,
    });
    data = response.status === 204 ? null : await response.json();
  } catch {
    if (!response || response.ok) throw new ServiceError(service, 0);
  }
  if (response.ok) return data;
  const wait = Number(data?.retry_after ?? response.headers.get('retry-after'));
  const reason = data?.error?.errors?.[0]?.reason ?? data?.error?.status ??
    (typeof data?.error === 'string' ? data.error : '') ?? '';
  throw new ServiceError(service, response.status, reason, Number.isFinite(wait) ? wait * 1000 : 0);
}

export class GoogleLogin {
  constructor(store, fetcher = fetch) {
    this.store = store;
    this.fetcher = fetcher;
  }

  start(client, redirectUri) {
    this.pending = {
      client, redirectUri, state: randomBytes(24).toString('base64url'),
      verifier: randomBytes(48).toString('base64url'), expires: Date.now() + 10 * 60 * 1000,
    };
    const { state, verifier } = this.pending;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: client.id, redirect_uri: redirectUri, response_type: 'code',
      scope: googleScope, access_type: 'offline', prompt: 'consent select_account', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return url.href;
  }

  token(client, fields) {
    return request(this.fetcher, 'Google sign-in', 'https://oauth2.googleapis.com/token', {
      method: 'POST', form: new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...fields }),
    });
  }

  async finish(params) {
    const pending = this.pending;
    if (!pending || pending.state !== params.get('state') || Date.now() > pending.expires) {
      throw new Error('This sign-in link has expired. Start again in Settings.');
    }
    this.pending = null;
    if (!params.get('code')) throw new Error('Google sign-in was canceled. You can start again in Settings.');
    const result = await this.token(pending.client, {
      code: params.get('code'), grant_type: 'authorization_code',
      redirect_uri: pending.redirectUri, code_verifier: pending.verifier,
    });
    if (!result.refresh_token || !result.access_token) throw new Error('Google did not grant offline access. Reconnect and grant YouTube access.');
    const url = new URL('channels?part=snippet&mine=true&maxResults=2', youtubeBase);
    const channels = await request(this.fetcher, 'YouTube', url, { headers: { Authorization: `Bearer ${result.access_token}` } });
    if (channels?.items?.length !== 1) throw new Error('Choose the Google or Brand account that opens the intended YouTube channel.');
    const [channel] = channels.items;
    const google = {
      client: pending.client, refresh: result.refresh_token,
      channel: { id: channel.id, name: channel.snippet.title },
    };
    this.store.saveSettings(null, { ...this.store.credentials, google });
    this.cached = { auth: google, token: result.access_token, expires: Date.now() + result.expires_in * 1000 };
    return google.channel;
  }

  async access(force = false) {
    const auth = this.store.credentials.google;
    if (!auth) throw new Error('Connect a YouTube channel in Settings.');
    if (!force && this.cached?.auth === auth && Date.now() + 60000 < this.cached.expires) return this.cached.token;
    if (this.refreshing?.auth === auth) return this.refreshing.promise;
    const promise = this.refresh(auth);
    this.refreshing = { auth, promise };
    try { return await promise; }
    finally { if (this.refreshing?.promise === promise) this.refreshing = null; }
  }

  async refresh(auth) {
    let result;
    try {
      result = await this.token(auth.client, { refresh_token: auth.refresh, grant_type: 'refresh_token' });
    } catch (error) {
      if (error.reason === 'invalid_grant' || error.reason === 'invalid_client') {
        throw new Error('Google sign-in expired or was revoked. Reconnect the same YouTube channel in Settings.');
      }
      throw error;
    }
    if (!result?.access_token) throw new ServiceError('Google sign-in', 0);
    if (this.store.credentials.google !== auth) throw new Error('The YouTube account changed. Retrying with the saved account.');
    if (result.refresh_token && result.refresh_token !== auth.refresh) {
      auth = { ...auth, refresh: result.refresh_token };
      this.store.saveSettings(null, { ...this.store.credentials, google: auth });
    }
    this.cached = { auth, token: result.access_token, expires: Date.now() + result.expires_in * 1000 };
    return result.access_token;
  }
}

export function oauthClient(input) {
  const client = input?.installed;
  if (!client || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(client.client_id ?? '') ||
      !/^[a-zA-Z0-9_-]{5,256}$/.test(client.client_secret ?? '')) {
    throw new Error('Choose the JSON file downloaded for a Google OAuth Desktop app.');
  }
  return { id: client.client_id, secret: client.client_secret };
}

export const watchUrl = id => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

export class YouTube {
  constructor(login, fetcher = fetch) {
    this.login = login;
    this.fetcher = fetcher;
  }

  async api(channel, path, query, { method, body } = {}) {
    const url = new URL(path, youtubeBase);
    url.search = new URLSearchParams(query);
    const call = async force => {
      if (channel !== this.login.store.credentials.google?.channel.id) {
        throw new Error('Reconnect the YouTube channel that owns this print’s broadcast.');
      }
      const token = await this.login.access(force);
      if (channel !== this.login.store.credentials.google?.channel.id) {
        throw new Error('The YouTube channel changed. Reconnect the channel that owns this broadcast.');
      }
      return request(this.fetcher, 'YouTube', url, { method, body, headers: { Authorization: `Bearer ${token}` } });
    };
    try { return await call(false); }
    catch (error) { if (error.status !== 401) throw error; return call(true); }
  }

  async find(channel, resource, query, match) {
    let pageToken;
    do {
      const page = await this.api(channel, resource, { ...query, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
      const found = page.items?.find(match);
      if (found) return found;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return null;
  }

  async stream(channel, id) {
    return this.byId(channel, 'liveStreams', 'snippet,cdn,status', id);
  }

  async ensureIngest(channel, title, knownId) {
    if (knownId) {
      const known = await this.stream(channel, knownId);
      if (known) return known;
    }
    const existing = await this.find(channel, 'liveStreams', { part: 'snippet,cdn,status', mine: true },
      item => item.snippet?.title === title);
    if (existing) return existing;
    return this.api(channel, 'liveStreams', { part: 'snippet,cdn,contentDetails,status' }, {
      method: 'POST',
      body: {
        snippet: { title }, contentDetails: { isReusable: true },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
      },
    });
  }

  marker(job) { return `BBStreamer print ${job.id}`; }

  findBroadcast(job) {
    const marker = this.marker(job);
    return this.find(job.channelId, 'liveBroadcasts', { part: broadcastParts, mine: true, broadcastType: 'event' },
      item => item.snippet?.description?.split('\n').includes(marker));
  }

  insertBroadcast(job) {
    const title = [...`${job.printName || '3D print'} | ${job.printerName}`.replace(/[<>]/g, '')].slice(0, 95).join('');
    return this.api(job.channelId, 'liveBroadcasts', { part: broadcastParts }, {
      method: 'POST',
      body: {
        snippet: {
          title: title || '3D print',
          description: `Live view of ${job.printerName.replace(/[<>]/g, '')}.\n\n${this.marker(job)}`,
          scheduledStartTime: new Date(Date.now() + 60000).toISOString(),
        },
        status: { privacyStatus: job.privacy },
        contentDetails: {
          enableAutoStart: true, enableAutoStop: false, enableDvr: true,
          recordFromStart: true, monitorStream: { enableMonitorStream: false },
        },
      },
    });
  }

  async byId(channel, path, part, id) {
    try {
      const result = await this.api(channel, path, { part, id });
      return result.items?.[0] ?? null;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  broadcast(job) {
    return this.byId(job.channelId, 'liveBroadcasts', broadcastParts, job.broadcastId);
  }

  bind(job) {
    return this.api(job.channelId, 'liveBroadcasts/bind', { part: broadcastParts, id: job.broadcastId, streamId: job.ingestId }, { method: 'POST' });
  }

  complete(job) {
    return this.api(job.channelId, 'liveBroadcasts/transition', {
      part: broadcastParts, id: job.broadcastId, broadcastStatus: 'complete',
    }, { method: 'POST' });
  }

  goLive(job) {
    return this.api(job.channelId, 'liveBroadcasts/transition', {
      part: broadcastParts, id: job.broadcastId, broadcastStatus: 'live',
    }, { method: 'POST' });
  }

  remove(job) {
    return this.api(job.channelId, 'liveBroadcasts', { id: job.broadcastId }, { method: 'DELETE' });
  }

  async checkPlaylist(channelId, playlistId) {
    const playlist = await this.byId(channelId, 'playlists', 'snippet,status', playlistId);
    if (playlist?.snippet?.channelId !== channelId) {
      throw new Error('The replay playlist must belong to the connected YouTube channel.');
    }
    if (!['unlisted', 'private'].includes(playlist.status?.privacyStatus)) {
      throw new Error('Set the replay playlist to Unlisted or Private in YouTube.');
    }
  }

  async archive(job, beforeInsert) {
    const { channelId, youtubePlaylistId: playlistId, broadcastId: videoId } = job;
    await this.checkPlaylist(channelId, playlistId);
    const existing = await this.api(channelId, 'playlistItems', { part: 'id', playlistId, videoId, maxResults: 1 });
    if (existing.items?.length) return;
    beforeInsert();
    try {
      await this.api(channelId, 'playlistItems', { part: 'snippet' }, {
        method: 'POST',
        body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
      });
    } catch (error) {
      if (error.reason === 'videoAlreadyInPlaylist') return;
      if (error.reason === 'videoNotFound') {
        const pending = new Error('YouTube is still making the replay available for the playlist.');
        pending.retryMs = 60000;
        throw pending;
      }
      throw error;
    }
  }

  static destination(stream) {
    const info = stream?.cdn?.ingestionInfo;
    let url;
    try { url = new URL(info.rtmpsIngestionAddress); } catch { throw new Error('YouTube did not supply an encrypted ingest address.'); }
    if (url.protocol !== 'rtmps:' || !/^[a-z0-9-]+\.rtmps\.youtube\.com$/i.test(url.hostname) ||
        url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') ||
        !/^[\w-]{4,128}$/.test(info.streamName ?? '')) throw new Error('YouTube returned an unexpected ingest address.');
    if (!url.port) url.port = '443';
    url.pathname = url.pathname.replace(/\/+$/, '') + '/' + info.streamName;
    return url.href;
  }
}

function discordText(value) {
  return value.replace(/[\\`*_{}\[\]()<>#+!|~]/g, '\\$&');
}

const snowflakeTime = id => Number((BigInt(id) >> 22n) + 1420070400000n);

export class Discord {
  constructor(store, fetcher = fetch) {
    this.store = store;
    this.fetcher = fetcher;
    this.blockedUntil = 0;
  }

  async api(path, { method, body, token } = {}) {
    token ??= this.store.credentials.discordToken;
    if (!token) throw new Error('Enter the Discord bot token in Settings.');
    if (Date.now() < this.blockedUntil) throw new ServiceError('Discord', 429, '', this.blockedUntil - Date.now());
    try {
      return await request(this.fetcher, 'Discord', new URL(path, discordBase), {
        method, body, headers: { Authorization: `Bot ${token}` },
      });
    } catch (error) {
      if (error.status === 429) this.blockedUntil = Date.now() + Math.max(1000, error.retryMs);
      throw error;
    }
  }

  async check(channel, token) {
    const bot = await this.api('users/@me', { token });
    const target = await this.api(`channels/${channel}`, { token });
    if (bot?.bot !== true || ![0, 5].includes(target?.type)) throw new Error('Choose a server text or announcement channel and use a bot token.');
    return { id: bot.id, name: bot.username, channel: target.name };
  }

  async botId(token = this.store.credentials.discordToken) {
    if (this.cachedBot && this.cachedBot.token === token) return this.cachedBot.id;
    const bot = await this.api('users/@me', { token });
    if (bot?.bot !== true) throw new Error('Discord requires a bot token.');
    this.cachedBot = { token, id: bot.id };
    return bot.id;
  }

  marker(job) { return `Print ${job.id}`; }

  payload(job, state) {
    const progress = job.progress == null ? '' : ` · ${job.progress}%`;
    const layers = job.layer != null && job.layers ? ` · Layer ${job.layer}/${job.layers}` : '';
    const eta = !job.endedAt && job.remaining != null ? ` · ${job.remaining} min left` : '';
    return {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: `${job.printerName} · ${job.printName || '3D print'}`,
        description: `**${discordText(state)}**${progress}${layers}${eta}\n[Watch on YouTube](${watchUrl(job.broadcastId)})`,
        color: job.endedAt ? (job.outcome === 'Completed' ? 0x48b98c : 0xf0a562) : 0x4c8de1,
        footer: { text: this.marker(job) },
        timestamp: new Date(job.endedAt || job.startedAt).toISOString(),
      }],
    };
  }

  async findMessage(job, token) {
    const marker = this.marker(job);
    const earliest = job.discordAttemptAt - 60000;
    let before;
    while (true) {
      const messages = await this.api(`channels/${job.discordChannel}/messages?limit=100${before ? `&before=${before}` : ''}`, { token });
      const found = messages.find(message => message.author?.id === job.discordBotId &&
        message.embeds?.some(embed => embed.footer?.text === marker));
      if (found) return found;
      const last = messages.at(-1);
      if (messages.length < 100 || snowflakeTime(last.id) < earliest || last.id === before) return null;
      before = last.id;
    }
  }

  post(job, payload, token) {
    return this.api(`channels/${job.discordChannel}/messages`, {
      method: 'POST', token, body: { ...payload, nonce: job.id.replaceAll('-', '').slice(0, 24), enforce_nonce: true },
    });
  }

  edit(job, payload, token) {
    return this.api(`channels/${job.discordChannel}/messages/${job.discordMessageId}`, { method: 'PATCH', body: payload, token });
  }
}
