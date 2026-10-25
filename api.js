'use strict';

module.exports = {

  async getSummary({ homey }) {
    return homey.app.getSummary();
  },

  async getExport({ homey, query }) {
    return homey.app.getExport(query);
  },

  async getDownload({ homey, query }) {
    return homey.app.createDownload(query, { source: 'settings' });
  },

  async setOrigin({ homey, body }) {
    return homey.app.setOrigin(body && body.origin);
  },

};
