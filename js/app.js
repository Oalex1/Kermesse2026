import { supabase, isConfigured } from "./supabaseClient.js";
import { COMPROBANTES_BUCKET } from "./config.js";
import { addPending, getAllPending, deletePending } from "./offlineQueue.js";

/* ---------------------------------------------------------
   Helpers cortos
--------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));
const bs = (n) => `Bs ${Math.round(n).toLocaleString("es-BO")}`;
const RIFA_PRECIO = 20;

/* ---------------------------------------------------------
   Estado en memoria
--------------------------------------------------------- */
const state = {
  menu: [],       // [{id, plato, precio, stock_inicial, color, icono, orden}]
  personas: [],   // [{id, nombres, apellidos}]
  pedidos: [],    // [{id, cliente_nombre, estado, notas, comprobante_url, created_at, pedido_items:[{cantidad, precio_unit, menu:{...}}]}]
  filtro: "Todos",
  busqueda: "",
  comprobanteFile: null,
  rifasCantidad: 0,
};

/* ---------------------------------------------------------
   Arranque
--------------------------------------------------------- */
async function init() {
  setupTabs();
  setupOnlineBanner();
  registerServiceWorker();

  medirTabbar();
  window.addEventListener("resize", medirTabbar);
  window.addEventListener("orientationchange", medirTabbar);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(medirTabbar);

  if (!isConfigured) {
    $("#config-banner").hidden = false;
    return; // no seguimos sin credenciales
  }

  setupForm();
  setupPedidosFilters();
  setupImageModal();

  await Promise.all([loadMenu(), loadPersonas(), loadPedidos()]);
  renderAll();
  subscribeRealtime();
  if (navigator.onLine) syncPendingOrders();
}

/* ---------------------------------------------------------
   Tabs
--------------------------------------------------------- */
function setupTabs() {
  $all(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

// Mide el alto real del menú de abajo y lo guarda en una variable CSS,
// para que el espacio reservado sea exacto en cualquier celular/orientación.
function medirTabbar() {
  const tabbar = document.querySelector(".tabbar");
  if (!tabbar) return;
  const alto = tabbar.getBoundingClientRect().height;
  if (alto > 0) document.documentElement.style.setProperty("--tabbar-h", `${alto}px`);
}
function switchTab(name) {
  $all(".tab").forEach((s) => s.classList.toggle("is-active", s.id === `tab-${name}`));
  $all(".tab-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
  if (name === "nuevo") updateDisponibles(); // refresca los máximos por si cambió el stock
}

/* ---------------------------------------------------------
   Banner de conexión
--------------------------------------------------------- */
function setupOnlineBanner() {
  const banner = $("#offline-banner");
  const update = () => {
    banner.hidden = navigator.onLine;
    if (navigator.onLine) syncPendingOrders();
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", () => { banner.hidden = navigator.onLine; });
  banner.hidden = navigator.onLine;
  updatePendingBanner();
}

/* ---------------------------------------------------------
   Guardado local (para que la app tenga qué mostrar sin internet)
--------------------------------------------------------- */
const CACHE_KEYS = { menu: "kermesse_cache_menu", personas: "kermesse_cache_personas", pedidos: "kermesse_cache_pedidos" };

function cacheSave(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { /* almacenamiento lleno o bloqueado: no es crítico */ }
}
function cacheLoad(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

/* ---------------------------------------------------------
   Carga de datos
   Si no hay internet (o Supabase no responde), usa la última
   copia guardada en el celular en vez de dejar todo vacío.
--------------------------------------------------------- */
async function loadMenu() {
  if (!navigator.onLine) { state.menu = cacheLoad(CACHE_KEYS.menu); return; }
  try {
    const { data, error } = await supabase
      .from("menu")
      .select("id, plato, precio, stock_inicial, color, icono, orden")
      .order("orden", { ascending: true });
    if (error) throw error;
    state.menu = data || [];
    cacheSave(CACHE_KEYS.menu, state.menu);
  } catch (err) {
    state.menu = cacheLoad(CACHE_KEYS.menu);
    if (state.menu.length === 0) toast("No se pudo cargar el menú: " + err.message, "error");
  }
}

async function loadPersonas() {
  if (!navigator.onLine) { state.personas = cacheLoad(CACHE_KEYS.personas); return; }
  try {
    const { data, error } = await supabase
      .from("personas")
      .select("id, nombres, apellidos")
      .order("nombres", { ascending: true });
    if (error) throw error;
    state.personas = data || [];
    cacheSave(CACHE_KEYS.personas, state.personas);
  } catch (err) {
    state.personas = cacheLoad(CACHE_KEYS.personas);
  }
}

async function loadPedidos() {
  if (!navigator.onLine) { state.pedidos = cacheLoad(CACHE_KEYS.pedidos); return; }
  try {
    const { data, error } = await supabase
      .from("pedidos")
      .select(`
        id, cliente_nombre, vendedor_nombre, estado, notas, comprobante_url, rifas_cantidad, rifas_precio, created_at,
        pedido_items ( cantidad, precio_unit, menu ( id, plato, icono, color ) )
      `)
      .order("created_at", { ascending: false });
    if (error) throw error;
    state.pedidos = data || [];
    cacheSave(CACHE_KEYS.pedidos, state.pedidos);
  } catch (err) {
    state.pedidos = cacheLoad(CACHE_KEYS.pedidos);
    if (state.pedidos.length === 0) toast("No se pudo cargar pedidos: " + err.message, "error");
  }
}

function renderAll() {
  renderDashboard();
  renderVendedorSelect();
  renderItemsFields();
  renderPedidosList();
  renderMenuEditor();
  $("#last-update").textContent = "Actualizado " + new Date().toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" });
}

/* ---------------------------------------------------------
   Tiempo real: cualquier cambio en pedidos/items refresca todo
--------------------------------------------------------- */
function subscribeRealtime() {
  supabase
    .channel("kermesse-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "pedidos" }, refreshLive)
    .on("postgres_changes", { event: "*", schema: "public", table: "pedido_items" }, refreshLive)
    .on("postgres_changes", { event: "*", schema: "public", table: "menu" }, refreshLive)
    .subscribe();
}
let refreshTimer = null;
function refreshLive() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await Promise.all([loadMenu(), loadPedidos()]);
    renderDashboard();
    renderPedidosList();
    renderMenuEditor();
    if ($("#tab-nuevo").classList.contains("is-active")) updateDisponibles();
    $("#last-update").textContent = "Actualizado ahora mismo";
  }, 400);
}

/* ---------------------------------------------------------
   DASHBOARD
--------------------------------------------------------- */
function computeStats() {
  const pedidos = state.pedidos;
  const totalVendido = pedidos.reduce((sum, p) => sum + pedidoTotal(p), 0);

  const ventasPorVendedor = {}; // vendedor -> {total, pedidos}
  for (const p of pedidos) {
    const v = (p.vendedor_nombre || "Sin vendedor").trim();
    if (!ventasPorVendedor[v]) ventasPorVendedor[v] = { total: 0, pedidos: 0 };
    ventasPorVendedor[v].total += pedidoTotal(p);
    ventasPorVendedor[v].pedidos += 1;
  }
  let vendedorTop = "—";
  let vendedorTopPedidos = 0;
  let maxVentas = -1;
  for (const nombre in ventasPorVendedor) {
    if (ventasPorVendedor[nombre].total > maxVentas) {
      maxVentas = ventasPorVendedor[nombre].total;
      vendedorTop = nombre;
      vendedorTopPedidos = ventasPorVendedor[nombre].pedidos;
    }
  }

  const vendidosPorPlato = {}; // menu_id -> {vendidos, pedidosSet, plato, icono, color}
  for (const p of pedidos) {
    for (const it of p.pedido_items || []) {
      if (!it.menu) continue;
      const id = it.menu.id;
      if (!vendidosPorPlato[id]) {
        vendidosPorPlato[id] = { vendidos: 0, pedidosSet: new Set(), plato: it.menu.plato, icono: it.menu.icono, color: it.menu.color };
      }
      vendidosPorPlato[id].vendidos += it.cantidad;
      vendidosPorPlato[id].pedidosSet.add(p.id);
    }
  }
  let platoTop = "—";
  let maxVendidos = -1;
  for (const id in vendidosPorPlato) {
    if (vendidosPorPlato[id].vendidos > maxVendidos) {
      maxVendidos = vendidosPorPlato[id].vendidos;
      platoTop = vendidosPorPlato[id].plato;
    }
  }

  return {
    vendedorTop,
    vendedorTopPedidos,
    pedidosTotales: pedidos.length,
    totalVendido,
    platoTop,
    vendidosPorPlato,
  };
}

function disponiblesMap() {
  const stats = computeStats();
  const map = {};
  for (const m of state.menu) {
    const info = stats.vendidosPorPlato[m.id];
    const vendidos = info ? info.vendidos : 0;
    map[m.id] = Math.max(m.stock_inicial - vendidos, 0);
  }
  return map;
}

function itemsTotal(pedido) {
  return (pedido.pedido_items || []).reduce((sum, it) => sum + it.cantidad * Number(it.precio_unit), 0);
}

function rifasTotal(pedido) {
  return Number(pedido.rifas_cantidad || 0) * Number(pedido.rifas_precio || RIFA_PRECIO);
}

function pedidoTotal(pedido) {
  return itemsTotal(pedido) + rifasTotal(pedido);
}

function renderDashboard() {
  const stats = computeStats();
  const grid = $("#stat-grid");
  const fecha = new Date().toLocaleDateString("es-BO", { day: "2-digit", month: "2-digit", year: "numeric" });

  grid.innerHTML = `
    ${statCard("🏅", "Vendedor top", stats.vendedorTop, `${stats.vendedorTopPedidos} pedidos`)}
    ${statCard("🛍️", "Pedidos totales", stats.pedidosTotales, "pedidos")}
    ${statCard("💰", "Total vendido", bs(stats.totalVendido), "en ventas")}
    ${statCard("🏆", "Plato más vendido", stats.platoTop, "el favorito")}
  `;

  const dishGrid = $("#dish-grid");
  dishGrid.innerHTML = state.menu.map((m) => {
    const info = stats.vendidosPorPlato[m.id];
    const vendidos = info ? info.vendidos : 0;
    const pedidosCount = info ? info.pedidosSet.size : 0;
    const disponibles = Math.max(m.stock_inicial - vendidos, 0);
    const pct = m.stock_inicial > 0 ? Math.min(vendidos / m.stock_inicial, 1) : 0;
    return `
      <div class="dish-card" style="--dish-color:${m.color}">
        <div class="dish-head">
          <span class="dish-icon">${m.icono}</span>
          <span class="dish-name">${escapeHtml(m.plato)}</span>
        </div>
        <div class="dish-stats">
          <div>Pedidos<strong>${pedidosCount}</strong></div>
          <div>Vendidos<strong>${vendidos}</strong></div>
          <div>Disponibles<strong>${disponibles}</strong></div>
        </div>
        <div class="dish-bar-wrap">
          <div class="dish-bar-track"><div class="dish-bar-fill" style="width:${pct * 100}%"></div></div>
          <div class="dish-bar-pct">${Math.round(pct * 100)}% vendido</div>
        </div>
      </div>
    `;
  }).join("");
}

function statCard(icon, label, value, sub) {
  return `
    <div class="stat-card">
      <div class="stat-icon">${icon}</div>
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${sub}</div>
    </div>
  `;
}

/* ---------------------------------------------------------
   FORMULARIO: Nuevo pedido
--------------------------------------------------------- */
function renderVendedorSelect() {
  const sel = $("#vendedor-input");
  const seleccionado = sel.value;
  sel.innerHTML = '<option value="">Selecciona un vendedor</option>' +
    state.personas.map((p) => {
      const nombreCompleto = `${p.nombres} ${p.apellidos}`;
      return `<option value="${escapeHtml(nombreCompleto)}">${escapeHtml(nombreCompleto)}</option>`;
    }).join("");
  sel.value = seleccionado;
}

function renderItemsFields() {
  const wrap = $("#items-fields");
  const disp = disponiblesMap();
  wrap.innerHTML = state.menu.map((m) => {
    const disponible = disp[m.id] ?? 0;
    return `
    <div class="item-row" style="--dish-color:${m.color}" data-menu-id="${m.id}" data-disponible="${disponible}">
      <span class="item-icon">${m.icono}</span>
      <div class="item-info">
        <div class="item-name">${escapeHtml(m.plato)}</div>
        <div class="item-price">${bs(m.precio)} c/u · <span class="item-disp">${disponible > 0 ? `Quedan ${disponible}` : "Agotado"}</span></div>
      </div>
      <div class="stepper">
        <button type="button" class="step-minus" aria-label="Restar">−</button>
        <input type="number" min="0" max="${disponible}" value="0" inputmode="numeric" class="qty-input" ${disponible === 0 ? "disabled" : ""}>
        <button type="button" class="step-plus" aria-label="Sumar" ${disponible === 0 ? "disabled" : ""}>+</button>
      </div>
    </div>
  `;
  }).join("") + `
    <div class="item-row raffle-row" data-rifa="true">
      <span class="item-icon">🎟️</span>
      <div class="item-info">
        <div class="item-name">Rifa</div>
        <div class="item-price">${bs(RIFA_PRECIO)} c/u</div>
      </div>
      <div class="stepper">
        <button type="button" class="step-minus" aria-label="Restar rifa">−</button>
        <input type="number" min="0" value="0" inputmode="numeric" class="qty-input raffle-qty">
        <button type="button" class="step-plus" aria-label="Sumar rifa">+</button>
      </div>
    </div>`;

  wrap.querySelectorAll(".item-row").forEach((row) => {
    const input = row.querySelector(".qty-input");
    const plusBtn = row.querySelector(".step-plus");
    const minusBtn = row.querySelector(".step-minus");
    const isRifa = row.dataset.rifa === "true";
    row.classList.toggle("is-sold-out", !isRifa && Number(row.dataset.disponible) === 0);

    plusBtn.addEventListener("click", () => {
      const max = isRifa ? Infinity : Number(row.dataset.disponible);
      const next = Number(input.value || 0) + 1;
      if (next > max) return toast(`Ya no queda más stock (máximo ${max}).`, "error");
      input.value = next;
      updateTotalPreview();
    });
    minusBtn.addEventListener("click", () => {
      input.value = Math.max(0, Number(input.value || 0) - 1);
      updateTotalPreview();
    });
    input.addEventListener("input", () => {
      const max = isRifa ? Infinity : Number(row.dataset.disponible);
      if (Number(input.value) > max) input.value = max;
      if (Number(input.value) < 0 || Number.isNaN(Number(input.value))) input.value = 0;
      updateTotalPreview();
    });
  });
  updateTotalPreview();
}

// Refresca los máximos de stock en el formulario SIN borrar lo que el usuario ya escribió.
function updateDisponibles() {
  const disp = disponiblesMap();
  $all("#items-fields .item-row").forEach((row) => {
    if (row.dataset.rifa === "true") return;
    const menuId = Number(row.dataset.menuId);
    const disponible = disp[menuId] ?? 0;
    row.dataset.disponible = disponible;
    row.classList.toggle("is-sold-out", disponible === 0);

    const input = row.querySelector(".qty-input");
    const plusBtn = row.querySelector(".step-plus");
    const dispLabel = row.querySelector(".item-disp");
    dispLabel.textContent = disponible > 0 ? `Quedan ${disponible}` : "Agotado";
    input.max = disponible;
    input.disabled = disponible === 0;
    plusBtn.disabled = disponible === 0;
    // No reducimos el contador si otro dispositivo consumió stock mientras se llenaba el pedido.
    // El servidor decidirá atómicamente si se puede guardar; ante conflicto se resetean los contadores.
  });
  updateTotalPreview();
}

function currentItems() {
  return $all('#items-fields .item-row:not([data-rifa="true"])').map((row) => {
    const menuId = Number(row.dataset.menuId);
    const cantidad = Number(row.querySelector(".qty-input").value || 0);
    const menuItem = state.menu.find((m) => m.id === menuId);
    return { menuId, cantidad, precio: menuItem ? Number(menuItem.precio) : 0 };
  }).filter((it) => it.cantidad > 0);
}

function currentRifas() {
  return Math.max(0, Number($(".raffle-qty")?.value || 0));
}

function updateTotalPreview() {
  const total = currentItems().reduce((sum, it) => sum + it.cantidad * it.precio, 0) + currentRifas() * RIFA_PRECIO;
  $("#total-preview").textContent = bs(total);
}

function setupForm() {
  $("#comprobante-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    state.comprobanteFile = file || null;
    const preview = $("#comprobante-preview");
    if (file) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }
  });

  $("#metodo-pago-input").addEventListener("change", actualizarMetodoPago);
  actualizarMetodoPago();

  $("#pedido-form").addEventListener("submit", handleSubmit);
}

function actualizarMetodoPago() {
  const esQR = $("#metodo-pago-input").value === "QR";
  $("#pago-qr-field").hidden = !esQR;
}

async function handleSubmit(e) {
  e.preventDefault();
  const msg = $("#form-msg");
  const btn = $("#submit-btn");
  msg.hidden = true;

  const vendedorNombre = $("#vendedor-input").value.trim();
  const clienteNombre = $("#cliente-input").value.trim();
  const items = currentItems();
  const estado = $("#estado-input").value;
  const metodoPago = $("#metodo-pago-input").value;
  const notas = $("#notas-input").value.trim();
  const comprobanteFile = state.comprobanteFile;

  if (!vendedorNombre) return showFormMsg("Selecciona un vendedor.", true);
  if (!clienteNombre) return showFormMsg("Escribe el nombre del cliente.", true);
  const rifasCantidad = currentRifas();
  if (items.length === 0 && rifasCantidad === 0) return showFormMsg("Agrega al menos un plato o compra al menos una rifa.", true);

  const pedidoData = { vendedorNombre, clienteNombre, items, rifasCantidad, estado, metodoPago, notas, comprobanteFile };

  // Sin internet: directo a la cola local, ni siquiera intentamos la red.
  if (!navigator.onLine) {
    await queueOffline(pedidoData);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Guardando...";

  try {
    await submitOrderToSupabase(pedidoData);
    showFormMsg("¡Pedido registrado! 🎉", false);
    resetForm();
    await Promise.all([loadPedidos(), loadPersonas()]);
    renderDashboard();
    renderPedidosList();
    renderVendedorSelect();
  } catch (err) {
    // Si el problema fue de red (no de datos), no perdemos el pedido: lo encolamos.
    if (isNetworkError(err)) {
      await queueOffline(pedidoData);
    } else if (isStockError(err)) {
      resetQuantitiesOnly();
      await loadMenu();
      renderItemsFields();
      showFormMsg(stockErrorMessage(err), true);
    } else {
      showFormMsg("No se pudo guardar: " + err.message, true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Registrar pedido";
  }
}

function isStockError(err) {
  return String(err?.message || err).includes("STOCK_INSUFICIENTE:");
}

function stockErrorMessage(err) {
  const parts = String(err?.message || err).split(":");
  const menuId = Number(parts[1]);
  const disponible = Number(parts[2]);
  const menuItem = state.menu.find((m) => m.id === menuId);
  return `No se guardó el pedido: "${menuItem?.plato || "ese plato"}" solo tiene ${disponible} disponible(s). Se pusieron los contadores en 0 para que vuelvas a elegir.`;
}

function resetQuantitiesOnly() {
  $all("#items-fields .qty-input").forEach((input) => { input.value = 0; });
  updateTotalPreview();
}

function isNetworkError(err) {
  const text = String(err && err.message ? err.message : err).toLowerCase();
  return !navigator.onLine || text.includes("failed to fetch") || text.includes("network");
}

async function queueOffline(pedidoData) {
  await addPending({
    vendedorNombre: pedidoData.vendedorNombre,
    clienteNombre: pedidoData.clienteNombre,
    items: pedidoData.items,
    rifasCantidad: pedidoData.rifasCantidad || 0,
    estado: pedidoData.estado,
    metodoPago: pedidoData.metodoPago,
    notas: pedidoData.notas,
    comprobanteBlob: pedidoData.comprobanteFile || null,
    comprobanteName: pedidoData.comprobanteFile ? pedidoData.comprobanteFile.name : null,
  });
  showFormMsg("📥 Sin conexión: el pedido se guardó en el celular y se enviará solo cuando vuelva internet.", false);
  resetForm();
  await updatePendingBanner();
}

// La misma lógica de guardado, la usan tanto el pedido "en vivo" como la cola offline.
async function submitOrderToSupabase({ vendedorNombre, clienteNombre, items, rifasCantidad = 0, estado, metodoPago, notas, comprobanteFile }) {
  let comprobanteUrl = null;
  if (comprobanteFile) {
    comprobanteUrl = await uploadComprobante(comprobanteFile);
  }

  const { data: result, error } = await supabase.rpc("crear_pedido", {
    p_vendedor_nombre: vendedorNombre,
    p_cliente_nombre: clienteNombre,
    p_estado: estado,
    p_metodo_pago: metodoPago || "Efectivo",
    p_notas: notas || null,
    p_comprobante_url: comprobanteUrl,
    p_rifas_cantidad: rifasCantidad,
    p_rifas_precio: RIFA_PRECIO,
    p_items: items.map((it) => ({
      menu_id: it.menuId,
      cantidad: it.cantidad,
    })),
  });
  if (error) throw error;
  if (!result?.pedido_id) throw new Error("Supabase no devolvió el ID del pedido.");
}

/* ---------------------------------------------------------
   Sincronización de pedidos guardados sin conexión
--------------------------------------------------------- */
async function syncPendingOrders() {
  if (!isConfigured || !navigator.onLine) return;
  const pending = await getAllPending();
  if (pending.length === 0) return;

  toast(`Sincronizando ${pending.length} pedido(s) guardado(s) sin conexión...`, "");
  let sincronizados = 0;
  for (const p of pending) {
    try {
      await submitOrderToSupabase({
        vendedorNombre: p.vendedorNombre,
        clienteNombre: p.clienteNombre,
        items: p.items,
        rifasCantidad: p.rifasCantidad || 0,
        estado: p.estado,
        metodoPago: p.metodoPago,
        notas: p.notas,
        comprobanteFile: p.comprobanteBlob || null,
      });
      await deletePending(p.id);
      sincronizados++;
    } catch (err) {
      // Sigue sin conexión de verdad, o falló por otra razón: lo dejamos para el próximo intento.
      break;
    }
  }
  if (sincronizados > 0) {
    toast(`✅ ${sincronizados} pedido(s) sincronizado(s) con éxito.`, "ok");
    await Promise.all([loadPedidos(), loadPersonas()]);
    renderDashboard();
    renderPedidosList();
    renderVendedorSelect();
  }
  await updatePendingBanner();
}

async function updatePendingBanner() {
  const banner = $("#pending-banner");
  if (!banner) return;
  const pending = await getAllPending();
  if (pending.length === 0) {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    banner.textContent = `🕓 ${pending.length} pedido(s) guardado(s) en este celular, esperando internet para enviarse.`;
  }
}

async function uploadComprobante(file) {
  const ext = (file.name && file.name.includes(".")) ? file.name.split(".").pop() : "jpg";
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage.from(COMPROBANTES_BUCKET).upload(path, file, { upsert: false });
  if (error) throw new Error("No se pudo subir el comprobante: " + error.message);
  const { data } = supabase.storage.from(COMPROBANTES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function resetForm() {
  $("#pedido-form").reset();
  $("#vendedor-input").value = "";
  actualizarMetodoPago();
  state.comprobanteFile = null;
  const preview = $("#comprobante-preview");
  preview.hidden = true;
  preview.src = "";
  renderItemsFields();
}

function showFormMsg(text, isError) {
  const msg = $("#form-msg");
  msg.textContent = text;
  msg.hidden = false;
  msg.className = "form-msg " + (isError ? "is-error" : "is-ok");
}

/* ---------------------------------------------------------
   LISTA DE PEDIDOS
--------------------------------------------------------- */
function setupPedidosFilters() {
  $all(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.filtro = chip.dataset.filter;
      $all(".chip").forEach((c) => c.classList.toggle("is-active", c === chip));
      renderPedidosList();
    });
  });

  let searchTimer = null;
  $("#search-cliente").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      state.busqueda = value.trim().toLowerCase();
      renderPedidosList();
    }, 200);
  });
}

function renderPedidosList() {
  const list = $("#pedidos-list");
  const filtrados = state.pedidos.filter((p) => {
    const pasaEstado = state.filtro === "Todos" || p.estado === state.filtro;
    const pasaBusqueda = !state.busqueda
      || p.cliente_nombre?.toLowerCase().includes(state.busqueda)
      || p.vendedor_nombre?.toLowerCase().includes(state.busqueda);
    return pasaEstado && pasaBusqueda;
  });
  $("#pedidos-empty").hidden = filtrados.length > 0;
  $("#pedidos-empty").textContent = state.busqueda
    ? `No hay pedidos de "${$("#search-cliente").value}".`
    : "Todavía no hay pedidos registrados.";

  list.innerHTML = filtrados.map((p) => {
    const partes = (p.pedido_items || [])
      .map((it) => `${it.cantidad}x <span>${escapeHtml(it.menu ? it.menu.plato : "?")}</span>`);
    if (Number(p.rifas_cantidad || 0) > 0) partes.push(`${p.rifas_cantidad}x <span>Rifa</span>`);
    const itemsTxt = partes.join(" · ") || "Sin productos";
    const fecha = new Date(p.created_at).toLocaleString("es-BO", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const thumb = p.comprobante_url
      ? `<img class="receipt-thumb" src="${p.comprobante_url}" data-full="${p.comprobante_url}" alt="Comprobante">`
      : "";
    return `
      <div class="pedido-card">
        <div class="pedido-top">
          <div>
            <div class="pedido-cliente">${escapeHtml(p.cliente_nombre || "Sin nombre de cliente")}</div>
            <div class="pedido-vendedor">Vendedor: ${escapeHtml(p.vendedor_nombre || "—")}</div>
            <div class="pedido-fecha">${fecha}</div>
          </div>
          <div class="pedido-total">${bs(pedidoTotal(p))}</div>
        </div>
        <div class="pedido-items">${itemsTxt}</div>
        <div class="pedido-bottom">
          <select class="status-select" data-estado="${p.estado}" data-id="${p.id}">
            <option value="Pendiente" ${p.estado === "Pendiente" ? "selected" : ""}>Pendiente</option>
            <option value="Pagado" ${p.estado === "Pagado" ? "selected" : ""}>Pagado</option>
            <option value="No Pagado" ${p.estado === "No Pagado" ? "selected" : ""}>No pagado</option>
          </select>
          ${thumb}
        </div>
        ${p.notas ? `<div class="pedido-notas">${escapeHtml(p.notas)}</div>` : ""}
      </div>
    `;
  }).join("");

  list.querySelectorAll(".status-select").forEach((sel) => {
    sel.className = "status-select " + sel.value.replace(" ", "-");
    sel.addEventListener("change", async () => {
      const id = Number(sel.dataset.id);
      const nuevoEstado = sel.value;
      const { error } = await supabase.from("pedidos").update({ estado: nuevoEstado }).eq("id", id);
      if (error) return toast("No se pudo actualizar el estado: " + error.message, "error");
      const pedido = state.pedidos.find((p) => p.id === id);
      if (pedido) pedido.estado = nuevoEstado;
      sel.className = "status-select " + nuevoEstado.replace(" ", "-");
      toast("Estado actualizado", "ok");
    });
  });

  list.querySelectorAll(".receipt-thumb").forEach((img) => {
    img.addEventListener("click", () => openImageModal(img.dataset.full));
  });
}

/* ---------------------------------------------------------
   EDITOR DE MENÚ (stock)
--------------------------------------------------------- */
function renderMenuEditor() {
  const wrap = $("#menu-editor");
  wrap.innerHTML = state.menu.map((m) => `
    <div class="menu-row" style="--dish-color:${m.color}">
      <span class="menu-icon">${m.icono}</span>
      <div class="menu-info">
        <div class="menu-name">${escapeHtml(m.plato)}</div>
        <div class="menu-price">${bs(m.precio)} c/u</div>
      </div>
      <input type="number" min="0" class="stock-input" value="${m.stock_inicial}" data-id="${m.id}">
    </div>
  `).join("");

  wrap.querySelectorAll(".stock-input").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = Number(input.dataset.id);
      const nuevoStock = Number(input.value || 0);
      const { error } = await supabase.from("menu").update({ stock_inicial: nuevoStock }).eq("id", id);
      if (error) return toast("No se pudo actualizar el stock: " + error.message, "error");
      const item = state.menu.find((m) => m.id === id);
      if (item) item.stock_inicial = nuevoStock;
      renderDashboard();
      toast("Stock actualizado", "ok");
    });
  });
}

/* ---------------------------------------------------------
   IMAGE MODAL
--------------------------------------------------------- */
function setupImageModal() {
  $("#image-modal-close").addEventListener("click", closeImageModal);
  $("#image-modal").addEventListener("click", (e) => {
    if (e.target.id === "image-modal") closeImageModal();
  });
}
function openImageModal(url) {
  $("#image-modal-img").src = url;
  $("#image-modal").hidden = false;
}
function closeImageModal() {
  $("#image-modal").hidden = true;
  $("#image-modal-img").src = "";
}

/* ---------------------------------------------------------
   TOAST
--------------------------------------------------------- */
let toastTimer = null;
function toast(text, type = "") {
  const el = $("#toast");
  el.textContent = text;
  el.className = "toast" + (type === "error" ? " is-error" : type === "ok" ? " is-ok" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------------------------------------------------------
   Service worker (PWA)
--------------------------------------------------------- */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      // Revisa si hay una versión nueva cada vez que la app vuelve a primer plano.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update();
      });
      reg.update();
    }).catch(() => {});
  });

  // En cuanto la versión nueva del service worker toma el control,
  // recarga la página sola (así los cambios se ven sin que nadie
  // tenga que hacer Ctrl+Shift+R).
  let yaRecargando = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (yaRecargando) return;
    yaRecargando = true;
    window.location.reload();
  });
}

/* ---------------------------------------------------------
   Utils
--------------------------------------------------------- */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

init();
