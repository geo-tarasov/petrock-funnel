// Кому доступны служебные команды бота (/test, /offer, /paid, /reset, /id, /stats):
// id из ADMIN_TG_IDS на сервере и список «Telegram id тестировщиков» из настроек админки.

import { config } from './config.js';
import { load } from './store.js';

export async function isAdminId(id) {
  if (!id) return false;
  if (config.adminIds.includes(id)) return true;
  const cfg = await load();
  return cfg.setting('tester_tg_ids', '')
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number)
    .includes(id);
}
