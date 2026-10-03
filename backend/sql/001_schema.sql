BEGIN;

CREATE TABLE IF NOT EXISTS users (
  username text PRIMARY KEY,
  password_hash text NOT NULL,
  password_scheme text NOT NULL DEFAULT 'sha256-legacy',
  name text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'superuser')),
  active boolean NOT NULL DEFAULT true,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  username text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS master_values (
  category text NOT NULL CHECK (category IN ('operator','produk','botol','botolpecah','apdCriteria')),
  value text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (category, value)
);

CREATE TABLE IF NOT EXISTS spk (
  batch_no text PRIMARY KEY,
  tanggal date NOT NULL,
  produk text NOT NULL,
  botol text NOT NULL,
  produksi_dus numeric NOT NULL DEFAULT 0 CHECK (produksi_dus >= 0),
  qty_per_dus numeric NOT NULL DEFAULT 0 CHECK (qty_per_dus >= 0),
  qty numeric NOT NULL DEFAULT 0 CHECK (qty >= 0),
  created_by text REFERENCES users(username) ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  update_count integer NOT NULL DEFAULT 0 CHECK (update_count >= 0),
  status text NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS spk_tanggal_idx ON spk(tanggal DESC);

CREATE TABLE IF NOT EXISTS entries (
  id text PRIMARY KEY,
  report_id text NOT NULL,
  tab text NOT NULL CHECK (tab IN ('filling','press')),
  tanggal date NOT NULL,
  operator text NOT NULL,
  produk text NOT NULL,
  botol text NOT NULL,
  qty_kardus numeric NOT NULL DEFAULT 0 CHECK (qty_kardus >= 0),
  qty_botol_per_kardus numeric NOT NULL DEFAULT 0 CHECK (qty_botol_per_kardus >= 0),
  total_qty numeric NOT NULL DEFAULT 0 CHECK (total_qty >= 0),
  botol_pecah_jenis text NOT NULL DEFAULT '',
  qty_botol_pecah numeric NOT NULL DEFAULT 0 CHECK (qty_botol_pecah >= 0),
  qty_kardus_basah numeric NOT NULL DEFAULT 0 CHECK (qty_kardus_basah >= 0),
  created_by text REFERENCES users(username) ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  update_count integer NOT NULL DEFAULT 0 CHECK (update_count >= 0),
  sisa_press_tanggal_asal text NOT NULL DEFAULT '',
  keterangan text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS entries_tab_tanggal_idx ON entries(tab, tanggal DESC);
CREATE INDEX IF NOT EXISTS entries_produk_botol_idx ON entries(lower(produk), lower(botol));
CREATE INDEX IF NOT EXISTS entries_report_id_idx ON entries(report_id);

CREATE TABLE IF NOT EXISTS deleted_entry_audits (
  id bigserial PRIMARY KEY,
  line text NOT NULL,
  tanggal date,
  operator text,
  produk text,
  botol text,
  batch_no text,
  next_update_count integer NOT NULL DEFAULT 1,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by text,
  restored_entry_id text,
  restored_at timestamptz
);

CREATE TABLE IF NOT EXISTS press_adjustments (
  id text PRIMARY KEY,
  tanggal date NOT NULL,
  produk text NOT NULL,
  botol text NOT NULL,
  qty_ditutup numeric NOT NULL CHECK (qty_ditutup >= 0),
  alasan text NOT NULL,
  closed_by text,
  closed_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  qty_botol_per_kardus numeric NOT NULL DEFAULT 0,
  target_batch_no text NOT NULL DEFAULT '',
  target_tanggal_asal text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS apd_entries (
  id text PRIMARY KEY,
  tanggal date NOT NULL,
  operator text NOT NULL,
  scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_points numeric NOT NULL DEFAULT 0,
  percentage numeric NOT NULL DEFAULT 0,
  alasan text NOT NULL DEFAULT '',
  created_by text REFERENCES users(username) ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  UNIQUE (tanggal, operator)
);

CREATE TABLE IF NOT EXISTS apd_photos (
  id text PRIMARY KEY,
  apd_id text REFERENCES apd_entries(id) ON DELETE CASCADE,
  uploaded_by text REFERENCES users(username) ON UPDATE CASCADE,
  mime_type text NOT NULL DEFAULT 'image/jpeg',
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS downtime_entries (
  tanggal date PRIMARY KEY,
  production_start_time time NOT NULL,
  arrival_timestamp timestamptz NOT NULL,
  down_time numeric NOT NULL,
  alasan text NOT NULL,
  keterangan text NOT NULL DEFAULT '',
  updated_by text REFERENCES users(username) ON UPDATE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

INSERT INTO settings(key, value, updated_by) VALUES
  ('kpiFillingOutputTargetMonthly', '150000'::jsonb, 'setup'),
  ('kpiPressOutputTargetMonthly', '70000'::jsonb, 'setup')
ON CONFLICT (key) DO NOTHING;

COMMIT;
