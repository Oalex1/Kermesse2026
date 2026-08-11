# Ticket automático por correo y WhatsApp

## 1. Base de datos
Ejecuta una sola vez en Supabase SQL Editor:

`supabase/migration_kermesse_tickets_rifas.sql`

## 2. Resend
Crea una cuenta en Resend, crea/verifica el dominio desde el que enviarás y genera una API key.

Secretos de Supabase Edge Functions:

- `RESEND_API_KEY` = tu clave `re_...`
- `RESEND_FROM` = por ejemplo `Kermesse 2026 <tickets@tudominio.com>`

## 3. WhatsApp Cloud API
Configura WhatsApp Business Platform en Meta y consigue:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`

Opcional/recomendado para mensajes iniciados por la empresa:

- `WHATSAPP_TEMPLATE_NAME` = nombre exacto de una plantilla aprobada
- `WHATSAPP_TEMPLATE_LANGUAGE` = idioma exacto de la plantilla, por ejemplo `es`

La plantilla debe tener:

- Header: DOCUMENT
- Body: tres variables, en este orden: cliente, número de pedido, total

Ejemplo de texto del body:

`Hola {{1}}, tu pedido #{{2}} de la Kermesse 2026 fue registrado. Total: {{3}}. Adjuntamos tu ticket electrónico.`

## 4. Secrets
No pongas estas claves en `js/config.js`, React, HTML ni GitHub.

Con Supabase CLI:

```powershell
npx supabase secrets set RESEND_API_KEY="re_xxx" --project-ref TU_PROJECT_REF
npx supabase secrets set RESEND_FROM="Kermesse 2026 <tickets@tudominio.com>" --project-ref TU_PROJECT_REF
npx supabase secrets set WHATSAPP_ACCESS_TOKEN="EAAB..." --project-ref TU_PROJECT_REF
npx supabase secrets set WHATSAPP_PHONE_NUMBER_ID="123456789" --project-ref TU_PROJECT_REF
npx supabase secrets set WHATSAPP_API_VERSION="v23.0" --project-ref TU_PROJECT_REF
npx supabase secrets set WHATSAPP_TEMPLATE_NAME="ticket_kermesse" --project-ref TU_PROJECT_REF
npx supabase secrets set WHATSAPP_TEMPLATE_LANGUAGE="es" --project-ref TU_PROJECT_REF
```

## 5. Deploy
Desde la raíz del proyecto:

```powershell
npx supabase login
npx supabase link --project-ref TU_PROJECT_REF
npx supabase functions deploy enviar-ticket --project-ref TU_PROJECT_REF
```

## 6. Prueba
Registra un pedido con solo correo, solo WhatsApp o ambos.

- Sin contacto: el pedido se guarda y no se envía nada.
- Correo: recibe el PDF adjunto.
- WhatsApp: recibe el PDF por la API de WhatsApp.
- Ambos: recibe por ambos canales.

Si falla un canal, el pedido NO se pierde. El error queda en `pedidos.notificacion_error` y el canal que sí funcionó queda marcado con `email_enviado_at` o `whatsapp_enviado_at`.
