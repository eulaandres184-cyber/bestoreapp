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
del primer administrador se debe habilitar por un operador de confianza, y la
migración del catálogo existente aún no está implementada. Para asignar un rol
a una cuenta activa existente
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

## Pendiente antes de usarlo

Ejecutar la migración real del inventario y los tickets solo después de
conciliar la vista previa y congelar el flujo anterior. También se deben impedir
operaciones en paralelo entre clientes/versiones antiguas y nuevas, probar las
reglas de Firestore y ejecutar la integración con los emuladores. La integración
del POS simple y el cambio de roles están en el código, pero no se desplegaron
ni se migraron datos; sin el inventario seguro y las cajas abiertas, las ventas
fallan de forma explícita. Los emuladores requieren Java, que no estaba
disponible en el entorno de desarrollo al validar estos cambios.

También faltan la conciliación manual de pagos antiguos y sus devoluciones, la
corrección del medio de pago, cambios, cuenta corriente, plan canje y emisión
de comprobantes.
El backend actual rechaza implícitamente esos flujos en vez de calcularlos de
forma aproximada.

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
