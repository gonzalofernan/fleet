# Fleet decisions

Fleet records durable technical decisions here. Keep entries short and include context, decision, and consequences.

## 2026-08-26 — Reconciliación de PRs fusionadas

- Contexto: una PR puede fusionarse fuera de Fleet y dejar agentes y tareas en estado activo.
- Decisión: consultar GitHub mediante `gh` solo para ramas de agentes registradas; exigir `mergedAt` y una coincidencia exacta de `headRefName`, y persistir la evidencia antes de cambiar estados.
- Consecuencia: se evita asociar una PR de otra rama o repositorio y la tarea solo se completa cuando no quedan otros agentes activos.
