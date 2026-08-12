# Kermesse 2026 — Pedidos (PWA)

App web instalable (PWA) para registrar pedidos de la kermesse en vivo, con
Supabase como base de datos y almacenamiento de comprobantes de pago.

No tiene login: cualquiera con el link puede registrar pedidos y ver el
dashboard. Los datos se actualizan solos en todos los celulares conectados
(tiempo real de Supabase).

## 1. Crear el backend en Supabase

1. Crea una cuenta gratis en https://supabase.com y un proyecto nuevo.
2. Ve a **SQL Editor**, pega todo el contenido de `supabase/schema.sql` y
   dale **Run**. Esto crea las tablas `menu`, `personas`, `pedidos`,
   `pedido_items`, las políticas de seguridad (abiertas, sin login) y carga
   el menú y las personas que ya tenías en el Excel.
3. Ve a **Storage** → **New bucket** → llámalo `comprobantes` → márcalo
   como **Public bucket**. Ahí se guardan las fotos de los comprobantes de
   pago.
4. Ve a **Database → Replication** y activa la replicación en tiempo real
   para las tablas `pedidos`, `pedido_items` y `menu` (el script SQL ya
   intenta activarlo solo; si da error, actívalo manualmente ahí).
5. Ve a **Project Settings → API** y copia:
   - **Project URL**
   - **anon public key**

## 2. Conectar la app a tu Supabase

Las claves de Supabase **ya no se escriben directo en el código** (así no
quedan visibles en GitHub). Se guardan como "Environment Variables" y un
pequeño script (`build.js`) arma el archivo real `js/config.js` con ellas
al momento de desplegar.

**En Vercel:**
1. Project Settings → Environment Variables.
2. Agrega `SUPABASE_URL` y `SUPABASE_ANON_KEY` con los valores que
   copiaste de tu proyecto de Supabase.
3. Vercel ya sabe correr `node build.js` antes de publicar (está en
   `vercel.json`), así que no tienes que hacer nada más — cada deploy
   genera `js/config.js` solo.

> Aun así, esa key va a quedar visible si alguien abre F12 en la app ya
> publicada — es inevitable, porque el navegador necesita esa key para
> hablar con Supabase. Lo que la protege de verdad son las políticas RLS
> de `schema.sql`, no que esté escondida. Lo que sí logramos es que no
> quede pegada en tu código fuente / repo de GitHub.

## 3. Probarla en tu computadora

El proyecto incluye un `js/config.js` seguro con placeholders para evitar un 404 si abres la app antes de generar la configuración. Para conectarla a Supabase, sigue estos pasos:

1. Copia `.env.example` a un archivo nuevo llamado `.env` y pon ahí tus
   valores reales de Supabase.
2. Genera el config real:
   ```bash
   cd kermesse-pwa
   node build.js
   ```
   Esto crea `js/config.js` (ese sí con tus claves — nunca se sube a git,
   ya está en `.gitignore`).
3. Levanta un servidor simple (los navegadores bloquean los `import` de
   JavaScript si abres `index.html` con doble clic):
   ```bash
   python3 -m http.server 8080
   ```
   Y abre `http://localhost:8080`.

Si alguna vez cambias tus claves de Supabase, vuelve a correr
`node build.js` para regenerar `js/config.js`.

## 4. Publicarla en internet (para usarla el día de la kermesse)

Cualquier hosting de archivos estáticos funciona. Las más fáciles y
gratis:

- **Netlify**: arrastra la carpeta `kermesse-pwa` a https://app.netlify.com/drop
- **Vercel**: `vercel deploy` desde la carpeta del proyecto
- **GitHub Pages**: sube la carpeta a un repo y activa Pages

Una vez publicada, comparte el link — cualquiera que lo abra desde su
celular puede tocar "Agregar a pantalla de inicio" (Android/Chrome) o
"Compartir → Añadir a pantalla de inicio" (iPhone/Safari) y les queda como
una app normal, con ícono y sin la barra del navegador.

## 5. Estructura del proyecto

```
kermesse-pwa/
├── index.html          → las 4 pantallas: Dashboard, Nuevo pedido, Pedidos, Menú
├── manifest.webmanifest → hace que sea instalable como app
├── service-worker.js    → cachea la app para que abra rápido y funcione offline
├── build.js              → genera js/config.js con tus claves reales (ver sección 2 y 3)
├── vercel.json           → le dice a Vercel que corra build.js y no cachee los archivos
├── _headers              → lo mismo que vercel.json pero para Netlify
├── .env.example          → copia esto a ".env" para probar local
├── css/styles.css
├── js/
│   ├── config.template.js → plantilla SIN datos reales (esta sí se sube a git)
│   ├── config.js          → (lo genera build.js — nunca se sube a git)
│   ├── supabaseClient.js
│   ├── offlineQueue.js    → guarda pedidos en el celular cuando no hay internet
│   └── app.js              → toda la lógica de la app
├── icons/                → íconos de la app
└── supabase/schema.sql   → el script que crea toda la base de datos
```

## 6. Cómo funciona por dentro

- **Dashboard**: se calcula en el momento a partir de los pedidos y el
  menú — no hay números guardados aparte, así que nunca se desincroniza.
- **Nuevo pedido**: un pedido = una persona. Se eligen cantidades por cada
  plato con los botones + / −, se puede adjuntar foto del comprobante de
  pago (se sube al bucket `comprobantes`), y el total se calcula solo.
- **Pedidos**: lista todos los pedidos, con filtro por estado. El estado
  (Pagado / Pendiente / No pagado) se cambia ahí mismo con un desplegable.
- **Menú**: para ajustar el stock inicial de cada plato (lo demás,
  vendidos/disponibles/%, se calcula solo).
- Todo se actualiza **en tiempo real**: si dos personas tienen la app
  abierta en dos celulares distintos, ambas ven los pedidos nuevos sin
  recargar la página.

## 7. Cosas a ajustar si quieres

- **Cambiar precios o agregar un plato nuevo**: se hace directo en la
  tabla `menu` de Supabase (Table Editor), agregando fila con su color e
  ícono (emoji).
- **Restringir quién puede editar**: ahora mismo cualquiera puede escribir
  en todas las tablas. Si luego quieres que solo el organizador edite, se
  ajusta en las políticas de `schema.sql` (por ejemplo agregando una clave
  simple o un login de Supabase Auth).

## 8. Actualizar la app después de hacer cambios

Ya no hace falta pedirle a nadie que haga Ctrl+Shift+R: la app revisa
sola si hay una versión nueva (cuando la abres y cada vez que vuelves a
ella) y se recarga sola cuando la encuentra. Para que esto funcione bien
en Vercel/Netlify, el proyecto ya incluye `vercel.json` y `_headers`, que
le dicen al hosting que nunca guarde estos archivos en caché sin
revisar primero si cambiaron — sin eso, el navegador podía quedarse
viendo una copia vieja aunque tú ya hubieras subido la nueva.

Aun así, cada vez que subas cambios nuevos, **sube en 1 el número de
`CACHE_VERSION`** dentro de `service-worker.js` (ahora mismo está en
`"v3"`, la próxima sería `"v4"`). Es la señal que usa el navegador para
darse cuenta de que hay algo nuevo que instalar.

## 9. Cómo funciona el modo sin conexión

- El "cascarón" de la app (las pantallas, los botones) queda guardado en
  el celular después de la primera vez que se abre con internet, así que
  siempre abre aunque no haya señal.
- Si registras un pedido **sin internet**, no se pierde: se guarda en el
  celular (en una cola local) y en cuanto vuelve la señal se envía solo a
  Supabase — vas a ver un aviso arriba de "🕓 X pedido(s) esperando
  internet" mientras tanto.
- El Dashboard y la lista de Pedidos muestran los últimos datos que se
  alcanzaron a descargar la última vez que hubo internet; no se
  actualizan mientras estás sin conexión (eso sí necesita hablar con
  Supabase).

