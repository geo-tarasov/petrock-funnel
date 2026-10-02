import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// TIME_SCALE < 1 сжимает все задержки воронки — только для прогона всей цепочки.
const TIME_SCALE = Number(process.env.TIME_SCALE || 1);

export const config = {
  botToken: required('TG_BOT_TOKEN'),
  apiUrl: required('API_URL').replace(/\/$/, ''),
  apiToken: required('API_TOKEN'),
  publicUrl: required('PUBLIC_URL').replace(/\/$/, ''),
  httpPort: Number(process.env.HTTP_PORT || 3025),
  httpHost: process.env.HTTP_HOST || '127.0.0.1',
  hookSecret: required('HOOK_SECRET'),
  adminIds: (process.env.ADMIN_TG_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number),
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS || 3000),
  // Telegram пропускает около 30 сообщений в секунду; держимся ниже с запасом.
  broadcastPerSecond: Number(process.env.BROADCAST_PER_SECOND || 20),
  timeScale: TIME_SCALE,
  // user.time_scale — 1 у обычных пользователей и 0.01 у админа в режиме /test.
  // Секундные паузы остаются как есть, длинные сжимаются, но не короче минуты,
  // чтобы тестировщик успевал нажимать кнопки.
  delay: (seconds, user) => {
    const base = Math.max(0, Number(seconds) || 0);
    const scale = TIME_SCALE * (Number(user?.time_scale) || 1);
    if (scale >= 1 || base < 60) return base;
    return Math.max(60, Math.round(base * scale));
  },
};
