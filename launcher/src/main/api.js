'use strict';
// News + server status, served by StarLoco-Web (see StarLoco-Web/launcher/).

const settings = require('./settings');
const { fetchJson } = require('./remote');

async function news() {
  const cfg = settings.resolved();
  const data = await fetchJson(settings.remoteUrl(cfg.newsPath || 'news.php'), 10000);
  return Array.isArray(data) ? data : data.items || [];
}

async function status() {
  const cfg = settings.resolved();
  return fetchJson(settings.remoteUrl(cfg.statusPath || 'status.php'), 8000);
}

module.exports = { news, status };
