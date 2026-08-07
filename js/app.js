import { supabase, isConfigured } from "./supabaseClient.js";
import { COMPROBANTES_BUCKET } from "./config.js";

/* ---------------------------------------------------------
   Helpers cortos
--------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));
const bs = (n) => `Bs ${Math.round(n).toLocaleString("es-BO")}`;

/* ---------------------------------------------------------
   Estado en memoria
--------------------------------------------------------- */
const state = {
  menu: [],       // [{id, plato, precio, stock_inicial, color, icono, orden}]
  personas: [],   // [{id, nombres, apellidos}]
  pedidos: [],    // [{id, cliente_nombre, estado, notas, comprobante_url, created_at, pedido_items:[{cantidad, precio_unit, menu:{...}}]}]
  filtro: "Todos",
  comprobanteFile: null,
};

/* ---------------------------------------------------------
   Arranque
--------------------------------------------------------- */
async function init() {
  setupTabs();
  setupOnlineBanner();
  registerServiceWorker();

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
}

/* ---------------------------------------------------------
   Tabs
--------------------------------------------------------- */
function setupTabs() {
  $all(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}
function switchTab(name) {
  $all(".tab").forEach((s) => s.classList.toggle("is-active", s.id === `tab-${name}`));
  $all(".tab-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
}

/* ---------------------------------------------------------
   Banner de conexión
--------------------------------------------------------- */
function setupOnlineBanner() {
  const banner = $("#offline-banner");
  const update = () => { banner.hidden = navigator.onLine; };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

/* ---------------------------------------------------------
   Carga de datos
--------------------------------------------------------- */
async function loadMenu() {
  const { data, error } = await supabase
    .from("menu")
    .select("id, plato, precio, stock_inicial, color, icono, orden")
    .order("orden", { ascending: true });
  if (error) return toast("No se pudo cargar el menú: " + error.message, "error");
  state.menu = data || [];
}

async function loadPersonas() {
  const { data, error } = await supabase
    .from("personas")
    .select("id, nombres, apellidos")
    .order("nombres", { ascending: true });
  if (error) return toast("No se pudo cargar personas: " + error.message, "error");
  state.personas = data || [];
}

async function loadPedidos() {
  const { data, error } = await supabase
    .from("pedidos")
    .select(`
      id, cliente_nombre, estado, notas, comprobante_url, created_at,
      pedido_items ( cantidad, precio_unit, menu ( id, plato, icono, color ) )
    `)
    .order("created_at", { ascending: false });
  if (error) return toast("No se pudo cargar pedidos: " + error.message, "error");
  state.pedidos = data || [];
}

function renderAll() {
  renderDashboard();
  renderPersonasDatalist();
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
    $("#last-update").textContent = "Actualizado ahora mismo";
  }, 400);
}

/* ---------------------------------------------------------
   DASHBOARD
--------------------------------------------------------- */
function computeStats() {
  const pedidos = state.pedidos;
  const clientes = new Set(pedidos.map((p) => p.cliente_nombre.trim().toLowerCase()));
  const totalVendido = pedidos.reduce((sum, p) => sum + itemsTotal(p), 0);

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
    personasAtendidas: clientes.size,
    pedidosTotales: pedidos.length,
    totalVendido,
    platoTop,
    vendidosPorPlato,
  };
}

function itemsTotal(pedido) {
  return (pedido.pedido_items || []).reduce((sum, it) => sum + it.cantidad * Number(it.precio_unit), 0);
}

function renderDashboard() {
  const stats = computeStats();
  const grid = $("#stat-grid");
  const fecha = new Date().toLocaleDateString("es-BO", { day: "2-digit", month: "2-digit", year: "numeric" });

  grid.innerHTML = `
    ${statCard("👥", "Personas atendidas", stats.personasAtendidas, "clientes")}
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
function renderPersonasDatalist() {
  $("#personas-list").innerHTML = state.personas
    .map((p) => `<option value="${escapeHtml(p.nombres + " " + p.apellidos)}">`)
    .join("");
}

function renderItemsFields() {
  const wrap = $("#items-fields");
  wrap.innerHTML = state.menu.map((m) => `
    <div class="item-row" style="--dish-color:${m.color}" data-menu-id="${m.id}">
      <span class="item-icon">${m.icono}</span>
      <div class="item-info">
        <div class="item-name">${escapeHtml(m.plato)}</div>
        <div class="item-price">${bs(m.precio)} c/u</div>
      </div>
      <div class="stepper">
        <button type="button" class="step-minus" aria-label="Restar">−</button>
        <input type="number" min="0" value="0" inputmode="numeric" class="qty-input">
        <button type="button" class="step-plus" aria-label="Sumar">+</button>
      </div>
    </div>
  `).join("");

  wrap.querySelectorAll(".item-row").forEach((row) => {
    const input = row.querySelector(".qty-input");
    row.querySelector(".step-plus").addEventListener("click", () => {
      input.value = Math.max(0, Number(input.value || 0) + 1);
      updateTotalPreview();
    });
    row.querySelector(".step-minus").addEventListener("click", () => {
      input.value = Math.max(0, Number(input.value || 0) - 1);
      updateTotalPreview();
    });
    input.addEventListener("input", updateTotalPreview);
  });
  updateTotalPreview();
}

function currentItems() {
  return $all("#items-fields .item-row").map((row) => {
    const menuId = Number(row.dataset.menuId);
    const cantidad = Number(row.querySelector(".qty-input").value || 0);
    const menuItem = state.menu.find((m) => m.id === menuId);
    return { menuId, cantidad, precio: menuItem ? Number(menuItem.precio) : 0 };
  }).filter((it) => it.cantidad > 0);
}

function updateTotalPreview() {
  const total = currentItems().reduce((sum, it) => sum + it.cantidad * it.precio, 0);
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

  $("#pedido-form").addEventListener("submit", handleSubmit);
}

async function handleSubmit(e) {
  e.preventDefault();
  const msg = $("#form-msg");
  const btn = $("#submit-btn");
  msg.hidden = true;

  const clienteNombre = $("#cliente-input").value.trim();
  const items = currentItems();
  const estado = $("#estado-input").value;
  const notas = $("#notas-input").value.trim();

  if (!clienteNombre) return showFormMsg("Escribe el nombre del cliente.", true);
  if (items.length === 0) return showFormMsg("Agrega al menos un plato con cantidad mayor a 0.", true);

  btn.disabled = true;
  btn.textContent = "Guardando...";

  try {
    let comprobanteUrl = null;
    if (state.comprobanteFile) {
      comprobanteUrl = await uploadComprobante(state.comprobanteFile);
    }

    const { data: pedido, error: errPedido } = await supabase
      .from("pedidos")
      .insert({ cliente_nombre: clienteNombre, estado, notas: notas || null, comprobante_url: comprobanteUrl })
      .select()
      .single();
    if (errPedido) throw errPedido;

    const rows = items.map((it) => ({
      pedido_id: pedido.id,
      menu_id: it.menuId,
      cantidad: it.cantidad,
      precio_unit: it.precio,
    }));
    const { error: errItems } = await supabase.from("pedido_items").insert(rows);
    if (errItems) throw errItems;

    // asegurar que el nombre quede disponible para autocompletar la próxima vez
    await ensurePersonaExists(clienteNombre);

    showFormMsg("¡Pedido registrado! 🎉", false);
    resetForm();
    await Promise.all([loadPedidos(), loadPersonas()]);
    renderDashboard();
    renderPedidosList();
    renderPersonasDatalist();
  } catch (err) {
    showFormMsg("No se pudo guardar: " + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Registrar pedido";
  }
}

async function ensurePersonaExists(nombreCompleto) {
  const existe = state.personas.some(
    (p) => `${p.nombres} ${p.apellidos}`.trim().toLowerCase() === nombreCompleto.toLowerCase()
  );
  if (existe) return;
  const [nombres, ...resto] = nombreCompleto.split(" ");
  await supabase.from("personas").insert({ nombres, apellidos: resto.join(" ") || "-" });
}

async function uploadComprobante(file) {
  const ext = file.name.split(".").pop();
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage.from(COMPROBANTES_BUCKET).upload(path, file, { upsert: false });
  if (error) throw new Error("No se pudo subir el comprobante: " + error.message);
  const { data } = supabase.storage.from(COMPROBANTES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function resetForm() {
  $("#pedido-form").reset();
  state.comprobanteFile = null;
  $("#comprobante-preview").hidden = true;
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
}

function renderPedidosList() {
  const list = $("#pedidos-list");
  const filtrados = state.pedidos.filter((p) => state.filtro === "Todos" || p.estado === state.filtro);
  $("#pedidos-empty").hidden = filtrados.length > 0;

  list.innerHTML = filtrados.map((p) => {
    const itemsTxt = (p.pedido_items || [])
      .map((it) => `${it.cantidad}x <span>${escapeHtml(it.menu ? it.menu.plato : "?")}</span>`)
      .join(" · ") || "Sin platos";
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
            <div class="pedido-cliente">${escapeHtml(p.cliente_nombre)}</div>
            <div class="pedido-fecha">${fecha}</div>
          </div>
          <div class="pedido-total">${bs(itemsTotal(p))}</div>
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
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
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
