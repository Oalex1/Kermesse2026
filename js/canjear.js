import { supabase, isConfigured } from "./supabaseClient.js";

const bs = (n) => `Bs ${Math.round(n).toLocaleString("es-BO")}`;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const card = document.getElementById("canje-card");

function render(icono, claseTitulo, titulo, bodyHtml) {
  card.innerHTML = `
    <div class="canje-icono">${icono}</div>
    <h1 class="canje-titulo ${claseTitulo}">${titulo}</h1>
    <div class="canje-body">${bodyHtml}</div>
  `;
}

function detalleHtml(data) {
  const items = (data.items || []).map((it) => `<li>${it.cantidad}x ${escapeHtml(it.plato)}</li>`);
  if (Number(data.rifas_cantidad || 0) > 0) items.push(`<li>${data.rifas_cantidad}x Rifa</li>`);
  return `
    <p><strong>Cliente:</strong> ${escapeHtml(data.cliente_nombre || "—")}</p>
    <p><strong>Vendedor:</strong> ${escapeHtml(data.vendedor_nombre || "—")}</p>
    <ul class="canje-items">${items.join("") || "<li>Sin productos</li>"}</ul>
    <p class="canje-total"><strong>Total: ${bs(data.total || 0)}</strong></p>
  `;
}

async function run() {
  if (!isConfigured) {
    return render("⚙️", "bad", "Falta configurar Supabase", "<p>Revisa js/config.js</p>");
  }

  const token = new URLSearchParams(location.search).get("token");
  if (!token) {
    return render("❌", "bad", "Link inválido", "<p>Falta el código del ticket.</p>");
  }

  const { data, error } = await supabase.rpc("entregar_pedido", { p_token: token });

  if (error) {
    return render("❌", "bad", "Error al canjear", `<p>${escapeHtml(error.message)}</p>`);
  }

  if (data.reason === "NO_EXISTE") {
    return render("❌", "bad", "Ticket no válido", "<p>Este código no corresponde a ningún pedido.</p>");
  }

  if (data.reason === "YA_ENTREGADO") {
    const fecha = data.entregado_at ? new Date(data.entregado_at).toLocaleString("es-BO") : "";
    return render("⚠️", "warn", "Ya fue entregado antes", detalleHtml(data) + `<p style="opacity:.7">Entregado: ${fecha}</p>`);
  }

  render("✅", "ok", "Entregado con éxito", detalleHtml(data));
}

run();
