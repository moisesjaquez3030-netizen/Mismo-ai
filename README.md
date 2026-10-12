# Mismo AI

Aplicación web en español para transformar una imagen en un video mediante un proveedor de generación de video por IA. Incluye identidad visual minimalista en blanco, negro y gris, registro/inicio de sesión, límites por plan, historial de generaciones y checkout de Stripe.

## Requisitos

- Node.js 20 o superior recomendado.
- Una clave de API de [fal.ai](https://fal.ai/dashboard/keys) para generar videos.
- (Opcional hasta activar pagos) una cuenta de Stripe con dos precios recurrentes en USD: Pro a $12/mes y Ultra a $30/mes.

## Ejecutar en local

1. Descomprime el ZIP y abre una terminal dentro de la carpeta `mismo_ai_v4`.
2. Copia `.env.example` a `.env`.
3. Rellena `FAL_KEY` y establece un `SESSION_SECRET` largo y aleatorio. Para probar localmente puedes dejar Stripe sin configurar.
4. Instala dependencias y arranca el servidor:

   ```bash
   npm install
   npm start
   ```

5. Abre `http://localhost:3000`.

La base de datos SQLite y las sesiones se crean automáticamente en la carpeta del proyecto. Haz copias de seguridad antes de mover o desplegar la aplicación.

## Activar pagos

Configura `STRIPE_SECRET_KEY`, `STRIPE_PRO_PRICE_ID`, `STRIPE_ULTRA_PRICE_ID` y `STRIPE_WEBHOOK_SECRET` en `.env`. Crea un endpoint de Stripe para `POST /api/stripe/webhook` y suscribe al menos los eventos `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` y `customer.subscription.paused`. Usa las claves de prueba de Stripe antes de activar pagos reales.

Configura `APP_URL` con la URL pública exacta al desplegar.

## Planes incluidos

- **Free:** 3 generaciones en cualquier ventana móvil de 24 horas, 4 segundos, 720p.
- **Pro:** 20 generaciones en cualquier ventana móvil de 24 horas, 4–10 segundos, 1080p, $12 USD/mes.
- **Ultra:** sin cuota diaria dentro de la aplicación, 4–15 segundos, 1080p, $30 USD/mes. Se aplica una protección contra ráfagas de solicitudes para evitar abuso.

## Importante antes de publicar

- Cámara y geolocalización requieren permiso explícito del usuario y HTTPS en producción (localhost es válido para desarrollo).
- Las imágenes se envían al proveedor de IA. La biblioteca guarda la URL devuelta por el proveedor, no una copia permanente del archivo de video; el proveedor puede hacer que esas URL caduquen. Para una biblioteca duradera, integra almacenamiento de objetos privado (por ejemplo, S3 o Cloudflare R2) y políticas de retención.
- Antes de cobrar a clientes, prueba los webhooks, cancelaciones, límites, errores del proveedor y la experiencia móvil. Configura HTTPS, un secreto de sesión fuerte, copias de seguridad, aviso de privacidad y términos de servicio.
- Los límites comerciales están implementados en el servidor, pero los resultados, tiempos y disponibilidad dependen del proveedor externo y de sus políticas.
