# Backend de caja y ventas

Este backend es la fuente segura para nuevas ventas simples. La aplicación ya
consulta el inventario/cajas seguros, sincroniza los ajustes de catálogo y
registra ventas desde el POS y está desplegado. No considerarlo todavía
reemplazo completo del flujo anterior: mantener separadas las operaciones
antiguas hasta verificar la operación autenticada, la conciliación y el retiro
controlado de los clientes anteriores.

## Alcance actual

- `saveInventoryItem`: alta o ajuste de artículos por un administrador, con
  auditoría. Los celulares individuales tienen stock máximo de una unidad.
- `openAllRegisters` y `closeAllRegisters`: un administrador abre las tres
  cajas `cash`, `transfer` y `card` en una transacción, con saldo inicial
  independiente para cada una. El cierre también es conjunto y registra el
  importe contado y la diferencia por medio. Si el estado quedó parcial, el
  botón único cierra en una transacción todas las cajas que aún estén abiertas;
  no se permite abrir solo una caja.
- `recordSale`: venta con precios calculados desde `secure_inventory`, stock y
  cajas actualizados en una transacción, y ticket UUID. Cada reintento debe
  utilizar el mismo `operationId` UUID y la misma solicitud.
- `previewLegacyMigration`: un administrador consulta una vista previa del
  inventario y los tickets de `app_state/main`, con incidencias para conciliar.
  No escribe ni migra datos, ni detiene la aplicación anterior. Los tickets
  antiguos aún no pueden devolverse desde el backend nuevo.
- `listInventory` y `getRegisterStatus`: la app consulta los artículos y saldos
  seguros para mostrar existencias y permitir que caja valide la disponibilidad.
- `setUserRole`: un administrador con claim válida sincroniza el perfil y la
  custom claim del usuario, revoca sus tokens y registra el cambio. El primer
  administrador todavía se debe habilitar con `set-role.js`.
- `recordReturn`: un administrador devuelve artículos de ventas nuevas por su
  precio base, sin recargo de cuotas. El desglose de origen es manual; el
  efectivo se reintegra en efectivo, la transferencia en transferencia y el
  monto pagado con tarjeta se reintegra en efectivo o transferencia. Cada
  artículo puede reponerse o quedar fuera del stock. Se requiere saldo y caja
  abierta en cada medio de reintegro.
- Los importes se expresan como enteros en **centavos de peso argentino**. La
  caja de tarjeta registra el neto estimado después de comisiones.

Los documentos `secure_*` no son accesibles desde los clientes con las reglas
actuales; las funciones usan el SDK administrativo. Sus datos son independientes
de `app_state/main`: actualizar el catálogo o vender desde el flujo anterior no
actualiza el inventario seguro, ni viceversa.

El POS conectado admite efectivo, transferencia, tarjeta y pagos mixtos, con
precios y stock recalculados en el backend. Cuenta corriente y plan canje se
bloquean explícitamente hasta integrar sus reglas. La venta se confirma en el
backend al imprimir o enviar el comprobante; se usa el mismo `operationId` en
cada reintento y no se permite cancelar mientras el resultado de una llamada
pueda ser incierto. Las anulaciones y eliminaciones locales no modifican tickets
seguros; para ellos se debe usar el flujo de devolución.

Al editar o ajustar un artículo desde la app, el cambio también se guarda en
`secure_inventory`. Esto no es una migración masiva: los artículos existentes
que no estén allí no se pueden vender por el POS seguro. La sincronización de
existencias desde `secure_inventory` es de solo lectura para la app.

## Autorización y puesta en marcha

Cada usuario requiere una custom claim `bestoreRole` con valor `admin` o
`seller`, asignada por un administrador del proyecto mediante el SDK Admin en un
entorno de confianza. Además, su documento `users/{uid}` debe tener `active:
true` y el mismo `role`. Los usuarios deben renovar su token tras cambiar la
claim. Los vendedores pueden registrar ventas, pero solo los administradores
pueden ajustar el catálogo y abrir o cerrar cajas.

Todos los usuarios activos con `admin` tanto en su custom claim como en su
perfil tienen los mismos permisos administrativos del backend y la app; no hay
una cuenta `BeStore` con privilegios adicionales por UID o nombre. Las cargas
de imágenes no se usan actualmente en la app y Firebase Storage aún no está
inicializado en el proyecto `be-store-app`.

Las reglas locales de Storage validan claim, perfil y estado activo, y permiten
escribir imágenes solo bajo `product-images/{uid}/{fileName}` (máximo 5 MB, tipo
imagen). Antes de que tengan efecto en producción, un operador debe inicializar
Firebase Storage en la consola del proyecto y luego desplegar las reglas. No
configurar un bucket sin acordar su ubicación y costos.

El alta y los cambios de rol desde la app usan `setUserRole`; la configuración
del primer administrador se debe habilitar por un operador de confianza. Para
asignar un rol a una cuenta activa existente
un operador autorizado del proyecto puede ejecutar, desde un entorno de
confianza con credenciales predeterminadas de Google:

```sh
node functions/set-role.js PROJECT_ID UID admin
node functions/set-role.js PROJECT_ID UID seller
```

Ejecutar una sola asignación a la vez. El comando actualiza el perfil, conserva
las otras claims, asigna `bestoreRole`, revoca los tokens de actualización y
registra la operación en `secure_permission_changes`. El usuario debe volver a
iniciar sesión. Si falla después de actualizar el perfil, las funciones
rechazan las credenciales mientras perfil y claim no coincidan; hay que revisar
la operación pendiente y volver a ejecutar el comando. Los permisos IAM del
operador deben limitarse a personal autorizado y al proyecto indicado.

Las reglas actuales del flujo anterior permiten que un usuario cree su propio
perfil; por eso **el perfil por sí solo no autoriza el backend ni el acceso al
estado compartido**. Las reglas de Firestore también requieren que la custom
claim, el rol del perfil y `active: true` coincidan. No se debe confiar en el
flujo anterior como una interfaz segura para administrar ventas o stock.

Para desplegar Cloud Functions se requiere configurar el proyecto y sus
permisos, y un plan de Firebase compatible con Cloud Functions. Las funciones
se ejecutan en `us-central1` con Node.js 22.

## Validación y estado de producción

Las pruebas unitarias se ejecutan con:

```sh
npm test --prefix functions
```

La integración con Authentication, Firestore, Storage y Functions Emulator
requiere Java y se ejecuta desde la raíz del proyecto con:

```sh
firebase emulators:exec --project demo-bestore --only auth,firestore,storage,functions "node functions/test/emulator-integration.js"
```

El 12/11/2026 pasaron 23 pruebas unitarias del backend y la migración, 8
pruebas de planes de tarjeta y la integración de emuladores para permisos,
Storage, inventario, apertura/cierre conjunto de cajas, vista previa, venta
idempotente y devolución.

El 12/11/2026 se desplegaron Hosting y Functions en `be-store-app`. La interfaz
publicada tiene un solo botón de apertura y uno de cierre; `openAllRegisters` y
`closeAllRegisters` están activos en `us-central1` con Node.js 22. Los antiguos
endpoints individuales `openRegister` y `closeRegister` fueron retirados. La
validación HTTP sin credenciales recibió `UNAUTHENTICATED` en los endpoints
nuevos y `404` en los endpoints retirados. No se abrieron ni cerraron cajas
reales durante el despliegue. Antes de operar la caja, un administrador debe
verificar su estado y confirmar los saldos.

## Preparación del conteo inicial de stock

Los administradores pueden editar el nombre de una categoría desde
Administrar categorías. La edición conserva el identificador de categoría para
mantener asociados sus productos y guarda los cambios en Firebase; no permite
nombres vacíos ni duplicados.

Se revisó `LISTA BE STORE.xlsx` sin modificar el original ni escribir datos en
Firebase. Se preparó
[PLANTILLA-CONTEO-STOCK-BE-STORE.xlsx](../PLANTILLA-CONTEO-STOCK-BE-STORE.xlsx)
con 107 accesorios con precio efectivo positivo, 88 modelos de teléfonos con
precio efectivo positivo, 100 productos nombrados con precio efectivo 0,00
separados como discontinuados y 3 filas que requieren revisión. La revisión
directa del archivo corrige el conteo preliminar de 101 productos a precio cero:
se encontraron 100 filas nombradas con precio efectivo 0,00.

Las cantidades quedaron en blanco en la plantilla para completarlas durante el
conteo físico. Los precios de tarjeta y USD son referencias, no precios de alta;
el POS calcula las cuotas según el plan vigente.
Los teléfonos se separaron porque cada unidad requiere su propia ficha con
IMEI/serie y características. No se cargó inventario en la aplicación ni en
Firebase en esa etapa de preparación.

El 12/11/2026 se cargaron en producción `be-store-app` 107 artículos no
telefónicos con precio efectivo positivo, tomando cada hoja no excluida como
categoría. Se añadieron 11 categorías y se reutilizaron 3 ya existentes. Los
artículos quedaron tanto en `app_state/main` como en `secure_inventory`, con
una entrada de auditoría por artículo; el artículo que ya existía se conservó.
El stock quedó en 0 y los artículos inactivos (`Anulado` en el catálogo) hasta
realizar el conteo físico.
El costo de compra se dejó sin informar porque el XLSX solo contiene precios de
venta. Se verificaron 107 registros en cada colección y que los precios
coincidan entre ambos inventarios.

Luego se movieron 11 productos de la categoría `FUNDAS Y TEMPLADOS` a
`Vidrios Templados` (`proteccion`), según lo solicitado. Se conservaron sus
precios, stock y estado; la verificación confirmó los 11 cambios y los precios
originales.

Se excluyeron las hojas `SAMSUNG`, `MOTOROLA`, `IPHONEs`, `USADOS` y `XIAOMI`,
los productos con precio efectivo 0,00 y las filas sin precio efectivo
identificable. Los precios de tarjeta y USD no se cargaron. Los registros
ambiguos deben resolverse aparte. Antes de vender o habilitar artículos,
completar el conteo físico y ajustar existencias mediante la app, que sincroniza
cambios con `secure_inventory`.

La integración también verifica las reglas locales de Storage: Admin activo
puede cargar en su propia ruta, vendedor e Admin inactivo no, Admin no puede
escribir en la ruta de otra cuenta y un segundo Admin activo tiene los mismos
permisos. Firebase Storage aún no está inicializado en `be-store-app`, por lo
que el intento de despliegue de reglas fue rechazado y no cambió producción.
Si se habilita Storage, elegir primero la ubicación y revisar costos en la
consola Firebase; después ejecutar:

```sh
firebase deploy --only storage --project be-store-app
```

El 12/11/2026 también pasaron las 8 pruebas de planes de tarjeta. Tras el
despliegue, `be-store-app.web.app` respondió HTTP 200 y las nueve Cloud
Functions esperadas aparecieron activas en `us-central1` con Node.js 22. No se
realizó una transacción real autenticada de caja o venta en producción; antes
de cargar el catálogo o vender, un administrador debe comprobar roles,
inventario seguro y apertura/conciliación de las cajas.

La vista previa de migración reportó 1 artículo elegible, 0 artículos omitidos
y 0 ventas elegibles u omitidas. `--apply` encontró una marca completa para la
misma versión del origen y no escribió datos en ese intento. El informe general
de estado está en [INFORME-ESTADO-APLICACION-2026-11-12.txt](../INFORME-ESTADO-APLICACION-2026-11-12.txt).
## Migración del flujo anterior

`migrate-legacy.js` copia los artículos sin incidencias a `secure_inventory` y
archiva los tickets sin incidencias en `secure_legacy_sales`. No convierte
pagos, no crea movimientos ni saldos de caja, no permite devolver tickets
antiguos y no elimina ni modifica `app_state/main`. Los registros con
incidencias se omiten; los conflictos con documentos seguros existentes detienen
el proceso sin sobrescribirlos. El archivo histórico no es todavía una fuente
de lectura del POS ni del historial de ventas.

Antes de una ejecución real, conciliar los datos requeridos, detener todas las
escrituras del flujo anterior y evitar operaciones en paralelo entre clientes
antiguos y nuevos. La herramienta verifica que `app_state/main` no cambie
mientras copia los datos, pero no puede comprobar por sí sola que todos los
clientes estén congelados.

Con credenciales de Application Default Credentials autorizadas para el proyecto
de destino, primero ejecutar la vista previa de solo lectura y revisar los
conteos:

```sh
gcloud auth application-default login
npm run migrate:legacy --prefix functions -- --project PROJECT_ID
```

Solo después de revisar los conteos y confirmar el congelamiento:

```sh
npm run migrate:legacy --prefix functions -- --project PROJECT_ID --apply --confirm-legacy-freeze PROJECT_ID
```

La operación es idempotente para la misma versión del origen: crea un marcador
al finalizar y usa IDs deterministas para poder reintentar después de una
interrupción. Si existe una marca de otra migración, hay conflictos o el origen
cambia, el proceso se detiene para revisión manual. El comando usa el Admin SDK
y requiere permisos para leer `app_state/main` y escribir las colecciones
`secure_*`.

La integración del POS simple y el cambio de roles están desplegados. La
migración tiene una marca completa para la versión consultada de `app_state/main`;
la vista previa no encontró tickets históricos en esa versión. Las ventas
requieren inventario seguro y cajas abiertas.

La vista previa de producción no encontró tickets antiguos, por lo que no había
pagos ni devoluciones históricas que conciliar en esa versión del origen.

Por decisión del usuario, quedan pospuestos la corrección del medio de pago,
cambios, cuenta corriente, plan canje y emisión de comprobantes. No habilitar
esos flujos desde el backend seguro hasta acordar y documentar sus reglas de
negocio y, para comprobantes, el proveedor de emisión.

### Contrato de devolución

`recordReturn` recibe un `operationId` UUID estable por intento, `ticketId`,
`reason`, `items: [{id, quantity, restock}]` y `source`, con importes en
centavos: `cash`, `transfer`, `cardToCash` y `cardToTransfer`. Los importes de
origen no pueden superar lo pendiente en cada medio de la venta. No se
modifica la caja de tarjeta al devolver; la salida se registra en la caja de
efectivo o transferencia utilizada. El historial conserva el motivo y la
decisión de reposición.

Ejecutar pruebas unitarias:

```sh
npm ci --prefix functions
npm test --prefix functions
```
