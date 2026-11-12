# Backend de caja y ventas

Este backend es la fuente segura para nuevas ventas simples. La aplicación ya
consulta el inventario/cajas seguros, sincroniza los ajustes de catálogo y
registra ventas desde el POS. No desplegarlo como reemplazo completo del flujo
anterior hasta completar la migración de inventario, congelar las operaciones
antiguas y ejecutar las pruebas con el emulador.

## Alcance actual

- `saveInventoryItem`: alta o ajuste de artículos por un administrador, con
  auditoría. Los celulares individuales tienen stock máximo de una unidad.
- `openRegister` y `closeRegister`: apertura y cierre independientes de las
  cajas `cash`, `transfer` y `card`, exclusivamente por administradores.
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

La integración con Authentication, Firestore y Functions Emulator requiere Java
y se ejecuta desde la raíz del proyecto con:

```sh
firebase emulators:exec --project demo-bestore --only auth,firestore,functions "node functions/test/emulator-integration.js"
```

El 12/11/2026 pasaron las 21 pruebas unitarias y la integración de emuladores
para permisos, inventario, cajas, vista previa, venta idempotente y devolución.

En `be-store-app`, la vista previa de migración reportó 1 artículo elegible,
0 artículos omitidos y 0 ventas elegibles u omitidas. La ejecución autorizada
de `--apply` encontró una marca completa para la misma versión del origen y no
escribió datos. `firebase functions:list` no reportó funciones desplegadas.
El despliegue fue bloqueado porque el proyecto no está en el plan Blaze. No
actualizar el plan ni habilitar facturación sin autorización explícita.
Cuando el proyecto tenga un plan compatible, desplegar con:

```sh
firebase deploy --only functions --project be-store-app
```

Hasta completar el despliegue, las ventas nuevas siguen sin backend disponible.
Después del despliegue, un administrador también debe abrir las cajas necesarias
antes de vender.

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

La integración del POS simple y el cambio de roles están en el código, pero no
se desplegaron. La migración ya tiene una marca completa para la versión actual
de `app_state/main`; los tickets históricos no están disponibles en esta versión
de origen. Aun después del despliegue, las ventas requieren cajas abiertas.

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
