-- =========================================================
-- KERMESSE 2026 · ESQUEMA ACTUAL (CONSOLIDADO)
-- =========================================================
-- Este archivo refleja el estado final de la base de datos, incluyendo
-- todos los cambios que se fueron aplicando (vendedor/cliente separados,
-- método de pago, tickets con QR, entrega).
--
-- Úsalo para levantar un proyecto de Supabase NUEVO desde cero.
-- Si ya tienes datos cargados en producción, NO vuelvas a correr este
-- archivo completo (el DROP TABLE borra todo). Para agregar solo la
-- función nueva de "ver ticket" a una base que ya existe, usa el bloque
-- al final marcado como "MIGRACIÓN INCREMENTAL".
--
-- Las rifas NO consumen stock. Precio actual: Bs 20 c/u.
-- =========================================================

-- ---------- LIMPIEZA DEL AVANCE ANTERIOR ----------
drop function if exists public.crear_pedido(text,text,text,text,jsonb);
drop function if exists public.crear_pedido(text,text,text,text,integer,numeric,jsonb);
drop function if exists public.crear_pedido(text,text,text,text,text,integer,numeric,jsonb);
drop function if exists public.crear_pedido(text,text,text,text,text,text,integer,numeric,jsonb);
drop function if exists public.entregar_pedido(text);
drop function if exists public.ver_pedido(text);

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
  vendedor_nombre text not null,
  cliente_nombre text not null,
  estado text not null default 'Pendiente'
    check (estado in ('Pagado','Pendiente','No Pagado')),
  metodo_pago text not null default 'Efectivo'
    check (metodo_pago in ('Efectivo','QR')),
  notas text,
  comprobante_url text,
  rifas_cantidad integer not null default 0 check (rifas_cantidad >= 0),
  rifas_precio numeric(10,2) not null default 20 check (rifas_precio >= 0),
  ticket_token text unique,
  entregado_at timestamptz,
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
-- El stock del menú solo se actualiza a través de la función de servidor;
-- no se dan permisos de UPDATE directo al navegador.

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
  ('Rodrigo','Colque'), ('Samuel','Mejia'), ('Tadeo','Ortiz'), ('Ruddy','Murillo'),
  ('Alejandra','Jimenez');

-- ---------- FUNCIÓN ATÓMICA DE REGISTRO ----------
-- Bloquea cada plato afectado (FOR UPDATE) y vuelve a comprobar el stock
-- real antes de insertar, para que dos dispositivos nunca puedan vender el
-- mismo stock al mismo tiempo. Si no alcanza, rechaza TODO el pedido con
-- STOCK_INSUFICIENTE:<menu_id>:<disponible> y no guarda nada parcial.
--
-- Además genera un ticket_token único por pedido: ese token es lo único
-- que viaja en el QR del ticket.
create or replace function public.crear_pedido(
  p_vendedor_nombre text,
  p_cliente_nombre text,
  p_estado text,
  p_metodo_pago text,
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
  v_ticket_token text;
  v_item jsonb;
  v_menu_id bigint;
  v_cantidad integer;
  v_precio numeric;
  v_stock integer;
  v_vendidos integer;
  v_total_item integer;
begin
  if coalesce(trim(p_vendedor_nombre), '') = '' then
    raise exception 'Selecciona un vendedor';
  end if;

  if not exists (
    select 1 from public.personas
    where trim(nombres || ' ' || apellidos) = trim(p_vendedor_nombre)
  ) then
    raise exception 'Vendedor no válido: elige uno de la lista';
  end if;

  if coalesce(trim(p_cliente_nombre), '') = '' then
    raise exception 'El nombre del cliente es obligatorio';
  end if;

  if p_estado not in ('Pagado', 'Pendiente', 'No Pagado') then
    raise exception 'Estado de pago inválido';
  end if;

  if coalesce(p_metodo_pago, 'Efectivo') not in ('Efectivo', 'QR') then
    raise exception 'Método de pago inválido';
  end if;

  if coalesce(p_rifas_cantidad, 0) < 0 then
    raise exception 'La cantidad de rifas no puede ser negativa';
  end if;

  if coalesce(jsonb_array_length(p_items), 0) = 0
     and coalesce(p_rifas_cantidad, 0) = 0 then
    raise exception 'El pedido debe tener al menos un plato o una rifa';
  end if;

  -- Bloqueamos cada plato afectado en un orden fijo, para evitar que dos
  -- dispositivos consuman el mismo stock simultáneamente.
  for v_menu_id in
    select distinct (x->>'menu_id')::bigint
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    where coalesce((x->>'cantidad')::integer, 0) > 0
    order by 1
  loop
    perform 1 from public.menu where id = v_menu_id for update;
    if not found then
      raise exception 'El plato % no existe', v_menu_id;
    end if;
  end loop;

  -- Validamos la suma por plato, por si el mismo menu_id viene repetido.
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

    select m.stock_inicial into v_stock
    from public.menu m where m.id = v_menu_id;

    select coalesce(sum(pi.cantidad), 0)::integer into v_vendidos
    from public.pedido_items pi where pi.menu_id = v_menu_id;

    if v_vendidos + v_total_item > v_stock then
      raise exception 'STOCK_INSUFICIENTE:%:%', v_menu_id, greatest(v_stock - v_vendidos, 0);
    end if;
  end loop;

  v_ticket_token := replace(gen_random_uuid()::text, '-', '');

  insert into public.pedidos (
    vendedor_nombre, cliente_nombre, estado, metodo_pago,
    notas, comprobante_url, rifas_cantidad, rifas_precio, ticket_token
  )
  values (
    trim(p_vendedor_nombre), trim(p_cliente_nombre), p_estado,
    coalesce(p_metodo_pago, 'Efectivo'),
    nullif(trim(p_notas), ''), p_comprobante_url,
    coalesce(p_rifas_cantidad, 0), coalesce(p_rifas_precio, 20), v_ticket_token
  )
  returning id into v_pedido_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_menu_id := (v_item->>'menu_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::integer;
    if v_cantidad <= 0 then continue; end if;

    select precio into v_precio from public.menu where id = v_menu_id;
    insert into public.pedido_items (pedido_id, menu_id, cantidad, precio_unit)
    values (v_pedido_id, v_menu_id, v_cantidad, v_precio);
  end loop;

  return jsonb_build_object('pedido_id', v_pedido_id, 'ticket_token', v_ticket_token);
end;
$$;

revoke all on function public.crear_pedido(text,text,text,text,text,text,integer,numeric,jsonb) from public;
grant execute on function public.crear_pedido(text,text,text,text,text,text,integer,numeric,jsonb)
to anon, authenticated;

-- ---------- FUNCIÓN: VER TICKET (SOLO LECTURA) ----------
-- Esto es lo que se llama cuando alguien escanea el QR del ticket
-- (canjear.html). SOLO consulta y devuelve el detalle del pedido —
-- nunca marca nada como entregado. Escanear el mismo QR mil veces
-- siempre muestra lo mismo, sin efectos secundarios.
create or replace function public.ver_pedido(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pedido public.pedidos%rowtype;
  v_items jsonb;
  v_total numeric;
begin
  select * into v_pedido
  from public.pedidos
  where ticket_token = p_token;

  if not found then
    return jsonb_build_object('reason', 'NO_EXISTE');
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object('cantidad', pi.cantidad, 'plato', m.plato)),
    '[]'::jsonb
  )
  into v_items
  from public.pedido_items pi
  join public.menu m on m.id = pi.menu_id
  where pi.pedido_id = v_pedido.id;

  select coalesce(sum(pi.cantidad * pi.precio_unit), 0)
    + (coalesce(v_pedido.rifas_cantidad, 0) * coalesce(v_pedido.rifas_precio, 20))
  into v_total
  from public.pedido_items pi
  where pi.pedido_id = v_pedido.id;

  return jsonb_build_object(
    'reason', case when v_pedido.entregado_at is not null then 'ENTREGADO' else 'PENDIENTE' end,
    'entregado_at', v_pedido.entregado_at,
    'cliente_nombre', v_pedido.cliente_nombre,
    'vendedor_nombre', v_pedido.vendedor_nombre,
    'estado', v_pedido.estado,
    'metodo_pago', v_pedido.metodo_pago,
    'rifas_cantidad', v_pedido.rifas_cantidad,
    'items', v_items,
    'total', v_total
  );
end;
$$;

revoke all on function public.ver_pedido(text) from public;
grant execute on function public.ver_pedido(text) to anon, authenticated;

-- ---------- FUNCIÓN: MARCAR PEDIDO COMO RECOGIDO ----------
-- Esta función SOLO la llama la app de administración (el botón
-- "Marcar como recogido" en la pestaña Pedidos), nunca el QR del cliente.
-- Es idempotente: si ya estaba entregado, simplemente devuelve el mismo
-- detalle sin duplicar nada.
create or replace function public.entregar_pedido(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pedido public.pedidos%rowtype;
  v_items jsonb;
  v_total numeric;
begin
  select * into v_pedido
  from public.pedidos
  where ticket_token = p_token
  for update;

  if not found then
    return jsonb_build_object('reason', 'NO_EXISTE');
  end if;

  if v_pedido.entregado_at is null then
    update public.pedidos
    set entregado_at = now()
    where id = v_pedido.id
    returning entregado_at into v_pedido.entregado_at;
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object('cantidad', pi.cantidad, 'plato', m.plato)),
    '[]'::jsonb
  )
  into v_items
  from public.pedido_items pi
  join public.menu m on m.id = pi.menu_id
  where pi.pedido_id = v_pedido.id;

  select coalesce(sum(pi.cantidad * pi.precio_unit), 0)
    + (coalesce(v_pedido.rifas_cantidad, 0) * coalesce(v_pedido.rifas_precio, 20))
  into v_total
  from public.pedido_items pi
  where pi.pedido_id = v_pedido.id;

  return jsonb_build_object(
    'reason', 'ENTREGADO',
    'entregado_at', v_pedido.entregado_at,
    'cliente_nombre', v_pedido.cliente_nombre,
    'vendedor_nombre', v_pedido.vendedor_nombre,
    'rifas_cantidad', v_pedido.rifas_cantidad,
    'items', v_items,
    'total', v_total
  );
end;
$$;

revoke all on function public.entregar_pedido(text) from public;
grant execute on function public.entregar_pedido(text) to anon, authenticated;

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

-- =========================================================
-- MIGRACIÓN INCREMENTAL (para tu base que ya existe)
-- =========================================================
-- No corras el archivo completo de arriba en una base con datos: el DROP
-- TABLE del principio borra todo. Para agregar SOLO la función de "ver
-- ticket sin marcar entrega", copia y corre nada más este bloque en el
-- SQL Editor de Supabase:
--
-- drop function if exists public.ver_pedido(text);
--
-- create or replace function public.ver_pedido(p_token text)
-- returns jsonb language plpgsql security definer set search_path = public
-- as $f$
-- declare
--   v_pedido public.pedidos%rowtype;
--   v_items jsonb;
--   v_total numeric;
-- begin
--   select * into v_pedido from public.pedidos where ticket_token = p_token;
--   if not found then
--     return jsonb_build_object('reason', 'NO_EXISTE');
--   end if;
--   select coalesce(jsonb_agg(jsonb_build_object('cantidad', pi.cantidad, 'plato', m.plato)), '[]'::jsonb)
--     into v_items from public.pedido_items pi join public.menu m on m.id = pi.menu_id
--     where pi.pedido_id = v_pedido.id;
--   select coalesce(sum(pi.cantidad * pi.precio_unit), 0)
--     + (coalesce(v_pedido.rifas_cantidad, 0) * coalesce(v_pedido.rifas_precio, 20))
--     into v_total from public.pedido_items pi where pi.pedido_id = v_pedido.id;
--   return jsonb_build_object(
--     'reason', case when v_pedido.entregado_at is not null then 'ENTREGADO' else 'PENDIENTE' end,
--     'entregado_at', v_pedido.entregado_at,
--     'cliente_nombre', v_pedido.cliente_nombre,
--     'vendedor_nombre', v_pedido.vendedor_nombre,
--     'estado', v_pedido.estado,
--     'metodo_pago', v_pedido.metodo_pago,
--     'rifas_cantidad', v_pedido.rifas_cantidad,
--     'items', v_items,
--     'total', v_total
--   );
-- end;
-- $f$;
--
-- revoke all on function public.ver_pedido(text) from public;
-- grant execute on function public.ver_pedido(text) to anon, authenticated;
