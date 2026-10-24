import { AGENT_TOGGLES, MODEL_ROLES } from "./agents.js";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

const FLASH = "google/gemini-3.8-flash";

/**
 * Модели ролей по умолчанию: проза — на Claude, проверки и разбор — на дешёвом Gemini Flash.
 * Идеолог, архитектор и редактор идут на defaultModel; переключить их на Gemini можно
 * в «Настройках» (google/gemini-3.1-pro-preview).
 */
export const DEFAULT_ROLE_MODELS = {
  writer: DEFAULT_MODEL,
  auditor: FLASH,
  continuity: FLASH,
  beta: FLASH,
  reviewer: FLASH,
  lore: FLASH,
};

export const MODEL_PRESETS = [
  { id: "anthropic/claude-opus-5.5", note: "Лучшая проза, дороже остальных" },
  { id: "anthropic/claude-sonnet-5.5", note: "Почти Opus по качеству, быстрее и дешевле" },
  { id: "openai/gpt-5.6-terra", note: "Плотный сюжет, хорошо держит структуру" },
  { id: "google/gemini-3.1-pro-preview", note: "Длинный контекст, ровный тон" },
  { id: "google/gemini-3.8-flash", note: "Быстро и дёшево — для канона, критики и лора" },
  { id: "x-ai/grok-4.7", note: "Живой разговорный голос" },
  { id: "deepseek/deepseek-v4-pro", note: "Сильный текст за копейки" },
  { id: "moonshotai/kimi-k3", note: "Хорош в художественном тексте" },
  { id: "anthropic/claude-haiku-5.5", note: "Дёшево — для ревизоров и архивариуса" },
];

const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

export function defaultSettings() {
  return {
    apiKey: "",
    defaultModel: DEFAULT_MODEL,
    roleModels: {},
    agents: Object.fromEntries(AGENT_TOGGLES.map((item) => [item.id, true])),
  };
}

/** Ключ из окружения важнее ключа из файла настроек. */
export function resolveKey(settings, env = process.env) {
  if (env.OPENROUTER_API_KEY?.trim()) return { key: env.OPENROUTER_API_KEY.trim(), source: "env" };
  if (settings.apiKey) return { key: settings.apiKey, source: "settings" };
  return { key: "", source: null };
}

export function modelFor(settings, role) {
  return settings.roleModels?.[role] || DEFAULT_ROLE_MODELS[role] || settings.defaultModel || DEFAULT_MODEL;
}

export function agentEnabled(settings, id) {
  return settings.agents?.[id] !== false;
}

/** То, что можно отдать в браузер: ключ — только маской. */
export function publicSettings(settings, env = process.env) {
  const { key, source } = resolveKey(settings, env);
  return {
    hasKey: Boolean(key),
    keySource: source,
    keyHint: key ? maskKey(key) : "",
    defaultModel: settings.defaultModel || DEFAULT_MODEL,
    roleModels: { ...DEFAULT_ROLE_MODELS, ...settings.roleModels },
    agents: { ...defaultSettings().agents, ...settings.agents },
  };
}

export function maskKey(key) {
  if (key.length <= 12) return "••••";
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** Применяет патч из формы настроек, отбрасывая всё неизвестное. */
export function applySettingsPatch(settings, patch) {
  const errors = [];
  if (patch.clearKey === true) settings.apiKey = "";
  if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
    const key = patch.apiKey.trim();
    if (key.length > 300 || /\s/.test(key)) errors.push("Ключ выглядит неправильно.");
    else settings.apiKey = key;
  }
  if (typeof patch.defaultModel === "string") {
    const id = patch.defaultModel.trim();
    if (MODEL_ID.test(id) && id.length <= 120) settings.defaultModel = id;
    else errors.push("Неверный идентификатор модели.");
  }
  if (patch.roleModels && typeof patch.roleModels === "object") {
    const next = { ...settings.roleModels };
    for (const role of MODEL_ROLES) {
      if (!(role.id in patch.roleModels)) continue;
      const value = String(patch.roleModels[role.id] ?? "").trim();
      if (!value) delete next[role.id];
      else if (MODEL_ID.test(value) && value.length <= 120) next[role.id] = value;
      else errors.push(`Неверная модель для роли «${role.name}».`);
    }
    settings.roleModels = next;
  }
  if (patch.agents && typeof patch.agents === "object") {
    const next = { ...defaultSettings().agents, ...settings.agents };
    for (const item of AGENT_TOGGLES) {
      if (typeof patch.agents[item.id] === "boolean") next[item.id] = patch.agents[item.id];
    }
    settings.agents = next;
  }
  return errors;
}
