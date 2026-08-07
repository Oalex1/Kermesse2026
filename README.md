# Kermesse 2024 — Pedidos (PWA)

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

Abre `js/config.js` y reemplaza:

```js
export const SUPABASE_URL = "PEGA_AQUI_TU_SUPABASE_URL";
export const SUPABASE_ANON_KEY = "PEGA_AQUI_TU_SUPABASE_ANON_KEY";
```

con los valores que copiaste. Guarda el archivo.

> Como la app no tiene login, la anon key queda visible en el navegador de
> cualquiera que la use — eso es normal y esperado en este modelo (las
> políticas de seguridad de Supabase, no la key, son las que controlan qué
> se puede leer/escribir). Si más adelante quieres restringir quién edita,
> se ajusta en las políticas RLS de `schema.sql`.

## 3. Probarla en tu computadora

No necesitas instalar nada para probarla local, pero los navegadores
bloquean los `import` de JavaScript si abres el `index.html` directo con
doble clic. Usa un servidor simple:

```bash
cd kermesse-pwa
python3 -m http.server 8080
```

Y abre `http://localhost:8080` en el navegador.

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
├── service-worker.js    → cachea la app para que abra rápido (los datos siguen necesitando internet)
├── css/styles.css
├── js/
│   ├── config.js         → AQUÍ van tus credenciales de Supabase
│   ├── supabaseClient.js
│   └── app.js            → toda la lógica de la app
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
