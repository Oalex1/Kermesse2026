-- KERMESSE 2026 · Migración: rifas, contactos, tickets QR de un solo uso y stock atómico
-- Ejecutar UNA sola vez en Supabase SQL Editor.

alter table public.pedidos
  add column if not exists whatsapp text,
  add column if not exists email text,
  add column if not exists rifas_cantidad integer not null default 0,
  add column if not exists rifas_precio numeric(10,2) not null default 20,
  add column if not exists ticket_token uuid not null default gen_random_uuid(),
  add column if not exists redeemed_at timestamptz;

create unique index if not exists pedidos_ticket_token_uidx on public.pedidos(ticket_token);

-- Reemplaza la función anterior si existía.
create or replace function public.crear_pedido(
  p_cliente_nombre text,
  p_whatsapp text,
  p_email text,
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
  v_token uuid;
  v_item jsonb;
  v_menu_id bigint;
  v_cantidad integer;
  v_precio numeric;
  v_disponible integer;
  v_vendidos integer;
begin
  if coalesce(trim(p_cliente_nombre), '') = '' then
    raise exception 'El nombre del cliente es obligatorio';
  end if;

  if coalesce(p_rifas_cantidad, 0) < 0 then
    raise exception 'La cantidad de rifas no puede ser negativa';
  end if;

  if coalesce(jsonb_array_length(p_items), 0) = 0 and coalesce(p_rifas_cantidad, 0) = 0 then
    raise exception 'El pedido debe tener al menos un plato o una rifa';
  end if;

  -- Bloqueamos los platos afectados en orden ascendente para evitar que PC y celular
  -- puedan consumir el mismo stock simultáneamente.
  for v_menu_id in
    select distinct (x->>'menu_id')::bigint
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
    order by 1
  loop
    perform 1 from public.menu where id = v_menu_id for update;
    if not found then
      raise exception 'El plato % no existe', v_menu_id;
    end if;
  end loop;

  -- Validación atómica del stock.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_menu_id := (v_item->>'menu_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::integer;

    if v_cantidad <= 0 then
      continue;
    end if;

    select m.stock_inicial, m.precio into v_disponible, v_precio
    from public.menu m where m.id = v_menu_id;

    select coalesce(sum(pi.cantidad), 0)::integer into v_vendidos
    from public.pedido_items pi
    where pi.menu_id = v_menu_id;

    v_disponible := greatest(v_disponible - v_vendidos, 0);

    if v_cantidad > v_disponible then
      raise exception 'STOCK_INSUFICIENTE:%:%', v_menu_id, v_disponible;
    end if;
  end loop;

  insert into public.pedidos (
    cliente_nombre, whatsapp, email, estado, notas, comprobante_url,
    rifas_cantidad, rifas_precio
  ) values (
    trim(p_cliente_nombre), nullif(trim(p_whatsapp), ''), nullif(trim(p_email), ''),
    p_estado, nullif(trim(p_notas), ''), p_comprobante_url,
    coalesce(p_rifas_cantidad, 0), coalesce(p_rifas_precio, 20)
  ) returning id, ticket_token into v_pedido_id, v_token;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_menu_id := (v_item->>'menu_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::integer;
    if v_cantidad <= 0 then continue; end if;

    select precio into v_precio from public.menu where id = v_menu_id;
    insert into public.pedido_items (pedido_id, menu_id, cantidad, precio_unit)
    values (v_pedido_id, v_menu_id, v_cantidad, v_precio);
  end loop;

  return jsonb_build_object(
    'pedido_id', v_pedido_id,
    'ticket_token', v_token
  );
end;
$$;

grant execute on function public.crear_pedido(text,text,text,text,text,text,integer,numeric,jsonb) to anon, authenticated;

-- Canje de QR: UPDATE con redeemed_at IS NULL es atómico.
-- Dos celulares que escaneen exactamente al mismo tiempo: solo uno obtiene ok=true.
create or replace function public.canjear_ticket(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_cliente text;
  v_rifas integer;
  v_rifas_precio numeric;
  v_total numeric;
begin
  update public.pedidos p
  set redeemed_at = now()
  where p.ticket_token = p_token
    and p.redeemed_at is null
  returning p.id, p.cliente_nombre, p.rifas_cantidad, p.rifas_precio
  into v_id, v_cliente, v_rifas, v_rifas_precio;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'ALREADY_USED_OR_INVALID');
  end if;

  select coalesce(sum(pi.cantidad * pi.precio_unit), 0) + coalesce(v_rifas, 0) * coalesce(v_rifas_precio, 20)
  into v_total
  from public.pedido_items pi
  where pi.pedido_id = v_id;

  return jsonb_build_object(
    'ok', true,
    'pedido_id', v_id,
    'cliente_nombre', v_cliente,
    'total', v_total,
    'redeemed_at', now()
  );
end;
$$;

grant execute on function public.canjear_ticket(uuid) to anon, authenticated;

-- Permite que la función security definer haga las operaciones sin depender de las RLS del cliente.
revoke all on function public.canjear_ticket(uuid) from public;
grant execute on function public.canjear_ticket(uuid) to anon, authenticated;

-- Estado de envío automático del ticket electrónico.
alter table public.pedidos
  add column if not exists email_enviado_at timestamptz,
  add column if not exists whatsapp_enviado_at timestamptz,
  add column if not exists notificacion_error text;
