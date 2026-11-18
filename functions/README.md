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
- `deleteInventoryItem`: elimina un producto del inventario seguro y del
  catálogo en una transacción, con auditoría. No elimina ni modifica las ventas
  que ya contienen una copia del nombre y precio vendidos; una corrección
  explícita de la venta se registra mediante `editSale`. Se bloquea la
  eliminación si el producto figura en una deuda que aún actualiza precios.
- `openAllRegisters` y `closeAllRegisters`: un administrador abre las tres
  cajas `cash`, `transfer` y `card` en una transacción, con saldo inicial
  independiente para cada una. El cierre también es conjunto y registra el
  importe contado y la diferencia por medio. Si el estado quedó parcial, el
  botón único cierra en una transacción todas las cajas que aún estén abiertas;
  no se permite abrir solo una caja.
- `updateDollarRate`: un administrador actualiza atómicamente la cotización y
  los precios en pesos de los celulares en USD del estado anterior y del
  inventario seguro, sin modificar stock ni ventas. Requiere que cada celular
  en USD ya exista en el inventario seguro y admite hasta 200 por actualización.
- `quotePhone` y `cancelPhoneQuotes`: fijan el precio seguro de un celular para
  el usuario que lo agregó al ticket y cancelan esa cotización al quitarlo. La
  cotización no vence, pero no reserva stock: otra venta puede agotar la unidad.
  El ticket en curso se recupera en el mismo navegador y con el mismo usuario;
  borrar los datos del navegador impide recuperarlo desde ese dispositivo.
- `recordSale`: venta con precios de `secure_inventory` o de la cotización
  segura del celular, stock y cajas actualizados en una transacción, y ticket
  UUID. La cotización se usa una sola vez. Cada reintento debe utilizar el mismo
  `operationId` UUID y la misma solicitud; el precio de la venta confirmada
  queda guardado en el ticket. También se conserva el nombre del usuario que
  confirmó la venta; los tickets anteriores sin ese dato muestran «No registrado».
- Cuenta corriente: `recordSale` admite una venta con cliente identificado y
  saldo pendiente, descontando stock sin movimientos de caja salvo los pagos
  iniciales. `listCustomerDebts` muestra cada deuda y su historial de cobros;
  mientras no haya pagos calcula el saldo con los precios vigentes del
  inventario seguro. `recordCustomerDebtPayment` fija el precio total al primer
  pago y registra cada cobro con fecha y movimientos en las cajas
  correspondientes. Los pagos posteriores no cambian ese precio y pueden ser
  parciales o cancelar el saldo. Tarjeta aplica el mismo plan y redondeo que
  las ventas; el saldo se reduce por el importe base, no por el recargo.
  Los cobros se reintentan con el mismo `operationId`, y requieren confirmar el
  total vigente y tener abiertas las cajas y sesiones utilizadas. El navegador
  conserva un cobro de resultado incierto para reintentarlo; no se debe borrar
  ese dato antes de confirmar el resultado. Las ventas en cuenta corriente no
  admiten edición ni devolución desde los flujos existentes. Los saldos locales
  anteriores no se migran ni se incluyen en las deudas seguras.
  Los indicadores de ventas conservan el importe original de la venta; el
  saldo actualizado y los pagos se consultan en el panel de deudas, no en
  esos indicadores.
- `previewLegacyMigration`: un administrador consulta una vista previa del
  inventario y los tickets de `app_state/main`, con incidencias para conciliar.
  Los celulares en USD que ya coinciden en nombre, estado, stock y precio con
  el inventario seguro no se señalan por moneda. No escribe ni migra datos, ni
  detiene la aplicación anterior. Los tickets antiguos aún no pueden devolverse
  desde el backend nuevo.
- `listInventory` y `getRegisterStatus`: la app consulta los artículos y saldos
  seguros para mostrar existencias y permitir que caja valide la disponibilidad.
- `recordSupplierPayment` y `listSupplierPayments`: solo administradores pueden
  registrar egresos extra a proveedores o destinatarios libres, en efectivo o
  transferencia. La operación exige caja y sesión abiertas con saldo suficiente,
  descuenta ambas en una transacción, registra el movimiento y es idempotente por
  `operationId`. El historial se consulta mediante callable; no habilita lectura
  directa de las colecciones seguras.
- `getSalesSummary`: calcula en una lectura consistente las operaciones y la
  facturación bruta de hoy en horario de Argentina, y el acumulado neto de
  ventas confirmadas menos devoluciones registradas. Incluye ventas anteriores
  del historial sin duplicar las ventas seguras; las anuladas y pendientes no
  se cuentan. Una venta devuelta sigue contando como operación. El neto conserva
  los recargos de tarjeta que no se reintegran. Las devoluciones anteriores no
  registradas en el backend seguro no pueden descontarse automáticamente. Los
  saldos a favor se descuentan al registrar la devolución y los cambios se
  suman al concretarse.
- `setUserRole`: un administrador con claim válida sincroniza el perfil y la
  custom claim del usuario, revoca sus tokens y registra el cambio. El primer
  administrador todavía se debe habilitar con `set-role.js`.
- `setUserPassword`: exclusivamente la cuenta BeStore identificada por UID y
  con rol administrativo activo puede asignar una nueva clave a otro usuario,
  administrador o vendedor. Firebase aplica la clave durante la llamada y se
  revocan los tokens de renovación. La operación se audita sin guardar la clave.
  Si falla un paso posterior al cambio, el aviso indica que la clave ya se
  aplicó y proporciona el identificador de auditoría. Los tokens de acceso ya
  emitidos pueden seguir siendo válidos hasta que caduquen.
- `getEditableSale` y `editSale`: un administrador consulta y corrige ventas
  seguras confirmadas sin devoluciones. Se requiere motivo y revisión vigente;
  la operación ajusta stock y saldos de las sesiones actuales, actualiza el
  historial y registra antes y después en `secure_sale_edits`. Se rechaza en
  conjunto si falta stock, saldo o alguna caja afectada está cerrada. Los
  precios corregidos no cambian el catálogo. Un reintento conserva el mismo
  identificador y contenido, incluso si se perdió la respuesta.
- `recordReturn`: un administrador devuelve artículos de ventas nuevas por su
  precio base, sin recargo de cuotas. El desglose de origen es manual; el
  efectivo se reintegra en efectivo, la transferencia en transferencia y el
  monto pagado con tarjeta se reintegra en efectivo o transferencia. Cada
  artículo puede reponerse o quedar fuera del stock. Se requiere saldo y caja
  abierta en cada medio de reintegro. No admite celulares ni ventas en cuenta
  corriente.
- Devoluciones con saldo a favor: desde el historial, un administrador
  selecciona accesorios y registra motivo, cliente, cantidades y reposición
  opcional. `createReturnCredit` registra el saldo por el precio base vendido,
  sin modificar las cajas, y guarda la fecha y hora del servidor. Se solicita
  nombre si la venta era a consumidor final. El dashboard muestra pendientes,
  resueltas e historial; calcula avisos a las 48 horas y cada 48 horas
  adicionales desde la devolución, mientras quede saldo. Los avisos son
  visibles en el dashboard, no son notificaciones externas.
- `resolveReturnCredit` permite canjear varios productos, reintegrar dinero o
  combinar un cambio de menor valor con reintegro o saldo restante. Cada
  unidad del mismo accesorio sustituye una devuelta por su precio original;
  otras unidades o productos se valoran al precio vigente. Si el cambio supera
  el saldo se cobra la diferencia por efectivo, transferencia y/o tarjeta.
  El movimiento exige caja y sesión abiertas; un reintegro exige saldo
  suficiente. Las existencias, saldo y cajas se actualizan en una transacción,
  con reintentos idempotentes. Se conserva localmente la operación incierta
  para reintentarla; no borrar los datos del navegador antes de confirmar.
  Los cambios registrados suman una operación y su valor al resumen de ventas,
  pero quedan en el historial de la devolución, no como tickets editables.
- Los importes se expresan como enteros en **centavos de peso argentino**. La
  caja de tarjeta registra el neto estimado después de comisiones.

Los documentos `secure_*` no son accesibles desde los clientes con las reglas
actuales; las funciones usan el SDK administrativo. Sus datos son independientes
de `app_state/main`: actualizar el catálogo o vender desde el flujo anterior no
actualiza el inventario seguro, ni viceversa.

El POS conectado admite efectivo, transferencia, tarjeta, pagos mixtos y cuenta
corriente, con precios y stock calculados en el backend. Plan canje se bloquea
explícitamente hasta integrar sus reglas. La venta se confirma en el
backend al imprimir o enviar el comprobante; se usa el mismo `operationId` en
cada reintento y no se permite cancelar mientras el resultado de una llamada
pueda ser incierto. Eliminar un producto del catálogo no elimina sus líneas de
las ventas históricas ni cambia sus precios guardados. Las anulaciones y
eliminaciones locales de ventas tampoco modifican tickets seguros; para ellos
se debe usar el flujo de devolución.

Al editar o ajustar un artículo desde la app, el cambio también se guarda en
`secure_inventory`. Esto no es una migración masiva: los artículos existentes
que no estén allí no se pueden vender por el POS seguro. La sincronización de
existencias desde `secure_inventory` es de solo lectura para la app.

Los cambios de cotización segura aplican a celulares en USD, no a accesorios.
Los clientes que tengan una cotización anterior deben volver a iniciar sesión
antes de guardar cambios. Las reglas impiden actualizar la cotización mediante
escrituras directas a `app_state/main`: se debe usar `updateDollarRate`. Para
habilitar el flujo deben desplegarse conjuntamente funciones, reglas de
Firestore y Hosting; no se debe ejecutar de nuevo la migración solo para quitar
una advertencia de un celular ya conciliado. Antes de desplegar, finalizar o
cancelar los tickets abiertos con versiones anteriores, que no contienen una
cotización segura. La herramienta de migración por línea de comandos continúa
omitiendo celulares en USD; la conciliación de la vista previa de la app no
modifica su plan de migración.

Las reglas de escritura del historial requieren una versión actualizada de la
aplicación: antes de desplegarlas deben finalizarse los tickets abiertos y
cerrarse las versiones anteriores en todos los dispositivos. Funciones, reglas y
Hosting deben desplegarse juntos. Después de una corrección, otros dispositivos
con el historial anterior deben volver a iniciar sesión antes de guardar;
de lo contrario, se rechaza la escritura para no sobrescribir la corrección.

## Autorización y puesta en marcha

Cada usuario requiere una custom claim `bestoreRole` con valor `admin` o
`seller`, asignada por un administrador del proyecto mediante el SDK Admin en un
entorno de confianza. Además, su documento `users/{uid}` debe tener `active:
true` y el mismo `role`. Los usuarios deben renovar su token tras cambiar la
claim. Los vendedores pueden registrar ventas, pero solo los administradores
pueden ajustar el catálogo y abrir o cerrar cajas.

Todos los usuarios activos con `admin` tanto en su custom claim como en su
perfil tienen permisos administrativos, pero únicamente la cuenta BeStore
identificada por UID puede cambiar claves de otros usuarios. Las cargas
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

En la sección Categorías, un administrador puede seleccionar un producto de
la lista para abrir su ficha de edición. Al guardar, la lista y los conteos de
categorías se actualizan, incluso si el producto cambia de categoría. Los
vendedores pueden consultar la lista, pero no abrir la ficha de edición.

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

El 14/11/2026 se trasladaron en producción los 5 productos de `ADAPTADORES`
y los 7 de `CARGADORES COMPLETOS` a `Cargadores & Adaptadores`. Se verificó
que no quedaron productos en las categorías de origen y que los demás campos,
incluidos precio, stock y estado, permanecieron sin cambios. Las categorías de
origen se conservaron.

El 14/11/2026 se trasladaron 27 productos de `FUNDAS Y TEMPLADOS` a
`Fundas & Covers`, y 12 de `AURICULARES` y 4 de `PARLANTES` a `Audio &
Auriculares`. Los 18 nombres de categorías existentes se ajustaron a palabras
con inicial mayúscula, conservando sus identificadores y las categorías vacías.
Se reactivaron 3 productos existentes que estaban anulados con stock positivo,
tanto en el catálogo como en el inventario seguro, con auditoría para los
cambios en el inventario seguro. No se modificaron precios ni cantidades.

Posteriormente se eliminaron en producción las seis categorías sin productos:
`Fundas Y Templados`, `Adaptadores`, `Cargadores Completos`, `Auriculares`,
`Parlantes` e `Inflables`. Se conservaron las 12 categorías con productos; la
operación no modificó los 107 productos existentes. La comprobación incluyó
también los productos sin stock o anulados.

Al guardar o ajustar un accesorio con stock de una unidad o
más lo reactiva; con stock cero queda anulado. Una devolución que repone una
unidad también la reactiva en el inventario seguro. La anulación manual sigue
disponible, pero un ajuste posterior de stock o una reposición por devolución
puede reactivar el artículo. El 14/11/2026 se desplegaron Hosting y la función
`recordReturn` en producción: el JavaScript publicado coincide con el código
local, Hosting respondió HTTP 200 y la función figura activa en Node.js 22.
Sin credenciales, la función rechazó la solicitud con `UNAUTHENTICATED`. No se
ejecutó una devolución real en producción durante la verificación.

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
