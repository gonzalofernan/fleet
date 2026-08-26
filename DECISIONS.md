# Fleet decisions

Fleet records durable technical decisions here. Keep entries short and include context, decision, and consequences.

## 2026-08-26 — Reconciliación de PRs fusionadas

- Contexto: una PR puede fusionarse fuera de Fleet y dejar agentes y tareas en estado activo.
- Decisión: consultar GitHub mediante `gh` solo para ramas de agentes registradas; exigir `mergedAt` y una coincidencia exacta de `headRefName`, y persistir la evidencia antes de cambiar estados.
- Consecuencia: se evita asociar una PR de otra rama o repositorio y la tarea solo se completa cuando no quedan otros agentes activos.

## 2026-08-26 — Cierre desde revisión

- Contexto: el agente puede terminar su entrega antes de que la PR sea revisada, dejando la tarea en `review`.
- Decisión: volver a comprobar esos agentes completados mientras la tarea esté en revisión; una tarea solo pasa a `completed` cuando cada agente no cancelado ni fallido tiene una fusión persistida.
- Consecuencia: una PR fusionada cierra correctamente la revisión sin cerrar antes una tarea con otra PR aún pendiente.
