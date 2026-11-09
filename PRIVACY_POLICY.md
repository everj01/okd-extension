# Política de Privacidad — Okumet Document Access

**Última actualización:** 9 de noviembre de 2026

Esta extensión ("Okumet Document Access", "la extensión") es desarrollada y operada por Okumet ("nosotros"). Esta política explica qué datos recopila la extensión, cómo se usan, dónde se almacenan y qué control tiene el usuario sobre ellos.

## 1. ¿Qué hace la extensión?

Okumet Document Access permite a un abogado:

- Iniciar sesión en su cuenta de Okumet Document desde el navegador.
- Validar que la persona que usa la extensión es la misma titular de la cuenta de SINOE (Sistema de Notificaciones Electrónicas del Poder Judicial del Perú), comparando DNI y número de colegiatura.
- Ver sus notificaciones/expedientes de SINOE y sincronizar, de forma manual y bajo su control, los documentos (PDF) asociados hacia su cuenta de Okumet Document.

La extensión solo actúa sobre dos dominios: `casillas.pj.gob.pe` (SINOE, sitio oficial del Poder Judicial) y `api.okumet.com` (backend de Okumet). No accede, lee ni modifica ningún otro sitio web.

## 2. Datos que recopilamos y por qué

| Dato | Origen | Para qué se usa |
|---|---|---|
| Correo y contraseña de Okumet | Formulario de inicio de sesión de la extensión | Autenticar al usuario contra la API de Okumet. La contraseña nunca se almacena; solo se envía una vez por HTTPS para obtener un token de sesión. |
| Token de sesión (Bearer token) | Respuesta del backend de Okumet tras el login | Mantener la sesión activa sin volver a pedir la contraseña. Se guarda únicamente en `chrome.storage.local` (local al navegador del usuario). |
| DNI y número de colegiatura | Página de SINOE (leídos del DOM de la cuenta ya abierta por el usuario) | Validar que la cuenta de SINOE abierta corresponde al mismo abogado que inició sesión en Okumet. Esta comparación se hace para habilitar o bloquear la sincronización; el resultado (habilitado/no habilitado) se guarda en el perfil del usuario en Okumet. |
| Notificaciones y expedientes de SINOE (número de expediente, número de notificación, metadatos) | Tabla de notificaciones de SINOE, solo cuando el usuario presiona "Agregar" o "Sincronizar" | Crear o actualizar el `Expediente` correspondiente en la cuenta de Okumet del propio usuario. |
| Documentos PDF de resoluciones | Descarga iniciada por el propio usuario desde SINOE | Subirse como `Documento` asociado al expediente, dentro de la cuenta de Okumet del propio usuario. |

No recopilamos historial de navegación, contraseñas de terceros, datos financieros ni datos de usuarios distintos al abogado que instala y usa la extensión.

## 3. Cómo se almacenan los datos

- El token de sesión y el estado de la interfaz (pestañas, listas de pendientes/sincronizados) se guardan localmente en `chrome.storage.local`, dentro del propio navegador del usuario. No se comparten con otras extensiones ni sitios.
- Los expedientes, notificaciones y documentos sincronizados se almacenan en los servidores de Okumet (`api.okumet.com`), asociados exclusivamente a la cuenta del usuario que los sincronizó, bajo las mismas medidas de seguridad que el resto de la plataforma Okumet Document.
- Toda comunicación entre la extensión y `api.okumet.com` se realiza mediante HTTPS.

## 4. Con quién compartimos los datos

No vendemos, alquilamos ni compartimos los datos del usuario con terceros ajenos a Okumet. Los datos de SINOE se leen directamente desde la sesión del propio usuario en el sitio oficial del Poder Judicial y se envían únicamente a la cuenta de Okumet del mismo usuario.

## 5. Control del usuario

El usuario puede, en cualquier momento:

- Cerrar sesión desde la extensión, lo que elimina el token almacenado localmente.
- Desinstalar la extensión, lo que elimina todos los datos guardados en `chrome.storage.local`.
- Solicitar la eliminación de su cuenta y de los documentos sincronizados en Okumet Document contactando a soporte (ver sección 7).

La sincronización de cada notificación o documento es siempre una acción manual: la extensión no sincroniza nada automáticamente ni sin que el usuario presione el botón correspondiente.

## 6. Seguridad

Las credenciales se transmiten únicamente por HTTPS. El acceso a SINOE se realiza reutilizando la sesión que el propio usuario ya abrió en su navegador; la extensión no almacena ni reintroduce credenciales de SINOE. Se aplican límites de tiempo y controles de seguridad adicionales para evitar comportamientos automatizados que puedan afectar la cuenta del usuario en SINOE.

## 7. Contacto

Para preguntas sobre esta política o para solicitar la eliminación de tus datos, escríbenos a: **soporte@okumet.com**

## 8. Cambios a esta política

Podemos actualizar esta política cuando la extensión incorpore nuevas funcionalidades. Publicaremos la fecha de la última actualización al inicio de este documento.
