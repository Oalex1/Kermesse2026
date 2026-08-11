import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getSecretKey() {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (parsed.default) return parsed.default;
    } catch (_) {}
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 8) return `591${digits}`;
  return digits;
}

function base64ToUint8Array(base64: string) {
  const clean = base64.includes(",") ? base64.split(",").pop()! : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sendEmail({
  apiKey,
  from,
  to,
  customer,
  orderId,
  total,
  pdfBase64,
  filename,
}: {
  apiKey: string;
  from: string;
  to: string;
  customer: string;
  orderId: number;
  total: number;
  pdfBase64: string;
  filename: string;
}) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Ticket Kermesse 2026 #${orderId}`,
      html: `<p>Hola <strong>${customer.replace(/[<>]/g, "")}</strong>,</p><p>Tu pedido de la Kermesse 2026 fue registrado correctamente.</p><p><strong>Total: Bs ${Math.round(total)}</strong></p><p>Adjuntamos tu ticket electrónico. El código QR del ticket es de un solo uso.</p>`,
      attachments: [{ filename, content: pdfBase64 }],
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || `Resend HTTP ${response.status}`);
  return body;
}

async function uploadWhatsAppMedia({
  version,
  phoneNumberId,
  accessToken,
  pdfBytes,
  filename,
}: {
  version: string;
  phoneNumberId: string;
  accessToken: string;
  pdfBytes: Uint8Array;
  filename: string;
}) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), filename);

  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.id) throw new Error(body?.error?.message || `WhatsApp media HTTP ${response.status}`);
  return body.id as string;
}

async function sendWhatsApp({
  version,
  phoneNumberId,
  accessToken,
  to,
  mediaId,
  filename,
  customer,
  orderId,
  total,
  templateName,
  templateLanguage,
}: {
  version: string;
  phoneNumberId: string;
  accessToken: string;
  to: string;
  mediaId: string;
  filename: string;
  customer: string;
  orderId: number;
  total: number;
  templateName?: string;
  templateLanguage?: string;
}) {
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  let payload: Record<string, unknown>;

  if (templateName) {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage || "es" },
        components: [
          {
            type: "header",
            parameters: [
              {
                type: "document",
                document: { id: mediaId, filename },
              },
            ],
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: customer },
              { type: "text", text: String(orderId) },
              { type: "text", text: `Bs ${Math.round(total)}` },
            ],
          },
        ],
      },
    };
  } else {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: {
        id: mediaId,
        caption: `Hola ${customer}. Tu ticket Kermesse 2026 #${orderId}. Total: Bs ${Math.round(total)}.`,
        filename,
      },
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `WhatsApp HTTP ${response.status}`);
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Método no permitido" }, 405);

  try {
    const body = await req.json();
    const pedidoId = Number(body?.pedido_id);
    const token = String(body?.ticket_token || "");
    const pdfBase64 = String(body?.pdf_base64 || "");

    if (!pedidoId || !token || !pdfBase64) return json({ ok: false, error: "Faltan pedido_id, ticket_token o PDF." }, 400);
    if (pdfBase64.length > 12_000_000) return json({ ok: false, error: "El PDF es demasiado grande." }, 413);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const secretKey = getSecretKey();
    if (!secretKey) return json({ ok: false, error: "Falta configurar la clave secreta de Supabase." }, 500);

    const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false } });

    const { data: pedido, error: pedidoError } = await admin
      .from("pedidos")
      .select("id, cliente_nombre, whatsapp, email, ticket_token, rifas_cantidad, rifas_precio")
      .eq("id", pedidoId)
      .eq("ticket_token", token)
      .maybeSingle();

    if (pedidoError) throw pedidoError;
    if (!pedido) return json({ ok: false, error: "El ticket no es válido." }, 404);

    const { data: items, error: itemsError } = await admin
      .from("pedido_items")
      .select("cantidad, precio_unit")
      .eq("pedido_id", pedidoId);
    if (itemsError) throw itemsError;

    const total = (items || []).reduce((sum, item) => sum + Number(item.cantidad) * Number(item.precio_unit), 0)
      + Number(pedido.rifas_cantidad || 0) * Number(pedido.rifas_precio || 20);

    const filename = `ticket-kermesse-2026-${pedidoId}.pdf`;
    const results: Record<string, unknown> = { email: null, whatsapp: null };
    const errors: string[] = [];

    const emailKey = Deno.env.get("RESEND_API_KEY");
    const emailFrom = Deno.env.get("RESEND_FROM");
    if (pedido.email) {
      if (!emailKey || !emailFrom) {
        errors.push("Correo: falta RESEND_API_KEY o RESEND_FROM");
      } else {
        try {
          const result = await sendEmail({
            apiKey: emailKey,
            from: emailFrom,
            to: pedido.email,
            customer: pedido.cliente_nombre,
            orderId: pedido.id,
            total,
            pdfBase64: pdfBase64.includes(",") ? pdfBase64.split(",").pop()! : pdfBase64,
            filename,
          });
          results.email = { ok: true, id: result?.id || null };
          await admin.from("pedidos").update({ email_enviado_at: new Date().toISOString() }).eq("id", pedidoId);
        } catch (err) {
          errors.push(`Correo: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (pedido.whatsapp) {
      const waToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
      const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
      const version = Deno.env.get("WHATSAPP_API_VERSION") || "v23.0";
      if (!waToken || !phoneNumberId) {
        errors.push("WhatsApp: falta WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID");
      } else {
        try {
          const to = normalizePhone(pedido.whatsapp);
          if (!to) throw new Error("El número de WhatsApp no contiene dígitos válidos.");
          const mediaId = await uploadWhatsAppMedia({
            version,
            phoneNumberId,
            accessToken: waToken,
            pdfBytes: base64ToUint8Array(pdfBase64),
            filename,
          });
          const waResult = await sendWhatsApp({
            version,
            phoneNumberId,
            accessToken: waToken,
            to,
            mediaId,
            filename,
            customer: pedido.cliente_nombre,
            orderId: pedido.id,
            total,
            templateName: Deno.env.get("WHATSAPP_TEMPLATE_NAME") || undefined,
            templateLanguage: Deno.env.get("WHATSAPP_TEMPLATE_LANGUAGE") || "es",
          });
          results.whatsapp = { ok: true, id: waResult?.messages?.[0]?.id || null };
          await admin.from("pedidos").update({ whatsapp_enviado_at: new Date().toISOString() }).eq("id", pedidoId);
        } catch (err) {
          errors.push(`WhatsApp: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (errors.length) {
      await admin.from("pedidos").update({ notificacion_error: errors.join(" | ") }).eq("id", pedidoId);
    } else {
      await admin.from("pedidos").update({ notificacion_error: null }).eq("id", pedidoId);
    }

    return json({ ok: errors.length === 0, pedido_id: pedidoId, results, errors });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
