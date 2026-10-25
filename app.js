'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const FORMATS = ['csv', 'json'];
const USERDATA = '/userdata';
const CSV_COLUMNS = ['dateCreated', 'localTime', 'categoryName', 'category', 'text', 'id'];

// Link lifetimes the user can choose, in minutes
const LIFETIMES = [15, 60, 360, 720, 1440];
const DEFAULT_LIFETIME = 15;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

// Flow card periods, in hours (0 = whole timeline). "yesterday" is handled separately
const PERIODS = { all: 0, day: 24, week: 24 * 7, month: 24 * 30 };
const DELIMITERS = { semicolon: ';', comma: ',', tab: '\t' };

class TimelineExportApp extends Homey.App {

  async onInit() {
    this.api = null;
    this.apiToken = null;

    // A new or removed API key means the Web API client must be rebuilt
    this.homey.settings.on('set', (key) => {
      if (key === 'apiToken') this.api = null;
    });
    this.homey.settings.on('unset', (key) => {
      if (key === 'apiToken') this.api = null;
    });

    this.exportedTrigger = this.homey.flow.getTriggerCard('timeline_exported');

    this.homey.flow.getActionCard('export_timeline')
      .registerRunListener(async (args) => {
        await this.createDownload(this.getPeriodQuery(args), { source: 'flow' });
        return true;
      });

    // Same export, but returns the tags directly (Advanced Flow only)
    this.homey.flow.getActionCard('export_timeline_tokens')
      .registerRunListener(async (args) => {
        const download = await this.createDownload(this.getPeriodQuery(args), { source: 'flow' });
        return TimelineExportApp.toTokens(download);
      });

    await this.cleanupDownloads();
    this.homey.setInterval(() => this.cleanupDownloads().catch(this.error), CLEANUP_INTERVAL);

    this.log('Timeline Export has been initialized');
  }

  /**
   * Turns a Flow card's format and period into an export query.
   * "yesterday" is the whole previous calendar day in Homey's time zone,
   * so daily exports neither overlap nor leave gaps.
   */
  getPeriodQuery(args) {
    const query = { format: args.format };
    if (args.period === 'yesterday') {
      const today = this.formatLocalTime(new Date().toISOString()).slice(0, 10);
      const [year, month, day] = today.split('-').map(Number);
      const yesterday = new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
      query.from = yesterday;
      query.to = yesterday;
    } else if (PERIODS[args.period]) {
      query.since = new Date(Date.now() - PERIODS[args.period] * 60 * 60 * 1000).toISOString();
    }
    return query;
  }

  static toTokens(download) {
    return {
      local_url: download.localUrl,
      external_url: download.externalUrl,
      file_name: download.fileName,
      count: download.count,
      format: download.format.toUpperCase(),
      period: download.period,
      expires: download.expires,
      // Without the BOM, which only matters for files opened in Excel
      content: download.content.replace(/^\uFEFF/, ''),
    };
  }

  /* ---------------------------------------------------------------------
   * Web API access
   * ------------------------------------------------------------------- */

  getToken() {
    const token = this.homey.settings.get('apiToken');
    return (typeof token === 'string' && token.trim()) ? token.trim() : null;
  }

  /**
   * Uses the user's own API key when one is saved. Without one, the app's
   * own token is tried first; on newer Homey Pro models that token is not
   * allowed to read the timeline, which ends in a "token required" error.
   */
  async getApi() {
    const token = this.getToken();
    // Also rebuild when the key changed, in case the settings event arrives late
    if (this.api && this.apiToken !== token) this.api = null;

    if (!this.api) {
      this.apiToken = token;
      if (token) {
        this.api = await HomeyAPI.createLocalAPI({
          address: await this.homey.api.getLocalUrl(),
          token,
        });
      } else {
        this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
      }
    }
    return this.api;
  }

  static isAccessError(err) {
    const message = String((err && err.message) || err || '').toLowerCase();
    const status = err && (err.statusCode || err.status);
    return status === 401 || status === 403
      || message.includes('missing scope')
      || message.includes('invalid_token')
      || message.includes('unauthorized');
  }

  /**
   * Runs a Web API call and turns access errors into a clear message.
   */
  async withApi(fn) {
    try {
      return await fn(await this.getApi());
    } catch (err) {
      if (TimelineExportApp.isAccessError(err)) {
        this.api = null;
        const hasToken = !!this.getToken();
        const error = new Error(this.homey.__(hasToken ? 'errors.tokenRejected' : 'errors.tokenRequired'));
        error.code = hasToken ? 'token_rejected' : 'token_required';
        this.error(`Access to the timeline was refused (${error.code}):`, err.message || err);
        throw error;
      }
      throw err;
    }
  }

  /* ---------------------------------------------------------------------
   * Reading the timeline
   * ------------------------------------------------------------------- */

  async getOwnerNames() {
    const owners = await this.withApi((api) => api.notifications.getOwners());
    const names = {};

    for (const [uri, owner] of Object.entries(owners || {})) {
      // Some categories have a missing, null or empty name (seen with apps whose name has spaces)
      const name = owner && owner.uriObj && owner.uriObj.name;
      names[uri] = (typeof name === 'string' && name.trim()) ? name.trim() : uri;
    }
    return names;
  }

  formatLocalTime(isoDate) {
    try {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: this.homey.clock.getTimezone(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(isoDate));
    } catch (err) {
      return isoDate;
    }
  }

  static cleanText(text) {
    return String(text || '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async getTimeline() {
    const notifications = await this.withApi((api) => api.notifications.getNotifications());
    const names = await this.getOwnerNames();

    return Object.values(notifications || {})
      .map((n) => ({
        id: n.id,
        dateCreated: n.dateCreated,
        localTime: this.formatLocalTime(n.dateCreated),
        category: n.ownerUri,
        categoryName: names[n.ownerUri] || n.ownerUri,
        text: TimelineExportApp.cleanText(n.excerpt),
      }))
      .sort((a, b) => new Date(a.dateCreated) - new Date(b.dateCreated));
  }

  async getSummary() {
    let timeline;
    try {
      timeline = await this.getTimeline();
    } catch (err) {
      if (err.code) {
        return { access: err.code, message: err.message, hasToken: !!this.getToken() };
      }
      throw err;
    }

    const categories = {};
    for (const entry of timeline) {
      if (!categories[entry.category]) {
        categories[entry.category] = { uri: entry.category, name: entry.categoryName, count: 0 };
      }
      categories[entry.category].count++;
    }

    return {
      access: 'ok',
      hasToken: !!this.getToken(),
      count: timeline.length,
      oldest: timeline.length ? timeline[0].dateCreated : null,
      newest: timeline.length ? timeline[timeline.length - 1].dateCreated : null,
      categories: Object.values(categories).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  static filterTimeline(timeline, {
    categories, from, to, text, since,
  }) {
    const categoryList = categories ? String(categories).split(',').filter(Boolean) : [];
    const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
    const sinceTime = since ? new Date(since).getTime() : null;
    const search = text ? String(text).toLowerCase() : '';

    return timeline.filter((entry) => {
      // Dates are compared in Homey's own time zone (localTime starts with YYYY-MM-DD)
      const day = entry.localTime.slice(0, 10);
      if (categoryList.length && !categoryList.includes(entry.category)) return false;
      if (isDate(from) && day < from) return false;
      if (isDate(to) && day > to) return false;
      if (sinceTime && !Number.isNaN(sinceTime) && new Date(entry.dateCreated).getTime() < sinceTime) return false;
      if (search && !entry.text.toLowerCase().includes(search)) return false;
      return true;
    });
  }

  static toCsv(rows, delimiter) {
    // With Tab, fields need no quotes: cleanText() already removes tabs and line breaks
    const escape = delimiter === '\t'
      ? (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ')
      : (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [CSV_COLUMNS.join(delimiter)];
    for (const row of rows) {
      lines.push(CSV_COLUMNS.map((column) => escape(row[column])).join(delimiter));
    }
    // The BOM makes Excel read æ, ø and å correctly
    return `\uFEFF${lines.join('\r\n')}`;
  }

  async getExport(query = {}) {
    const format = FORMATS.includes(query.format) ? query.format : 'csv';
    const delimiterSetting = query.delimiter || this.homey.settings.get('csvDelimiter');
    const delimiter = DELIMITERS[delimiterSetting] || DELIMITERS.semicolon;

    const timeline = await this.getTimeline();
    const rows = TimelineExportApp.filterTimeline(timeline, query);
    const stamp = this.formatLocalTime(new Date().toISOString()).replace(/[: ]/g, '-');

    const content = format === 'json'
      ? JSON.stringify({ exported: new Date().toISOString(), count: rows.length, notifications: rows }, null, 2)
      : TimelineExportApp.toCsv(rows, delimiter);

    this.log(`Exported ${rows.length} of ${timeline.length} notifications as ${format}`);

    return {
      fileName: `homey-timeline-${stamp}.${format}`,
      mimeType: format === 'json' ? 'application/json' : 'text/csv',
      format,
      count: rows.length,
      first: rows.length ? rows[0].localTime : null,
      last: rows.length ? rows[rows.length - 1].localTime : null,
      content,
    };
  }

  /* ---------------------------------------------------------------------
   * Download files in /userdata/
   *
   * /userdata/ is reachable over HTTP, so every export gets its own random
   * folder. Each folder's expiry time is kept in the app settings, so a
   * link lives as long as promised, also across app restarts.
   * ------------------------------------------------------------------- */

  getLifetime() {
    const minutes = Number(this.homey.settings.get('linkLifetime'));
    return LIFETIMES.includes(minutes) ? minutes : DEFAULT_LIFETIME;
  }

  getDownloadRegistry() {
    const registry = this.homey.settings.get('downloads');
    return (registry && typeof registry === 'object') ? registry : {};
  }

  async cleanupDownloads() {
    const registry = this.getDownloadRegistry();
    const now = Date.now();
    let folders = [];

    try {
      const entries = await fs.readdir(USERDATA, { withFileTypes: true });
      folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (err) {
      if (err.code !== 'ENOENT') this.error('Could not read the export folder:', err.message);
    }

    // Remove expired exports and folders that are not in the registry
    for (const folder of folders) {
      if (!registry[folder] || registry[folder] <= now) {
        await fs.rm(path.join(USERDATA, folder), { recursive: true, force: true }).catch(this.error);
      }
    }

    // Keep only registry entries that still have a folder and have not expired
    const cleaned = {};
    for (const [folder, expires] of Object.entries(registry)) {
      if (expires > now && folders.includes(folder)) cleaned[folder] = expires;
    }
    if (Object.keys(cleaned).length !== Object.keys(registry).length) {
      this.homey.settings.set('downloads', cleaned);
    }
  }

  async getLocalAddress() {
    try {
      return await this.homey.cloud.getLocalAddress();
    } catch (err) {
      return null;
    }
  }

  /**
   * The settings page reports the address it is shown from. When that is a
   * remote-access address, it is remembered and used for external links.
   */
  setOrigin(origin) {
    let url;
    try {
      url = new URL(String(origin || ''));
    } catch (err) {
      return { external: this.homey.settings.get('externalOrigin') || null };
    }

    const host = url.hostname;
    const isLocal = host === 'localhost'
      || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      || host.endsWith('.homeylocal.com')
      || host.endsWith('.local');

    if (url.protocol === 'https:' && !isLocal) {
      if (this.homey.settings.get('externalOrigin') !== url.origin) {
        this.homey.settings.set('externalOrigin', url.origin);
        this.log('Remembered external address:', url.origin);
      }
    }
    return { external: this.homey.settings.get('externalOrigin') || null };
  }

  /**
   * Creates an export file and returns its links.
   * options.source is 'settings' or 'flow'; Flow exports always fire the
   * trigger card, exports from the settings page only when the user enabled it.
   */
  async createDownload(query = {}, options = {}) {
    const source = options.source || 'settings';
    const result = await this.getExport(query);

    // From the settings page an empty export is just a message; a Flow still gets a file
    if (!result.count && source === 'settings') return { count: 0 };

    const folder = crypto.randomUUID();
    await fs.mkdir(path.join(USERDATA, folder), { recursive: true });
    await fs.writeFile(path.join(USERDATA, folder, result.fileName), result.content, 'utf8');

    const lifetime = this.getLifetime();
    const expires = Date.now() + lifetime * 60 * 1000;
    this.homey.settings.set('downloads', { ...this.getDownloadRegistry(), [folder]: expires });

    const urlPath = `/app/${this.homey.manifest.id}/userdata/${folder}/${encodeURIComponent(result.fileName)}`;
    const localAddress = await this.getLocalAddress();
    const externalOrigin = this.homey.settings.get('externalOrigin');

    const download = {
      count: result.count,
      format: result.format,
      fileName: result.fileName,
      path: urlPath,
      localUrl: localAddress ? `http://${localAddress}${urlPath}` : '',
      externalUrl: externalOrigin ? `${externalOrigin}${urlPath}` : '',
      expires: this.formatLocalTime(new Date(expires).toISOString()),
      period: result.count ? `${result.first} – ${result.last}` : '',
      lifetime,
    };

    if (source === 'flow' || this.homey.settings.get('triggerOnManual') === true) {
      const tokens = TimelineExportApp.toTokens({ ...download, content: result.content });
      const size = Buffer.byteLength(tokens.content, 'utf8');
      this.log(`Starting "The timeline was exported" with ${download.count} notifications (content tag: ${size} bytes)`);
      try {
        await this.exportedTrigger.trigger(tokens);
      } catch (err) {
        // If the content is too large for a tag, still deliver the links
        this.error(`The trigger failed with a content tag of ${size} bytes, retrying without content:`, err.message || err);
        await this.exportedTrigger.trigger({ ...tokens, content: '' }).catch(this.error);
      }
    }

    // The settings page does not need the content; Flow cards do
    if (source === 'flow') download.content = result.content;

    return download;
  }

}

module.exports = TimelineExportApp;
