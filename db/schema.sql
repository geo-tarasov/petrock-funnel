-- w3a-funnel: Pet Rock VSL funnel data (RU server, PostgreSQL)

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  tg_id         BIGINT NOT NULL UNIQUE,
  username      TEXT,
  first_name    TEXT,
  last_name     TEXT,
  start_param   TEXT,
  gc_user_id    TEXT,
  email         TEXT,
  token         TEXT NOT NULL UNIQUE,          -- used in tracked links and video page
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  clicked_at    TIMESTAMPTZ,                   -- first click on the video link
  video_at      TIMESTAMPTZ,                   -- first play on the video page
  offer_at      TIMESTAMPTZ,                   -- reached the offer moment in the video
  paid_at       TIMESTAMPTZ,                   -- payment webhook from GetCourse
  blocked_at    TIMESTAMPTZ                    -- user blocked the bot
);

-- Per-user delay multiplier: 1 in production, 0.01 for admins testing with /test
ALTER TABLE users ADD COLUMN IF NOT EXISTS time_scale REAL NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_gc_user_id_idx ON users (gc_user_id);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, created_at);
CREATE INDEX IF NOT EXISTS events_user_idx ON events (user_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step        TEXT NOT NULL,
  run_at      TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | canceled | failed
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (status, run_at);
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs (user_id, status);

-- ─── Админка: воронка, медиа и настройки лежат в базе ───────────────────────

-- Шаг воронки. Порядок, задержки, тексты, медиа и кнопки правятся в админке.
CREATE TABLE IF NOT EXISTS steps (
  key           TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  branch        TEXT NOT NULL DEFAULT 'main',       -- ветка для раскладки во флоу
  trigger       TEXT,                               -- start | restart | click | offer | paid
  guard         TEXT NOT NULL DEFAULT 'active',     -- active | not_clicked | not_watched | paid
  text          TEXT NOT NULL DEFAULT '',
  media_key     TEXT,
  buttons       JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{text, action: video|channel|url, url}]
  next_key      TEXT,
  delay_seconds INTEGER NOT NULL DEFAULT 0,         -- пауза перед этим шагом
  enabled       BOOLEAN NOT NULL DEFAULT true,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Несколько веток стартуют от одного /start, поэтому триггер больше не уникален.
DROP INDEX IF EXISTS steps_trigger_idx;
CREATE INDEX IF NOT EXISTS steps_trigger_lookup_idx ON steps (trigger) WHERE trigger IS NOT NULL;

-- Заметка для команды: сценарий кружка, пометки к шагу. В Telegram не уходит.
ALTER TABLE steps ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';

-- Координаты блока на схеме; NULL — значит раскладывается автоматически.
ALTER TABLE steps ADD COLUMN IF NOT EXISTS pos_x INTEGER;
ALTER TABLE steps ADD COLUMN IF NOT EXISTS pos_y INTEGER;

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Медиа хранится в базе на RU, бот тянет файлы через API и кэширует на диск.
CREATE TABLE IF NOT EXISTS media (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'photo',         -- photo | video_note | video
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  data       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Аккаунты админки ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admins (
  id            BIGSERIAL PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',      -- owner | editor | marketer | viewer
  tg_id         BIGINT,                              -- для тестовых отправок себе
  disabled      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS audit (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   BIGINT,
  login      TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_created_idx ON audit (created_at DESC);

-- ─── Рассылки ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS broadcasts (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL DEFAULT '',
  media_key   TEXT,
  buttons     JSONB NOT NULL DEFAULT '[]'::jsonb,
  segment     TEXT NOT NULL DEFAULT 'all',           -- all | clicked | not_clicked | offer | not_offer | paid | not_paid | test
  test_tg_ids BIGINT[] NOT NULL DEFAULT '{}',        -- для сегмента test
  status      TEXT NOT NULL DEFAULT 'draft',         -- draft | sending | paused | done | canceled
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS broadcasts_status_idx ON broadcasts (status, id);

CREATE TABLE IF NOT EXISTS broadcast_targets (
  id           BIGSERIAL PRIMARY KEY,
  broadcast_id BIGINT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  user_id      BIGINT REFERENCES users(id) ON DELETE CASCADE,
  tg_id        BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',      -- pending | sending | sent | failed | blocked
  attempts     INT NOT NULL DEFAULT 0,
  error        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broadcast_targets_claim_idx ON broadcast_targets (broadcast_id, status, id);
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_targets_unique_idx ON broadcast_targets (broadcast_id, tg_id);

-- ─── Заявки с лендинга ──────────────────────────────────────────────────────

-- Лендинг присылает заявку с метками и своим id. Тот же id стоит в ссылке на бота
-- t.me/<бот>?start=<id> — по нему заявка связывается с человеком, когда он нажмёт Start.
CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,                   -- id заявки с лендинга = start-параметр
  name         TEXT,
  phone        TEXT,
  email        TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb, -- остальные поля заявки как есть
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- кто открыл бота по ссылке
  started_at   TIMESTAMPTZ,                        -- когда открыл
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(), -- время заявки на лендинге
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_user_idx ON leads (user_id);

-- Заявка может дойти позже, чем человек нажал Start, — тогда ищем его по start-параметру.
CREATE INDEX IF NOT EXISTS events_start_param_idx ON events ((data->>'start_param')) WHERE type IN ('start', 'restart');

-- Размеры, длительность и превью видео. Без них Telegram показывает видео квадратом,
-- без длительности и обложки. Размеры и длительность сервер читает из файла сам,
-- превью делает админка при загрузке.
ALTER TABLE media ADD COLUMN IF NOT EXISTS width INTEGER;
ALTER TABLE media ADD COLUMN IF NOT EXISTS height INTEGER;
ALTER TABLE media ADD COLUMN IF NOT EXISTS duration INTEGER;
ALTER TABLE media ADD COLUMN IF NOT EXISTS thumb BYTEA;
