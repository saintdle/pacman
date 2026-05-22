CREATE TABLE IF NOT EXISTS highscores (
  id          UUID PRIMARY KEY,
  name        TEXT,
  cloud       TEXT,
  zone        TEXT,
  host        TEXT,
  score       INTEGER NOT NULL,
  level       INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  referer     TEXT,
  user_agent  TEXT,
  hostname    TEXT,
  ip_addr     INET
);

CREATE INDEX IF NOT EXISTS highscores_score_desc_idx ON highscores (score DESC);

CREATE TABLE IF NOT EXISTS user_stats (
  id              UUID PRIMARY KEY,
  cloud           TEXT,
  zone            TEXT,
  host            TEXT,
  score           INTEGER,
  level           INTEGER,
  lives           INTEGER,
  elapsed_time    INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  referer         TEXT,
  user_agent      TEXT,
  hostname        TEXT,
  ip_addr         INET,
  update_counter  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS user_stats_score_idx ON user_stats (score) WHERE score IS NOT NULL;
