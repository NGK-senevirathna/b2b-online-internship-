CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username varchar(30) NOT NULL,
    username_normalized varchar(30) GENERATED ALWAYS AS (lower(username)) STORED,
    email varchar(254) NOT NULL,
    email_normalized varchar(254) GENERATED ALWAYS AS (lower(email)) STORED,
    password_hash text NOT NULL,
    role varchar(16) NOT NULL CHECK (role IN ('Buyer', 'Seller', 'Admin')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_username_normalized_key UNIQUE (username_normalized),
    CONSTRAINT users_email_normalized_key UNIQUE (email_normalized)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES auth_sessions (id) ON DELETE CASCADE,
    token_hash char(64) NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    replaced_by_hash char(64)
);

CREATE INDEX IF NOT EXISTS refresh_tokens_session_id_idx ON refresh_tokens (session_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_hits (
    key text PRIMARY KEY,
    total_hits integer NOT NULL CHECK (total_hits >= 0),
    reset_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limit_hits_reset_at_idx ON rate_limit_hits (reset_at);
