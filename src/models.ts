export interface ModelProfile {
  id: string;
  label: string;
  role: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  positioning: string;
}

export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    role: "económico / alto volumen",
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.2,
    positioning: "Coordinación, tareas rutinarias y revisiones sencillas",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    role: "equilibrado",
    inputPerMillion: 2,
    cachedInputPerMillion: 0.2,
    outputPerMillion: 12,
    positioning: "Implementación y revisiones con riesgo medio",
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    role: "máxima capacidad",
    inputPerMillion: 4,
    cachedInputPerMillion: 0.4,
    outputPerMillion: 20,
    positioning: "Arquitectura, debugging complejo y decisiones de alto riesgo",
  },
];

export function recommendModel(role: string): string {
  switch (role) {
    case "architect":
    case "security":
      return "gpt-5.6-sol";
    case "implementer":
    case "reviewer":
      return "gpt-5.6-terra";
    case "captain":
    case "researcher":
    default:
      return "gpt-5.6-luna";
  }
}

export function renderModelComparison(): string {
  const rows = MODEL_PROFILES.map((model) =>
    `${model.label.padEnd(15)} ${model.role.padEnd(24)} $${model.inputPerMillion.toFixed(2)} / $${model.outputPerMillion.toFixed(2)}   ${model.positioning}`,
  );
  return [
    "Modelo          Perfil                    API ref. input/output por 1M tokens   Recomendado para",
    ...rows,
    "Nota: el plan ChatGPT usa límites de Codex, no estos precios API directamente.",
  ].join("\n");
}

export function isKnownModel(modelId: string): boolean {
  return MODEL_PROFILES.some((model) => model.id === modelId);
}
