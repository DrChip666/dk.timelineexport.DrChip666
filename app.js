'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const FORMATS = ['csv', 'json'];
const USERDATA = '/userdata';
const DOWNLOAD_LIFETIME = 15 * 60 * 1000; // exports are deleted again after 15 minutes
const CSV_COLUMNS = ['dateCreated', 'localTime', 'categoryName', 'category', 'text', 'id'];

class TimelineExportApp extends Homey.App {

  async onInit() {
    this.api = null;

    // A new or removed API key means the Web API client must be rebuilt
    this.homey.settings.on('set', (key) => {
      if (key === 'apiToken') this.api = null;
    });
    this.homey.settings.on('unset', (key) => {
      if (key === 'apiToken') this.api = null;
    });

    await this.removeAllDownloads();
    this.log('Timeline Export has been initialized');
  }

  async onUninit() {
    await this.removeAllDownloads();
  }

  /**
   * /userdata/ is reachable over HTTP, so every export gets its own
   * random folder and is removed again shortly after.
   */
  async removeDownload(folder) {
    await fs.rm(path.join(USERDATA, folder), { recursive: true, force: true }).catch(this.error);
  }

  async removeAllDownloads() {
    try {
      const entries = await fs.readdir(USERDATA, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.removeDownload(entry.name)));
    } catch (err) {
      if (err.code !== 'ENOENT') this.error('Could not clean up old exports:', err.message);
    }
  }

  async getLocalAddress() {
    try {
      return await this.homey.cloud.getLocalAddress();
    } catch (err) {
      return null;
    }
  }

  async createDownload(query = {}) {
    const result = await this.getExport(query);
    if (!result.count) return { count: 0 };

    const folder = crypto.randomUUID();
    await fs.mkdir(path.join(USERDATA, folder), { recursive: true });
    await fs.writeFile(path.join(USERDATA, folder, result.fileName), result.content, 'utf8');
    this.homey.setTimeout(() => this.removeDownload(folder), DOWNLOAD_LIFETIME);

    const urlPath = `/app/${this.homey.manifest.id}/userdata/${folder}/${encodeURIComponent(result.fileName)}`;
    const localAddress = await this.getLocalAddress();

    return {
      count: result.count,
      fileName: result.fileName,
      path: urlPath,
      localUrl: localAddress ? `http://${localAddress}${urlPath}` : null,
    };
  }

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
        const error = new Error(this.homey.__(this.getToken() ? 'errors.tokenRejected' : 'errors.tokenRequired'));
        error.code = this.getToken() ? 'token_rejected' : 'token_required';
        this.error(`Access to the timeline was refused (${error.code}):`, err.message || err);
        throw error;
      }
      throw err;
    }
  }

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

  static filterTimeline(timeline, { categories, from, to, text }) {
    const categoryList = categories ? String(categories).split(',').filter(Boolean) : [];
    const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
    const search = text ? String(text).toLowerCase() : '';

    return timeline.filter((entry) => {
      // Dates are compared in Homey's own time zone (localTime starts with YYYY-MM-DD)
      const day = entry.localTime.slice(0, 10);
      if (categoryList.length && !categoryList.includes(entry.category)) return false;
      if (isDate(from) && day < from) return false;
      if (isDate(to) && day > to) return false;
      if (search && !entry.text.toLowerCase().includes(search)) return false;
      return true;
    });
  }

  static toCsv(rows, delimiter) {
    const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [CSV_COLUMNS.join(delimiter)];
    for (const row of rows) {
      lines.push(CSV_COLUMNS.map((column) => escape(row[column])).join(delimiter));
    }
    // The BOM makes Excel read æ, ø and å correctly
    return `\uFEFF${lines.join('\r\n')}`;
  }

  async getExport(query = {}) {
    const format = FORMATS.includes(query.format) ? query.format : 'csv';
    const delimiter = query.delimiter === 'comma' ? ',' : ';';

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
      count: rows.length,
      content,
    };
  }

}

module.exports = TimelineExportApp;
