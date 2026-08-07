-- =========================================================
--  KERMESSE 2024 · Esquema de base de datos para Supabase
-- =========================================================
-- Cómo usar:
-- 1. Ve a tu proyecto en https://supabase.com  →  SQL Editor
-- 2. Pega todo este archivo y dale "Run".
-- 3. Ve a Storage → crea un bucket llamado "comprobantes" y márcalo como PÚBLICO.
--    (Storage no se puede crear por SQL en el plan gratuito, se hace desde la UI)
-- 4. Copia tu Project URL y anon public key (Project Settings → API)
--    y pégalas en js/config.js
-- =========================================================

-- ---------- Tabla: personas ----------
-- Solo se usa para autocompletar el nombre en el formulario de pedido.
create table if not exists personas (
  id bigint generated always as identity primary key,
  nombres text not null,
  apellidos text not null,
  created_at timestamptz not null default now()
);

-- ---------- Tabla: menu ----------
create table if not exists menu (
  id bigint generated always as identity primary key,
  plato text not null,
  precio numeric(10,2) not null,
  stock_inicial integer not null default 0,
  color text not null default '#2E7D32',   -- color de marca del plato (hex)
  icono text not null default '🍽️',        -- emoji representativo
  orden integer not null default 0,         -- para ordenar las tarjetas
  created_at timestamptz not null default now()
);

-- ---------- Tabla: pedidos ----------
-- Un pedido = una persona. Los platos van en pedido_items (uno o varios por pedido).
create table if not exists pedidos (
  id bigint generated always as identity primary key,
  cliente_nombre text not null,
  estado text not null default 'Pendiente'
        check (estado in ('Pagado','Pendiente','No Pagado')),
  notas text,
  comprobante_url text,           -- URL pública de la imagen del comprobante de pago
  created_at timestamptz not null default now()
);

-- ---------- Tabla: pedido_items ----------
create table if not exists pedido_items (
  id bigint generated always as identity primary key,
  pedido_id bigint not null references pedidos(id) on delete cascade,
  menu_id bigint not null references menu(id),
  cantidad integer not null check (cantidad > 0),
  precio_unit numeric(10,2) not null   -- se guarda el precio al momento del pedido
);

-- =========================================================
--  Seguridad (RLS)
--  Se pidió una app SIN login: cualquiera puede leer y escribir.
--  Si más adelante quieres restringir la edición, aquí es donde
--  se ajustan estas políticas (por ejemplo, exigiendo un rol o clave).
-- =========================================================
alter table personas     enable row level security;
alter table menu         enable row level security;
alter table pedidos      enable row level security;
alter table pedido_items enable row level security;

create policy "personas: lectura publica"  on personas for select using (true);
create policy "personas: insercion publica" on personas for insert with check (true);

create policy "menu: lectura publica" on menu for select using (true);
create policy "menu: actualizacion publica" on menu for update using (true);

create policy "pedidos: lectura publica"   on pedidos for select using (true);
create policy "pedidos: insercion publica" on pedidos for insert with check (true);
create policy "pedidos: actualizacion publica" on pedidos for update using (true);

create policy "items: lectura publica"   on pedido_items for select using (true);
create policy "items: insercion publica" on pedido_items for insert with check (true);

-- =========================================================
--  Datos iniciales
-- =========================================================
insert into menu (plato, precio, stock_inicial, color, icono, orden) values
  ('Pescado a la Parrilla',   50, 100, '#3AA6B9', '🐟', 1),
  ('Chorizo Criollo',         40, 100, '#D64545', '🌭', 2),
  ('Chancho',                 45, 100, '#E08A3E', '🐷', 3),
  ('Pollo a la Caja China',   45, 100, '#5FA85D', '🍗', 4)
on conflict do nothing;

insert into personas (nombres, apellidos) values
  ('Douglas','Gutierrez'), ('Ruddy','Quisbert'), ('Royci','Huarachi'),
  ('Carlos','Guerrero Rivadineira'), ('Daniela','Del Corpio'), ('Humberto','Camacho'),
  ('Jimmy','Cáceres'), ('José','Trigo'), ('Nancy','Manuel'), ('Nicolas','Torrejón'),
  ('Rodrigo','Colque'), ('Samuel','Mejia'), ('Tadeo','Ortiz'), ('Ruddy','Murillo')
on conflict do nothing;

-- =========================================================
--  Realtime (opcional pero recomendado)
--  Activa la replicación en tiempo real para que el dashboard
--  se actualice solo en todos los celulares conectados.
--  Ve a Database → Replication → activa "pedidos" y "pedido_items".
--  O ejecuta:
-- =========================================================
alter publication supabase_realtime add table pedidos;
alter publication supabase_realtime add table pedido_items;
