-- PostgreSQL reference schema for a managed AGM Wealth deployment.
-- The working application uses SQLite automatically. Migrating to PostgreSQL
-- also requires replacing the queries in src/db.js with a PostgreSQL client.

create type user_role as enum ('admin', 'staff');

create table schema_migrations (
  version integer primary key,
  applied_at timestamptz not null default now()
);

create table users (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role user_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table sessions (
  id bigint generated always as identity primary key,
  token_hash text not null unique,
  user_id bigint not null references users(id) on delete cascade,
  csrf_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table clients (
  id bigint generated always as identity primary key,
  name text not null,
  pan text,
  email text,
  mobile text,
  risk_profile text not null default 'Moderate',
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_pan_format check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
);

create unique index clients_pan_unique on clients (pan) where pan is not null and pan <> '';
create index clients_search_idx on clients (name, pan, mobile, email);

create table model_portfolios (
  id bigint generated always as identity primary key,
  name text not null,
  risk_level text not null,
  items_json jsonb not null,
  assumptions_json jsonb not null,
  created_by bigint not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table reports (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients(id) on delete cascade,
  source text not null,
  statement_date date,
  status text not null default 'ready',
  portfolio_json jsonb not null,
  analytics_json jsonb not null,
  model_portfolio_id bigint references model_portfolios(id) on delete set null,
  swp_json jsonb,
  created_by bigint not null references users(id),
  created_at timestamptz not null default now()
);

create index reports_client_idx on reports (client_id, created_at desc);

create table recommendations (
  id bigint generated always as identity primary key,
  report_id bigint not null references reports(id) on delete cascade,
  holding_key text not null,
  system_action text not null,
  system_reason text not null,
  final_action text not null,
  client_note text,
  internal_note text,
  updated_by bigint not null references users(id),
  updated_at timestamptz not null default now(),
  unique (report_id, holding_key)
);

create table internal_notes (
  id bigint generated always as identity primary key,
  report_id bigint not null unique references reports(id) on delete cascade,
  tax_check boolean not null default false,
  exit_load_check boolean not null default false,
  lock_in_check boolean not null default false,
  discussion_points text,
  execution_status text not null default 'Pending',
  follow_up_date date,
  updated_by bigint not null references users(id),
  updated_at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  user_id bigint references users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_created_idx on audit_log (created_at desc);
create index sessions_expiry_idx on sessions (expires_at);

insert into schema_migrations (version) values (1), (2);
