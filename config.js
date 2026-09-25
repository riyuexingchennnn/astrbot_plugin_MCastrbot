const source = JSON.parse(process.env.MC_ASTRBOT_CONFIG || '{}');
const number = (key, fallback) => Number.isFinite(Number(source[key])) ? Number(source[key]) : fallback;
module.exports = {
  server: { host: source.host || '127.0.0.1', port: number('port', 25565) },
  bot: {
    username: source.username || 'Fairy', version: source.version || false,
    auth: source.auth || 'offline', viewDistance: source.view_distance || 'short',
  },
  viewer: { enabled: false, port: 0, renderDistance: 0, firstPerson: true },
  login: {
    enabled: !!source.login_password, password: source.login_password || '',
    delayMs: number('login_delay_ms', 1800), retries: number('login_retries', 3),
    retryDelayMs: 2500,
  },
  restingMode: source.resting_mode ?? 'spectator',
  maxMoveDistance: 32,
  reconnect: { baseDelayMs: 5000, maxDelayMs: 60000, factor: 1.7 },
  keepAlive: { enabled: true, intervalMs: 45000 },
  chatHistoryLimit: 100,
};
