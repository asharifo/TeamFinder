CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  about TEXT NOT NULL DEFAULT '',
  classes TEXT[] NOT NULL DEFAULT '{}',
  skills TEXT[] NOT NULL DEFAULT '{}',
  profile_picture_url TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
