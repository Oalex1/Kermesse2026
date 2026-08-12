-- =========================================================
-- KERMESSE 2026 · BASE NUEVA / LIMPIA
-- =========================================================
-- IMPORTANTE: este archivo reemplaza el avance anterior.
-- Como todavía no hay datos, se eliminan las tablas/funciones anteriores
-- y se crean nuevamente desde cero.
--
-- Incluye SOLO lo que necesitamos ahora:
--   - personas
--   - menu con stock
--   - pedidos
--   - pedido_items
--   - rifas ilimitadas por pedido
--   - función atómica para evitar vender más stock del disponible
--
-- Las rifas NO consumen stock. Precio actual: Bs 20 c/u.
-- Si quieres otro precio, cambia RIFA_PRECIO en js/app.js y el valor
-- por defecto de rifas_precio aquí.
-- =========================================================

-- ---------- LIMPIEZA DEL AVANCE ANTERIOR ----------
drop function if exists public.crear_pedido(text,text,text,text,jsonb);
drop function if exists public.crear_pedido(text,text,text,text,text,text,integer,numeric,jsonb);

drop table if exists public.pedido_items cascade;
drop table if exists public.pedidos cascade;
drop table if exists public.personas cascade;
drop table if exists public.menu cascade;

-- Políticas de Storage del avance anterior (si existen).
drop policy if exists "comprobantes: insercion publica" on storage.objects;
drop policy if exists "comprobantes: lectura publica" on storage.objects;

-- ---------- TABLA: personas ----------
create table public.personas (
  id bigint generated always as identity primary key,
  nombres text not null,
  apellidos text not null,
  created_at timestamptz not null default now()
);

-- ---------- TABLA: menu ----------
create table public.menu (
  id bigint generated always as identity primary key,
  plato text not null,
  precio numeric(10,2) not null check (precio >= 0),
  stock_inicial integer not null default 0 check (stock_inicial >= 0),
  color text not null default '#2E7D32',
  icono text not null default '🍽️',
  orden integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- TABLA: pedidos ----------
create table public.pedidos (
  id bigint generated always as identity primary key,
  cliente_nombre text not null,
  estado text not null default 'Pendiente'
    check (estado in ('Pagado','Pendiente','No Pagado')),
  notas text,
  comprobante_url text,
  rifas_cantidad integer not null default 0 check (rifas_cantidad >= 0),
  rifas_precio numeric(10,2) not null default 20 check (rifas_precio >= 0),
  created_at timestamptz not null default now()
);

-- ---------- TABLA: pedido_items ----------
create table public.pedido_items (
  id bigint generated always as identity primary key,
  pedido_id bigint not null references public.pedidos(id) on delete cascade,
  menu_id bigint not null references public.menu(id),
  cantidad integer not null check (cantidad > 0),
  precio_unit numeric(10,2) not null check (precio_unit >= 0)
);

-- ---------- RLS ----------
alter table public.personas enable row level security;
alter table public.menu enable row level security;
alter table public.pedidos enable row level security;
alter table public.pedido_items enable row level security;

create policy "personas: lectura publica" on public.personas
  for select to anon, authenticated using (true);
create policy "personas: insercion publica" on public.personas
  for insert to anon, authenticated with check (true);

create policy "menu: lectura publica" on public.menu
  for select to anon, authenticated using (true);
create policy "menu: actualizacion publica" on public.menu
  for update to anon, authenticated using (true) with check (true);

create policy "pedidos: lectura publica" on public.pedidos
  for select to anon, authenticated using (true);
create policy "pedidos: actualizacion publica" on public.pedidos
  for update to anon, authenticated using (true) with check (true);

create policy "items: lectura publica" on public.pedido_items
  for select to anon, authenticated using (true);

-- Los INSERT de pedidos/items se hacen mediante la función security definer.
-- No damos INSERT directo al navegador: así el stock siempre pasa por la
-- validación atómica de crear_pedido().

-- ---------- DATOS INICIALES ----------
insert into public.menu (plato, precio, stock_inicial, color, icono, orden) values
  ('Pescado a la Parrilla',           45, 100, '#3AA6B9', '🐟', 1),
  ('Chorizo Criollo',                 35, 100, '#D64545', '🌭', 2),
  ('Pollo o Chancho a la Caja China', 45, 100, '#5FA85D', '🍗', 3);

insert into public.personas (nombres, apellidos) values
  ('Douglas','Gutierrez'), ('Ruddy','Quisbert'), ('Royci','Huarachi'),
  ('Carlos','Guerrero Rivadineira'), ('Daniela','Del Corpio'), ('Humberto','Camacho'),
  ('Jimmy','Cáceres'), ('José','Trigo'), ('Nancy','Manuel'), ('Nicolas','Torrejón'),
  ('Rodrigo','Colque'), ('Samuel','Mejia'), ('Tadeo','Ortiz'), ('Ruddy','Murillo');

-- ---------- FUNCIÓN ATÓMICA DE REGISTRO ----------
-- Esta es la parte importante del bug de PC + celular.
--
-- Ejemplo:
--   Stock = 3
--   Celular registra 2
--   PC intenta registrar 3
--
-- La función bloquea el plato, vuelve a comprobar el stock real y RECHAZA
-- el pedido completo. Nunca guarda 1 ni guarda parcialmente el pedido.
-- El navegador recibe STOCK_INSUFICIENTE:<menu_id>:<disponible> y pone los
-- contadores en 0 para evitar que el usuario vuelva a registrar accidentalmente.
create or replace function public.crear_pedido(
  p_cliente_nombre text,
  p_estado text,
  p_notas text,
  p_comprobante_url text,
  p_rifas_cantidad integer,
  p_rifas_precio numeric,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pedido_id bigint;
  v_item jsonb;
  v_menu_id bigint;
  v_cantidad integer;
  v_precio numeric;
  v_stock integer;
  v_vendidos integer;
  v_plato text;
  v_total_item integer;
begin
  if coalesce(trim(p_cliente_nombre), '') = '' then
    raise exception 'El nombre del cliente es obligatorio';
  end if;

  if p_estado not in ('Pagado', 'Pendiente', 'No Pagado') then
    raise exception 'Estado de pago inválido';
  end if;

  if coalesce(p_rifas_cantidad, 0) < 0 then
    raise exception 'La cantidad de rifas no puede ser negativa';
  end if;

  if coalesce(jsonb_array_length(p_items), 0) = 0
     and coalesce(p_rifas_cantidad, 0) = 0 then
    raise exception 'El pedido debe tener al menos un plato o una rifa';
  end if;

  -- Bloqueamos cada plato afectado en un orden fijo.
  -- Esto evita que dos dispositivos consuman el mismo stock simultáneamente.
  for v_menu_id in
    select distinct (x->>'menu_id')::bigint
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    where coalesce((x->>'cantidad')::integer, 0) > 0
    order by 1
  loop
    perform 1
    from public.menu
    where id = v_menu_id
    for update;

    if not found then
      raise exception 'El plato % no existe', v_menu_id;
    end if;
  end loop;

  -- Validamos la suma por plato, por si algún cliente malicioso manda
  -- el mismo menu_id dos veces dentro del JSON.
  for v_menu_id, v_total_item in
    select
      (x->>'menu_id')::bigint,
      sum((x->>'cantidad')::integer)::integer
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    group by (x->>'menu_id')::bigint
    order by 1
  loop
    if v_total_item <= 0 then
      continue;
    end if;

    select m.stock_inicial, m.plato
      into v_stock, v_plato
    from public.menu m
    where m.id = v_menu_id;

    select coalesce(sum(pi.cantidad), 0)::integer
      into v_vendidos
    from public.pedido_items pi
    where pi.menu_id = v_menu_id;

    if v_vendidos + v_total_item > v_stock then
      raise exception 'STOCK_INSUFICIENTE:%:%',
        v_menu_id,
        greatest(v_stock - v_vendidos, 0);
    end if;
  end loop;

  -- Si llegamos aquí, TODO el pedido cabe. Recién ahora insertamos.
  insert into public.pedidos (
    cliente_nombre,
    estado,
    notas,
    comprobante_url,
    rifas_cantidad,
    rifas_precio
  )
  values (
    trim(p_cliente_nombre),
    p_estado,
    nullif(trim(p_notas), ''),
    p_comprobante_url,
    coalesce(p_rifas_cantidad, 0),
    coalesce(p_rifas_precio, 20)
  )
  returning id into v_pedido_id;

  for v_item in
    select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_menu_id := (v_item->>'menu_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::integer;
    if v_cantidad <= 0 then
      continue;
    end if;

    select precio into v_precio
    from public.menu
    where id = v_menu_id;

    insert into public.pedido_items (pedido_id, menu_id, cantidad, precio_unit)
    values (v_pedido_id, v_menu_id, v_cantidad, v_precio);
  end loop;

  return jsonb_build_object('pedido_id', v_pedido_id);
end;
$$;

revoke all on function public.crear_pedido(text,text,text,text,integer,numeric,jsonb) from public;
grant execute on function public.crear_pedido(text,text,text,text,integer,numeric,jsonb)
to anon, authenticated;

-- ---------- STORAGE ----------
-- Crea primero el bucket público "comprobantes" desde Storage.
create policy "comprobantes: insercion publica"
on storage.objects
for insert to anon, authenticated
with check (bucket_id = 'comprobantes');

create policy "comprobantes: lectura publica"
on storage.objects
for select to anon, authenticated
using (bucket_id = 'comprobantes');

-- ---------- REALTIME ----------
-- Lo hacemos de forma idempotente para que no falle si una tabla ya estaba
-- incluida en supabase_realtime.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pedidos') then
    alter publication supabase_realtime add table public.pedidos;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pedido_items') then
    alter publication supabase_realtime add table public.pedido_items;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'menu') then
    alter publication supabase_realtime add table public.menu;
  end if;
end;
$$;
