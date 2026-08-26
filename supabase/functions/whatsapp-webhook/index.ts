import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Variable de respaldo — se usa SOLO si un flujo no tiene su propia API key configurada
const YCLOUD_KEY_FALLBACK = Deno.env.get("YCLOUD_API_KEY") || "";
const YCLOUD_URL   = "https://api.ycloud.com/v2/whatsapp/messages";
const DEEPSEEK_KEY = Deno.env.get("DEEPSEEK_API_KEY")!;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// Credenciales de la cuenta de servicio de Google (el JSON completo, pegado tal cual)
const GOOGLE_SA_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ============================================================
// DEEPSEEK — Normalizar valor capturado
// ============================================================
async function normalizeField(fieldKey: string, rawValue: string): Promise<string> {
  const fieldsToNormalize = ['ciudad', 'municipio', 'puesto', 'nombre', 'experiencia'];
  if (!fieldsToNormalize.includes(fieldKey.toLowerCase())) return rawValue;

  const prompts: Record<string, string> = {
    ciudad:      `El usuario respondió sobre su ciudad o municipio: "${rawValue}". Extrae SOLO el nombre del municipio o ciudad en formato título (primera letra mayúscula). Si mencionan colonia o estado, ignóralos. Solo el municipio. Ejemplos: "vivo en apodaca nl" → "Apodaca", "soy de san pedro" → "San Pedro Garza García", "guadalupe" → "Guadalupe". Responde SOLO con el nombre, sin explicaciones.`,
    municipio:   `El usuario respondió sobre su municipio: "${rawValue}". Extrae SOLO el nombre del municipio en formato título. Responde SOLO con el nombre.`,
    puesto:      `El usuario respondió sobre el puesto que busca: "${rawValue}". Normaliza a un nombre de puesto profesional y conciso. Ejemplos: "quiero ser montacarguista" → "Montacarguista", "operador de maquinaria" → "Operador", "manejo montacargas" → "Montacarguista". Responde SOLO con el nombre del puesto.`,
    nombre:      `El usuario respondió con su nombre: "${rawValue}". Extrae SOLO el nombre completo en formato título (primera letra mayúscula en cada palabra). Ignora frases como "me llamo" o "soy". Responde SOLO con el nombre.`,
    experiencia: `El usuario respondió sobre sus años de experiencia: "${rawValue}". Extrae SOLO el número de años. Ejemplos: "tengo 3 años" → "3", "cinco años" → "5", "2" → "2". Responde SOLO con el número.`,
  };

  const prompt = prompts[fieldKey.toLowerCase()];
  if (!prompt) return rawValue;

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0
      })
    });
    const data = await res.json();
    const normalized = data?.choices?.[0]?.message?.content?.trim();
    console.log(`normalizeField ${fieldKey}: "${rawValue}" → "${normalized}"`);
    return normalized || rawValue;
  } catch(e) {
    console.error('DeepSeek error:', e);
    return rawValue;
  }
}

// ============================================================
// DEEPSEEK — Validar que la respuesta corresponda a la pregunta
// Si el candidato pone "buenos días" cuando se le pregunta el nombre,
// el bot le pide que responda correctamente sin avanzar en el flujo.
// ============================================================
// ============================================================
// VALIDACIÓN LOCAL POR REGLAS — no depende de ninguna API
// Se ejecuta SIEMPRE antes de DeepSeek. Si esto rechaza, se rechaza.
// ============================================================
function limpiarTexto(s: string): string {
  return s.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Frases que nunca son un dato válido, sin importar el campo
const BASURA_GENERAL = [
  "hola", "holaa", "ola", "buenas", "buenos dias", "buen dia", "buenas tardes",
  "buenas noches", "que tal", "qué tal", "saludos", "hey", "ey",
  "si", "sí", "no", "ok", "okay", "oki", "va", "sale", "listo", "bien",
  "gracias", "grax", "de nada", "aja", "ajá", "mmm", "eso", "claro",
  "por favor", "porfa", "me interesa", "interesado", "interesada",
  "info", "informacion", "información", "quiero info", "mas info",
  "?", "??", "...", "x", "xd", "jaja", "jajaja"
];

function validarLocal(
  fieldKey: string,
  respuesta: string,
  node: any
): { valido: boolean; error: string } {
  const raw   = (respuesta || "").trim();
  const texto = limpiarTexto(raw);

  if (!texto) {
    return { valido: false, error: "No recibí tu respuesta. ¿Me la puedes escribir por favor?" };
  }

  // 1. Si el nodo tiene opciones (pregunta / lista), la respuesta DEBE ser una de ellas
  const opciones = node?.options;
  if (Array.isArray(opciones) && opciones.length > 0) {
    const coincide = opciones.some((o: any) =>
      limpiarTexto(String(o.value ?? "")) === texto ||
      limpiarTexto(String(o.label ?? "")) === texto
    );
    if (!coincide) {
      const lista = opciones.map((o: any) => `• ${o.label}`).join("\n");
      return {
        valido: false,
        error: `Por favor selecciona una de las opciones del menú:\n\n${lista}`
      };
    }
    return { valido: true, error: "" };
  }

  // 2. Basura general — saludos, monosílabos, agradecimientos
  if (BASURA_GENERAL.includes(texto)) {
    return {
      valido: false,
      error: `Disculpa, no alcancé a registrar el dato. ¿Me lo puedes escribir por favor?`
    };
  }

  // 3. Reglas por tipo de campo
  const key = limpiarTexto(fieldKey);

  // NOMBRE — mínimo 3 letras, sin puros números
  if (key.includes("nombre")) {
    if (raw.length < 3)              return { valido: false, error: "Por favor escríbeme tu *nombre completo* 😊" };
    if (/^\d+$/.test(raw))           return { valido: false, error: "Necesito tu *nombre*, no un número. ¿Me lo compartes? 😊" };
    if (!/[a-záéíóúñ]{2,}/i.test(raw)) return { valido: false, error: "Por favor escríbeme tu *nombre completo* 😊" };
    return { valido: true, error: "" };
  }

  // MUNICIPIO / COLONIA / CIUDAD — mínimo 3 letras, no puros números
  if (key.includes("municipio") || key.includes("ciudad") || key.includes("colonia") || key.includes("domicilio") || key.includes("ubicacion")) {
    if (raw.length < 3)              return { valido: false, error: "¿En qué *municipio o colonia* vives? 📍" };
    if (/^\d+$/.test(raw))           return { valido: false, error: "Necesito el nombre del *municipio o colonia*, no un número 📍" };
    if (!/[a-záéíóúñ]{3,}/i.test(raw)) return { valido: false, error: "¿En qué *municipio o colonia* vives? 📍" };
    return { valido: true, error: "" };
  }

  // DISPONIBILIDAD / FECHA DE CITA — debe traer día, mes u hora
  if (key.includes("disponibilidad") || key.includes("fecha") || key.includes("cita") || key.includes("dia")) {
    const tieneDia = /(lunes|martes|miercoles|jueves|viernes|sabado|domingo|hoy|manana|mañana|pasado)/i.test(texto);
    const tieneMes = /(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)/i.test(texto);
    const tieneNum = /\d{1,2}/.test(raw);
    const tieneHora= /(\d{1,2}\s*(am|pm|hrs|horas|:\d{2}))/i.test(texto);
    if (!tieneDia && !tieneMes && !tieneNum && !tieneHora) {
      return {
        valido: false,
        error: "¿Qué *día y hora* te queda mejor? 📅\n_Ejemplo: lunes 21 a las 9am_"
      };
    }
    if (raw.length < 3) {
      return { valido: false, error: "¿Qué *día y hora* te queda mejor? 📅\n_Ejemplo: lunes 21 a las 9am_" };
    }
    return { valido: true, error: "" };
  }

  // PUESTO / VACANTE (texto libre) — mínimo 3 letras
  if (key.includes("puesto") || key.includes("vacante")) {
    if (raw.length < 3 || !/[a-záéíóúñ]{3,}/i.test(raw)) {
      return { valido: false, error: "¿Qué *puesto* te interesa? 💼" };
    }
    return { valido: true, error: "" };
  }

  // TELÉFONO — mínimo 10 dígitos
  if (key.includes("telefono") || key.includes("celular") || key.includes("whatsapp")) {
    const digitos = raw.replace(/\D/g, "");
    if (digitos.length < 10) {
      return { valido: false, error: "Por favor escríbeme tu número a *10 dígitos* 📱" };
    }
    return { valido: true, error: "" };
  }

  // EDAD — número entre 16 y 75
  if (key.includes("edad")) {
    const n = parseInt(raw.replace(/\D/g, ""), 10);
    if (isNaN(n) || n < 16 || n > 75) {
      return { valido: false, error: "¿Cuántos *años* tienes? Escríbelo solo con números 🙂" };
    }
    return { valido: true, error: "" };
  }

  // Genérico — al menos 2 caracteres con alguna letra o número
  if (raw.length < 2) {
    return { valido: false, error: "Disculpa, ¿me puedes escribir el dato completo? 😊" };
  }

  return { valido: true, error: "" };
}

async function validarRespuesta(
  fieldKey: string,
  pregunta: string,
  respuesta: string
): Promise<{ valido: boolean; error: string }> {

  const prompt = `Eres un asistente que valida respuestas en un chatbot de reclutamiento en México.

La pregunta fue: "${pregunta}"
Campo que se quiere capturar: "${fieldKey}"
Respuesta del candidato: "${respuesta}"

¿La respuesta tiene sentido para lo que se preguntó?

Respuestas claramente INVÁLIDAS:
- Saludos en lugar del dato ("buenos días", "hola", "buenas", "qué tal")
- Preguntas en lugar del dato ("¿cuánto pagan?", "¿dónde queda?")
- Respuestas fuera de contexto ("ok", "sí", "no", "gracias", "va") cuando se espera información
- Números solos cuando se espera un nombre

Cualquier intento de dar el dato pedido es VÁLIDO, aunque tenga errores de ortografía.

Responde ÚNICAMENTE con JSON sin texto ni bloques de código:
{"valido": true, "error": ""}
o
{"valido": false, "error": "mensaje corto y amable en español pidiendo que responda con el dato"}`;

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 80,
        temperature: 0
      })
    });
    const data = await res.json();
    const content = (data?.choices?.[0]?.message?.content || "").trim();
    const limpio = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(limpio);
    console.log(`validarRespuesta [nombre]: "${respuesta}" → valido=${parsed.valido}`);
    return { valido: parsed.valido ?? true, error: parsed.error || "" };
  } catch(e) {
    console.error(`[DEEPSEEK-FALLO] No se pudo validar "${fieldKey}" — revisa DEEPSEEK_KEY o saldo. Detalle:`, e);
    // La validación local ya se ejecutó antes, así que aquí se deja pasar sin riesgo
    return { valido: true, error: "" };
  }
}

// ============================================================
// CONFIGURACIÓN DEL FLUJO — número + API key propios
// ============================================================
type FlowConfig = { from: string; apiKey: string; delayMs: number; budgetMs?: number };

// Pausa entre mensajes para que la conversación se sienta natural
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Topes de seguridad: yCloud espera respuesta del webhook. Si tardamos demasiado
// da timeout y reintenta el mensaje, lo que genera respuestas duplicadas.
const DELAY_MAX_MS  = 2000;   // maximo por mensaje
const BUDGET_MAX_MS = 6000;   // maximo acumulado en toda la cadena de nodos

function normalizarDelay(segundos: any): number {
  const n = Number(segundos);
  if (!isFinite(n) || n < 0) return 1000;     // default 1 segundo
  return Math.min(Math.round(n * 1000), DELAY_MAX_MS);
}

async function getFlowConfig(flowId: string, toPhoneFallback: string = ""): Promise<FlowConfig> {
  const { data } = await sb.from("flows")
    .select("whatsapp_phone, ycloud_api_key, message_delay")
    .eq("id", flowId)
    .maybeSingle();

  return {
    // Si el flujo no tiene número configurado, usar el número que recibió el mensaje
    // para no responder desde el número equivocado de otro cliente
    from: data?.whatsapp_phone || toPhoneFallback || "",
    apiKey: data?.ycloud_api_key || YCLOUD_KEY_FALLBACK,
    delayMs: normalizarDelay(data?.message_delay ?? 1),
    budgetMs: BUDGET_MAX_MS,
  };
}



// ============================================================
// FECHA DE CITA — convierte lo que escribe el candidato a una fecha real
// Primero por reglas (rápido y sin depender de nadie), DeepSeek de respaldo
// ============================================================
const DIAS_SEMANA: Record<string, number> = {
  domingo:0, lunes:1, martes:2, miercoles:3, "miércoles":3, jueves:4,
  viernes:5, sabado:6, "sábado":6,
};
const MESES: Record<string, number> = {
  enero:0, febrero:1, marzo:2, abril:3, mayo:4, junio:5, julio:6,
  agosto:7, septiembre:8, setiembre:8, octubre:9, noviembre:10, diciembre:11,
};

function hoyMonterrey(): Date {
  const d = new Date(Date.now() - 6 * 3600 * 1000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const aISO = (d: Date) => d.toISOString().slice(0, 10);

// Devuelve { fecha: "YYYY-MM-DD" | null, hora: "HH:MM" | null }
// refISO: día en que el candidato escribió el texto. "mañana" es relativo a ESE día,
// no al día en que se procesa. Si no se pasa, se usa hoy.
function parsearCitaLocal(texto: string, refISO?: string): { fecha: string | null; hora: string | null } {
  if (!texto) return { fecha: null, hora: null };
  const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const hoy = refISO ? new Date(refISO + "T00:00:00Z") : hoyMonterrey();

  // ── Hora ──
  let hora: string | null = null;
  const mHora = t.match(/(\d{1,2})[:.](\d{2})\s*(am|pm|hrs|horas)?/)
             || t.match(/(?:a\s+las?\s+)?(\d{1,2})\s*(am|pm)/);
  if (mHora) {
    let h = parseInt(mHora[1], 10);
    const min = mHora[2] && /^\d{2}$/.test(mHora[2]) ? mHora[2] : "00";
    const suf = (mHora[3] || mHora[2] || "").toLowerCase();
    if (suf === "pm" && h < 12) h += 12;
    if (suf === "am" && h === 12) h = 0;
    if (h >= 0 && h <= 23) hora = `${String(h).padStart(2,"0")}:${min}`;
  }

  // ── Fecha relativa ──
  if (/\bpasado\s+manana\b/.test(t)) {
    const d = new Date(hoy); d.setUTCDate(d.getUTCDate() + 2);
    return { fecha: aISO(d), hora };
  }
  if (/\bmanana\b/.test(t)) {
    const d = new Date(hoy); d.setUTCDate(d.getUTCDate() + 1);
    return { fecha: aISO(d), hora };
  }
  if (/\bhoy\b/.test(t)) return { fecha: aISO(hoy), hora };

  // ── dd/mm o dd-mm (con año opcional) ──
  const mNum = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (mNum) {
    const dia = +mNum[1], mes = +mNum[2] - 1;
    let anio = mNum[3] ? +mNum[3] : hoy.getUTCFullYear();
    if (anio < 100) anio += 2000;
    if (dia >= 1 && dia <= 31 && mes >= 0 && mes <= 11) {
      let f = new Date(Date.UTC(anio, mes, dia));
      // Sin año explícito y ya pasó: se asume el año siguiente
      if (!mNum[3] && f < hoy) f = new Date(Date.UTC(anio + 1, mes, dia));
      return { fecha: aISO(f), hora };
    }
  }

  // ── "21 de julio" / "julio 21" ──
  for (const [nombre, mes] of Object.entries(MESES)) {
    if (!t.includes(nombre)) continue;
    const mDia = t.match(new RegExp(`(\\d{1,2})\\s*(?:de\\s+)?${nombre}`))
              || t.match(new RegExp(`${nombre}\\s*(?:de\\s+)?(\\d{1,2})`));
    if (mDia) {
      const dia = +mDia[1];
      if (dia >= 1 && dia <= 31) {
        let f = new Date(Date.UTC(hoy.getUTCFullYear(), mes, dia));
        if (f < hoy) f = new Date(Date.UTC(hoy.getUTCFullYear() + 1, mes, dia));
        return { fecha: aISO(f), hora };
      }
    }
  }

  // ── Día de la semana, con número de día opcional ("lunes 21") ──
  for (const [nombre, dow] of Object.entries(DIAS_SEMANA)) {
    if (!new RegExp(`\\b${nombre}\\b`).test(t)) continue;

    const mDia = t.match(new RegExp(`${nombre}\\s+(\\d{1,2})\\b`));
    if (mDia) {
      const dia = +mDia[1];
      for (let k = 0; k < 3; k++) {
        const f = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + k, dia));
        if (f >= hoy) return { fecha: aISO(f), hora };
      }
    }
    // Próxima ocurrencia de ese día
    const d = new Date(hoy);
    let delta = (dow - d.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;               // "el lunes" dicho en lunes = el siguiente
    d.setUTCDate(d.getUTCDate() + delta);
    return { fecha: aISO(d), hora };
  }

  // ── Solo un número suelto: día de este mes o del siguiente ──
  const mSolo = t.match(/\b(\d{1,2})\b/);
  if (mSolo && !hora) {
    const dia = +mSolo[1];
    if (dia >= 1 && dia <= 31) {
      for (let k = 0; k < 2; k++) {
        const f = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + k, dia));
        if (f >= hoy) return { fecha: aISO(f), hora };
      }
    }
  }

  return { fecha: null, hora };
}

// DeepSeek como respaldo cuando las reglas no alcanzan
async function parsearCitaIA(texto: string, refISO?: string): Promise<string | null> {
  if (!texto || !DEEPSEEK_KEY) return null;
  const hoy = refISO ? new Date(refISO + "T00:00:00Z") : hoyMonterrey();
  const prompt = `El candidato escribió esto el ${aISO(hoy)}: "${texto}".\n` +
    `Interpreta las palabras relativas (hoy, mañana, el jueves) tomando como referencia ESA fecha.\n` +
    `Devuelve SOLO la fecha en formato YYYY-MM-DD, o la palabra null si no se puede saber. Sin explicaciones.`;
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({ model: "deepseek-chat", temperature: 0, max_tokens: 16,
                             messages: [{ role: "user", content: prompt }] })
    });
    const data = await res.json();
    const r = (data?.choices?.[0]?.message?.content || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(r) ? r : null;
  } catch { return null; }
}

// Guarda la cita normalizada en el contacto
async function guardarCita(phone: string, texto: string, refISO?: string) {
  let { fecha, hora } = parsearCitaLocal(texto, refISO);
  if (!fecha) fecha = await parsearCitaIA(texto, refISO);
  if (!fecha) { console.log(`[CITA] no se pudo interpretar "${texto}"`); return; }

  await sb.from("contacts").update({
    cita_fecha: fecha, cita_hora: hora, updated_at: new Date().toISOString()
  }).eq("phone", phone);
  console.log(`[CITA] ${phone} → ${fecha}${hora ? " " + hora : ""} (de "${texto}")`);
}

// ============================================================
// MEDIA — descarga la imagen de yCloud y la guarda en Supabase Storage
// para que se pueda ver en el Inbox sin necesidad de la API key
// ============================================================
async function guardarMedia(url: string, apiKey: string, phone: string): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { "X-API-Key": apiKey } });
    if (!res.ok) {
      console.log(`[MEDIA] no se pudo descargar (${res.status}) — se guarda el enlace original`);
      return url;
    }
    const tipo  = res.headers.get("content-type") || "image/jpeg";
    const bytes = new Uint8Array(await res.arrayBuffer());

    const ext  = tipo.includes("png")  ? "png"
               : tipo.includes("webp") ? "webp"
               : tipo.includes("mp4")  ? "mp4"
               : tipo.includes("pdf")  ? "pdf"
               : tipo.includes("ogg")  ? "ogg" : "jpg";
    const ruta = `recibidos/${phone.replace(/\D/g, "")}/${Date.now()}.${ext}`;

    const up = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/chatbot-media/${ruta}`,
      { method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": tipo,
          "x-upsert": "true",
        },
        body: bytes }
    );
    if (!up.ok) {
      console.log(`[MEDIA] fallo al subir (${up.status}) — se guarda el enlace original`);
      return url;
    }
    const publica = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/chatbot-media/${ruta}`;
    console.log(`[MEDIA] guardada: ${publica}`);
    return publica;
  } catch (e) {
    console.log("[MEDIA] error:", e);
    return url;
  }
}

// Extrae media y texto de un mensaje entrante, sea del formato que sea
function extraerMedia(msg: any): { url: string; caption: string; tipo: string } | null {
  for (const t of ["image", "video", "document", "audio", "sticker", "voice"]) {
    const o = msg?.[t];
    if (o && (o.link || o.url || o.id)) {
      return { url: o.link || o.url || "", caption: o.caption || "", tipo: t };
    }
  }
  return null;
}

// ============================================================
// TYPING INDICATOR — marca el mensaje como leído (doble check azul)
// y muestra "escribiendo..." mientras preparamos la respuesta.
// El indicador se quita solo al responder, o a los 25 segundos.
// ============================================================
async function marcarLeidoYEscribiendo(inboundId: string, apiKey: string) {
  if (!inboundId || !apiKey) return;
  try {
    const res = await fetch(
      `https://api.ycloud.com/v2/whatsapp/inboundMessages/${encodeURIComponent(inboundId)}/typing`,
      { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey } }
    );
    if (!res.ok) {
      const t = await res.text();
      console.log(`[TYPING] ${res.status}: ${t.slice(0, 120)}`);
    } else {
      console.log(`[TYPING] escribiendo... mostrado para ${inboundId}`);
    }
  } catch (e) {
    // Nunca debe romper el flujo — es solo cosmético
    console.log("[TYPING] error ignorado:", e);
  }
}

// ============================================================
// YCLOUD — Envío de mensajes (cada llamada usa la API key de SU flujo)
// ============================================================
// Registra cada intento de envío saliente, con su estatus real (enviado/fallido)
async function logOutbound(to: string, content: string, nodeKey: string | null, ok: boolean, errorDetail: string | null) {
  // El wamid permite luego actualizar el estatus real (entregado / leido / fallido)
  // cuando llega el webhook whatsapp.message.updated
  let wamid: string | null = null;
  try {
    const i = (errorDetail || "").indexOf("{");
    if (i >= 0) {
      const r = JSON.parse((errorDetail || "").slice(i));
      wamid = r.wamid || r.id || null;
    }
  } catch { /* respuesta no JSON, se ignora */ }

  try {
    await sb.from("message_log").insert({
      phone: to, direction: "out", content, node_key: nodeKey,
      status: ok ? "sent" : "failed",
      wamid,
      error_detail: ok ? null : (errorDetail || "").slice(0, 500),
    });
  } catch(e) { console.error("Error guardando message_log:", e); }
}

async function sendText(to: string, text: string, from: string, apiKey: string, nodeKey: string | null = null) {
  const textoSeguro = (text || "").slice(0, 4096); // limite de WhatsApp para texto plano
  const payload = { from, to, type: "text", text: { body: textoSeguro } };
  console.log("sendText payload:", JSON.stringify(payload));
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload),
  });
  const resText = await res.text();
  console.log("sendText response:", res.status, resText);
  await logOutbound(to, textoSeguro, nodeKey, res.ok, `HTTP ${res.status}: ${resText}`);
}

async function sendImage(to: string, url: string, from: string, apiKey: string, caption?: string, nodeKey: string | null = null) {
  const captionSeguro = caption ? caption.slice(0, 1024) : caption; // limite de caption en imagenes
  const payload: any = { from, to, type: "image", image: { link: url } };
  if (captionSeguro) payload.image.caption = captionSeguro;
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload),
  });
  const resText = await res.text();
  console.log("sendImage response:", res.status, resText);
  const registroLog = captionSeguro ? `[Imagen] ${url}\n${captionSeguro}` : `[Imagen] ${url}`;
  await logOutbound(to, registroLog, nodeKey, res.ok, `HTTP ${res.status}: ${resText}`);
}

async function sendButtons(to: string, text: string, options: { label: string; value: string }[], from: string, apiKey: string, nodeKey: string | null = null) {
  const textoSeguro = (text || "Elige una opcion:").slice(0, 1024); // limite del body en mensajes interactivos
  const buttons = options.slice(0, 3).map((o) => ({
    type: "reply",
    reply: { id: o.value, title: o.label.slice(0, 20) },
  }));
  const payload = {
    from, to, type: "interactive",
    interactive: { type: "button", body: { text: textoSeguro }, action: { buttons } },
  };
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload),
  });
  const resText = await res.text();
  console.log("sendButtons response:", res.status, resText);
  await logOutbound(to, textoSeguro, nodeKey, res.ok, `HTTP ${res.status}: ${resText}`);
}

async function sendList(to: string, body: string, buttonText: string, sectionTitle: string, items: { label: string; value: string; description?: string }[], from: string, apiKey: string, nodeKey: string | null = null) {
  const bodySeguro = (body || "Elige una opcion:").slice(0, 1024); // limite del body en mensajes interactivos
  const rows = items.map(item => ({
    id: item.value,
    title: item.label.slice(0, 24),
    ...(item.description ? { description: item.description.slice(0, 72) } : {})
  }));
  const payload = {
    from, to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodySeguro },
      action: {
        button: buttonText.slice(0, 20) || "Ver opciones",
        sections: [{
          title: sectionTitle.slice(0, 24) || "Opciones",
          rows: rows.slice(0, 10)
        }]
      }
    }
  };
  console.log("sendList payload:", JSON.stringify(payload));
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload),
  });
  const resText = await res.text();
  console.log("sendList response:", res.status, resText);
  await logOutbound(to, bodySeguro, nodeKey, res.ok, `HTTP ${res.status}: ${resText}`);
}

// ============================================================
// GOOGLE SHEETS — un libro por número de WhatsApp, en tiempo real
// ============================================================
let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGoogleAccessToken(): Promise<string | null> {
  if (!GOOGLE_SA_JSON) return null;
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now() + 60000) {
    return cachedGoogleToken.token;
  }

  try {
    const sa = JSON.parse(GOOGLE_SA_JSON);
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claimSet = {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;

    const pemBody = sa.private_key
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s/g, "");
    const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned)
    );
    const jwt = `${unsigned}.${base64url(signature)}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    const data = await res.json();
    if (!data.access_token) {
      console.error("Google token error:", JSON.stringify(data));
      return null;
    }
    cachedGoogleToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  } catch(e) {
    console.error("Error generando token de Google:", e);
    return null;
  }
}

async function sheetsGet(sheetId: string, range: string): Promise<any> {
  const token = await getGoogleAccessToken();
  if (!token) return null;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) { console.error("sheetsGet error:", res.status, await res.text()); return null; }
  return await res.json();
}

async function sheetsUpdate(sheetId: string, range: string, values: any[][]): Promise<boolean> {
  const token = await getGoogleAccessToken();
  if (!token) return false;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) console.error("sheetsUpdate error:", res.status, await res.text());
  return res.ok;
}

async function sheetsAppend(sheetId: string, range: string, values: any[][]): Promise<boolean> {
  const token = await getGoogleAccessToken();
  if (!token) return false;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) console.error("sheetsAppend error:", res.status, await res.text());
  return res.ok;
}

// Convierte field_key a título legible
function tituloCampo(key: string): string {
  const titulos: Record<string, string> = {
    nombre: "Nombre", municipio: "Municipio", puesto: "Puesto",
    empresa: "Empresa", disponibilidad: "Disponibilidad", transporte: "Transporte",
    area: "Area", experiencia: "Experiencia", turno_preferido: "Turno",
    ubicacion_entrevista: "Ubicacion entrevista",
  };
  return titulos[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "));
}

// Obtiene los campos capturados de un flujo, en el orden aproximado del canvas (x ascendente)
async function getFlowCaptureFields(flowId: string): Promise<string[]> {
  const { data: nodes } = await sb.from("nodes")
    .select("capture_field, x")
    .eq("flow_id", flowId)
    .not("capture_field", "is", null)
    .order("x", { ascending: true });
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const n of (nodes || [])) {
    if (n.capture_field && !seen.has(n.capture_field)) {
      seen.add(n.capture_field); fields.push(n.capture_field);
    }
  }
  return fields;
}

// Sincroniza UN contacto a su Google Sheet.
// forceNew = true → siempre agrega nueva fila (usar en reinicio de flujo)
// forceNew = false → actualiza fila existente si ya existe (comportamiento normal)
async function syncContactToSheet(phone: string, forceNew: boolean = false) {
  if (!GOOGLE_SA_JSON) return;
  try {
    const { data: contact } = await sb.from("contacts")
      .select("*, contact_data(field_key, field_value)").eq("phone", phone).maybeSingle();
    if (!contact) return;

    const { data: flow } = await sb.from("flows")
      .select("whatsapp_phone, name").eq("id", contact.flow_id).maybeSingle();
    if (!flow?.whatsapp_phone) return;

    const { data: waNumber } = await sb.from("wa_numbers")
      .select("google_sheet_id").eq("phone", flow.whatsapp_phone).maybeSingle();
    const sheetId = waNumber?.google_sheet_id;
    if (!sheetId) return;

    const datos: Record<string, string> = {};
    (contact.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

    // Columnas dinámicas: Telefono + Fecha + los campos que captura este flujo + Estatus
    const captureFields = await getFlowCaptureFields(contact.flow_id);
    const COLS = ["Telefono", "Fecha", ...captureFields.map(tituloCampo), "Estatus"];

    // Asegurar encabezado (si la hoja es nueva o cambió el flujo)
    const headerData = await sheetsGet(sheetId, `A1:${String.fromCharCode(65 + COLS.length - 1)}1`);
    const headerActual = headerData?.values?.[0] || [];
    if (JSON.stringify(headerActual) !== JSON.stringify(COLS)) {
      await sheetsUpdate(sheetId, "A1", [COLS]);
    }

    // Construir la fila
    const fecha = new Date(contact.created_at || Date.now()).toLocaleDateString("es-MX");
    const row = [
      String(phone),
      fecha,
      ...captureFields.map(f => datos[f] || ""),
      contact.status || "nuevo",
    ];

    if (forceNew) {
      // Reinicio: siempre agregar nueva fila con la fecha actual
      row[1] = new Date().toLocaleDateString("es-MX");
      await sheetsAppend(sheetId, "A1", [row]);
      console.log(`Sheets: nueva fila (reinicio) para ${phone}`);
    } else {
      // Normal: buscar y actualizar o agregar
      const colA = await sheetsGet(sheetId, "A2:A2000");
      const existentes: string[] = (colA?.values || []).map((r: any) => String(r[0] || "").trim());
      const phonePlain = String(phone).trim();
      const idx = existentes.findIndex(e =>
        e === phonePlain || e === "+" + phonePlain || "+" + e === phonePlain
      );
      if (idx >= 0) {
        await sheetsUpdate(sheetId, `A${idx + 2}`, [row]);
        console.log(`Sheets: actualizada fila ${idx + 2} para ${phone}`);
      } else {
        await sheetsAppend(sheetId, "A1", [row]);
        console.log(`Sheets: nueva fila para ${phone}`);
      }
    }
  } catch(e) {
    console.error("Error sincronizando a Google Sheets:", phone, e);
  }
}


// CAROUSEL — WhatsApp NO soporta carruseles en mensajes de sesión (solo en plantillas HSM aprobadas).
// Solución: enviar las imágenes una por una con su caption, luego los botones agrupados como pregunta.
async function sendCarousel(to: string, body: string, cards: any[], from: string, apiKey: string, nodeKey: string | null = null, delayMs = 1000) {
  if (!cards.length) return;

  // 1. Enviar el texto introductorio si existe
  if (body?.trim()) {
    await sendText(to, body.trim(), from, apiKey, nodeKey);
  }

  // 2. Enviar cada tarjeta como imagen + caption
  for (const card of cards) {
    const url  = card.header_url?.trim() || "";
    const text = card.body?.trim() || "";
    if (url) {
      // Imagen con texto como caption
      await sendImage(to, url, from, apiKey, text || undefined, nodeKey);
    } else if (text) {
      // Sin imagen — solo texto
      await sendText(to, text, from, apiKey, nodeKey);
    }
    // Pausa entre tarjetas para respetar el orden de entrega
    await sleep(delayMs);
  }

  // 3. Recopilar todos los botones únicos de todas las tarjetas
  const botones: { label: string; value: string }[] = [];
  const vistos = new Set<string>();
  for (const card of cards) {
    for (const btn of (card.buttons || [])) {
      if (btn.value && !vistos.has(btn.value)) {
        vistos.add(btn.value);
        botones.push({ label: btn.label, value: btn.value });
      }
    }
  }

  if (!botones.length) return;

  // 4. Mostrar los botones — hasta 3 como botones, más de 3 como lista
  const prompt = "Selecciona una opcion:";
  if (botones.length <= 3) {
    await sendButtons(to, prompt, botones, from, apiKey, nodeKey);
  } else {
    await sendList(to, prompt, "Ver opciones", "Opciones", botones, from, apiKey, nodeKey);
  }
}

async function resolveVariables(text: string, phone: string): Promise<string> {
  if (!text || !text.includes("{{")) return text;
  const { data: contact } = await sb.from("contacts").select("id").eq("phone", phone).maybeSingle();
  if (!contact) return text;
  const { data: fields } = await sb.from("contact_data").select("field_key, field_value").eq("contact_id", contact.id);
  let resolved = text;
  (fields || []).forEach((f: any) => {
    resolved = resolved.replace(new RegExp(`{{${f.field_key}}}`, "g"), f.field_value || "");
  });
  return resolved;
}

// ── Reiniciar flujo desde el nodo que el usuario asignó ──
async function handleRestart(phone: string, flowId: string, restartNode: any, cfg: FlowConfig) {
  // 1. Registrar la conversación actual como nueva fila en Sheets
  await syncContactToSheet(phone, true);

  // 2. Borrar datos capturados y sesión
  const { data: contact } = await sb.from("contacts").select("id").eq("phone", phone).maybeSingle();
  if (contact) {
    await sb.from("contact_data").delete().eq("contact_id", contact.id);
    await sb.from("contacts").update({ status: "nuevo", updated_at: new Date().toISOString() }).eq("phone", phone);
  }
  await sb.from("sessions").delete().eq("phone", phone);
  // Resetear el flag post_notified para que la notificación única vuelva a funcionar
  await sb.from("contacts").update({ post_notified: false }).eq("phone", phone);
  // 3. Encontrar el nodo destino:
  //    - Si el nodo restart tiene restart_node_key configurado → usar ese nodo
  //    - Si no → usar el nodo inicial del flujo (is_start)
  let targetNode: any = null;

  const targetKey = restartNode?.restart_node_key;
  if (targetKey) {
    const { data: specificNode } = await sb.from("nodes").select("*")
      .eq("flow_id", flowId).eq("node_key", targetKey).maybeSingle();
    targetNode = specificNode;
  }

  if (!targetNode) {
    const { data: startNode } = await sb.from("nodes").select("*")
      .eq("flow_id", flowId).eq("is_start", true).maybeSingle();
    targetNode = startNode;
  }

  if (!targetNode) {
    const { data: fallback } = await sb.from("nodes").select("*")
      .eq("flow_id", flowId).order("created_at", { ascending: true }).limit(1).maybeSingle();
    targetNode = fallback;
  }

  if (!targetNode) { console.log("No se encontró nodo para reinicio"); return; }

  // 4. Crear nueva sesión desde ese nodo
  await sb.from("sessions").insert({
    phone, flow_id: flowId, current_node: targetNode.node_key,
    updated_at: new Date().toISOString(),
  });

  // 5. Ejecutar el nodo destino
  const nodeToSend = { ...targetNode, content: await resolveVariables(targetNode.content, phone) };
  await executeNode(phone, nodeToSend, cfg);
  console.log(`Flujo reiniciado para ${phone} desde nodo: ${targetNode.node_key}`);
}

async function autoAdvanceNode(phone: string, node: any, cfg: FlowConfig) {
  console.log("autoAdvance desde:", node.node_key);
  const { data: session } = await sb.from("sessions").select("flow_id").eq("phone", phone).maybeSingle();
  if (!session) return;

  const { data: edge } = await sb.from("edges").select("*")
    .eq("flow_id", session.flow_id).eq("from_node", node.node_key).is("condition", null).maybeSingle();
  if (!edge) return;

  const { data: nextNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", edge.to_node).maybeSingle();
  if (!nextNode) return;

  await sb.from("sessions").update({ current_node: edge.to_node, updated_at: new Date().toISOString() }).eq("phone", phone);
  const nodeToSend = { ...nextNode, content: await resolveVariables(nextNode.content, phone) };
  await executeNode(phone, nodeToSend, cfg);

  if (nextNode.type === "end") {
    await sb.from("sessions").delete().eq("phone", phone);
    await sb.from("contacts").update({ status: "en_proceso", updated_at: new Date().toISOString() }).eq("phone", phone);
    await syncContactToSheet(phone);
    // Notificaciones automáticas al finalizar el flujo
    await enviarConfirmacionCandidato(phone, session.flow_id, cfg);
    await notificarReclutadorFinFlujo(phone, session.flow_id, cfg);
  }

  if (nextNode.type === "restart") {
    await handleRestart(phone, session.flow_id, nextNode, cfg);
  }
}

// Valida que una URL sea real antes de mandarla a yCloud
function esUrlValida(url: any): boolean {
  if (!url || typeof url !== "string") return false;
  const limpia = url.trim();
  return limpia.startsWith("https://") || limpia.startsWith("http://");
}

async function executeNode(phone: string, node: any, cfg: FlowConfig, autoAdvance = true) {
  console.log("executeNode:", node.node_key, "type:", node.type);
  const { from, apiKey } = cfg;
  // Pausa antes de enviar, para que no lleguen todos los mensajes de golpe.
  // Se descuenta de un presupuesto total para no agotar el tiempo del webhook.
  if (cfg.budgetMs === undefined) cfg.budgetMs = BUDGET_MAX_MS;
  const espera  = Math.max(0, Math.min(cfg.delayMs ?? 1000, cfg.budgetMs));
  if (espera > 0) { await sleep(espera); cfg.budgetMs -= espera; }
  const delayMs = espera;

  // ── CARRUSEL ──
  if (node.type === "carousel") {
    const cards = node.carousel_cards || [];
    await sendCarousel(phone, node.content || "", cards, from, apiKey, node.node_key, delayMs);
    // No auto-avanzar — esperar que el usuario toque un botón (como question)
    return;
  }

  if (node.media_urls?.length > 1) {
    // Filtrar solo URLs válidas para no tronar con yCloud
    const urlsValidas = node.media_urls.filter((u: any) => esUrlValida(u));
    if (urlsValidas.length === 0) {
      console.warn(`Nodo ${node.node_key}: media_urls sin URLs válidas, saltando imágenes`);
    }
    for (let i = 0; i < urlsValidas.length; i++) {
      const caption = i === 0 ? (node.content || "") : "";
      await sendImage(phone, urlsValidas[i].trim(), from, apiKey, caption, node.node_key);
      if (i < urlsValidas.length - 1) await sleep(delayMs);
    }
    if (node.options?.length) {
      await sendButtons(phone, "Elige una opción:", node.options, from, apiKey, node.node_key);
    } else if (autoAdvance) {
      await autoAdvanceNode(phone, node, cfg);
    }
    return;
  }

  if (esUrlValida(node.media_url)) {
    await sendImage(phone, node.media_url.trim(), from, apiKey, node.content || "", node.node_key);
    if (node.options?.length) {
      await sendButtons(phone, "Elige una opción:", node.options, from, apiKey, node.node_key);
    } else if (autoAdvance) {
      await autoAdvanceNode(phone, node, cfg);
    }
    return;
  }

  // Si el nodo era de tipo media pero la URL no es válida, igual avanza el flujo
  // para que el candidato no se quede atascado esperando una imagen que no llega
  if (node.media_url !== undefined && node.type === "media") {
    console.warn(`Nodo ${node.node_key}: media_url inválida ("${node.media_url}"), avanzando flujo sin imagen`);
    if (node.content) await sendText(phone, node.content, from, apiKey, node.node_key);
    if (autoAdvance) await autoAdvanceNode(phone, node, cfg);
    return;
  }

  if (node.type === "list" && node.options?.length) {
    await sendList(
      phone,
      node.content || "Elige una opcion:",
      node.list_button || "Ver opciones",
      node.list_section || "Opciones",
      node.options,
      from, apiKey, node.node_key
    );
    return;
  }

  if (node.options?.length) {
    await sendButtons(phone, node.content || "Elige una opción:", node.options, from, apiKey, node.node_key);
    return;
  }

  if (node.content) await sendText(phone, node.content, from, apiKey, node.node_key);

  if (node.type === "message" && autoAdvance) {
    await autoAdvanceNode(phone, node, cfg);
  }
}

// ============================================================
// PROCESO PRINCIPAL
// ============================================================
// ── Confirmación al CANDIDATO cuando termina el flujo ──
// Envía un mensaje personalizable configurado en el flujo (dirección, nombre del asesor, etc.)
async function enviarConfirmacionCandidato(phone: string, flowId: string, cfg: FlowConfig) {
  try {
    const { data: flow } = await sb.from("flows")
      .select("interview_address, recruiter_name, confirm_msg, name")
      .eq("id", flowId).maybeSingle();

    // Solo enviar si hay al menos una dirección o un mensaje personalizado configurado
    if (!flow?.confirm_msg && !flow?.interview_address) return;

    const { data: contact } = await sb.from("contacts")
      .select("*, contact_data(field_key, field_value)").eq("phone", phone).maybeSingle();
    const datos: Record<string, string> = {};
    (contact?.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

    const plantillaDefault = `Hola ${datos.nombre || "candidato"}, gracias por registrarte.${
      flow.recruiter_name ? `\n\nTu asesor asignado es *${flow.recruiter_name}*, quien se pondrá en contacto contigo pronto.` : ""
    }${
      flow.interview_address ? `\n\n*Dirección de la empresa:*\n${flow.interview_address}` : ""
    }\n\nCualquier duda puedes escribirnos aquí.`;

    const mensaje = flow.confirm_msg
      ? flow.confirm_msg
          .replace(/\{\{nombre\}\}/g, datos.nombre || "")
          .replace(/\{\{puesto\}\}/g, datos.puesto || "")
          .replace(/\{\{disponibilidad\}\}/g, datos.disponibilidad || "")
          .replace(/\{\{municipio\}\}/g, datos.municipio || "")
          .replace(/\{\{asesor\}\}/g, flow.recruiter_name || "")
          .replace(/\{\{direccion\}\}/g, flow.interview_address || "")
      : plantillaDefault;

    await sendText(phone, mensaje, cfg.from, cfg.apiKey, "confirmacion_entrevista");
    console.log(`Confirmación enviada a candidato ${phone}`);
  } catch(e) {
    console.error("Error enviando confirmación al candidato:", e);
  }
}

// ── Resumen al RECLUTADOR cuando un candidato termina el flujo ──
async function notificarReclutadorFinFlujo(phone: string, flowId: string, cfg: FlowConfig) {
  try {
    const { data: flow } = await sb.from("flows")
      .select("name, notify_phone, recruiter_name")
      .eq("id", flowId).maybeSingle();

    const notifyPhones = (flow?.notify_phone || '')
      .split(/[,\n]/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 6);

    if (!notifyPhones.length) {
      console.log(`Sin notify_phone en flujo ${flowId} — omitiendo notificación`);
      return;
    }

    // Datos capturados del candidato
    const { data: contact } = await sb.from("contacts")
      .select("*, contact_data(field_key, field_value)")
      .eq("phone", phone).maybeSingle();

    const datos: Record<string, string> = {};
    (contact?.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

    // Mensaje con el formato exacto solicitado
    const msg = [
      `*Reclutador:* ${flow?.recruiter_name || flow?.name || "—"}`,
      `*Nombre:* ${datos.nombre || "—"}`,
      `*Telefono:* ${phone}`,
      `*Puesto:* ${datos.puesto || "—"}`,
      `*Fecha de cita:* ${datos.disponibilidad || "—"}`,
    ].join("\n");

    for (const notifyPhone of notifyPhones) {
      const res = await fetch(YCLOUD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": cfg.apiKey },
        body: JSON.stringify({ from: cfg.from, to: notifyPhone, type: "text", text: { body: msg } })
      });
      const resText = await res.text();
      console.log(`Notificacion a ${notifyPhone}: ${res.status} ${resText.slice(0, 100)}`);
    }
  } catch(e) {
    console.error("Error en notificarReclutadorFinFlujo:", e);
  }
}

// ── Notificación WhatsApp cuando llega candidato nuevo ──
async function notificarCandidatoNuevo(candidatoPhone: string, waPhone: string, apiKey: string) {
  // Buscar usuarios que tienen este número asignado y tienen notify_phone configurado
  const { data: usuarios } = await sb.from("app_users")
    .select("notify_phone, full_name")
    .eq("is_active", true);

  const yaNotificados = new Set<string>();
  for (const u of (usuarios || [])) {
    const phones: string[] = u.assigned_phones || [];
    const esAdmin = !phones.length; // admin ve todos
    const tieneNumero = esAdmin || phones.some((p: string) =>
      p === waPhone || p === waPhone.replace(/^\+/, '') || '+' + p === waPhone
    );
    if (!tieneNumero || !u.notify_phone) continue;
    if (yaNotificados.has(u.notify_phone)) continue;
    yaNotificados.add(u.notify_phone);

    const msg = `Nuevo candidato en tu flujo.\n\nNúmero: ${candidatoPhone}\nHora: ${new Date().toLocaleString('es-MX', { timeZone: 'America/Monterrey' })}`;
    await fetch(YCLOUD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ from: waPhone, to: u.notify_phone, type: "text", text: { body: msg } })
    }).catch(e => console.error("Error notificando a", u.notify_phone, e));
  }
}

async function processMessage(phone: string, userMessage: string, toPhone: string, inboundId = "") {
  console.log("processMessage — phone:", phone, "msg:", userMessage, "to:", toPhone);

  // Normalizar toPhone una sola vez aquí para usar en todo el proceso
  const toPhoneNorm  = toPhone.startsWith('+') ? toPhone : '+' + toPhone;
  const toPhonePlain = toPhone.replace(/^\+/, '');

  // Buscar sesión por phone — si existe, verificar que sea del mismo número de WA
  // para no mezclar flujos de números distintos
  const { data: sessionRaw } = await sb.from("sessions").select("*")
    .eq("phone", phone).maybeSingle();

  // Aceptar la sesión solo si corresponde al mismo número de WA que recibió el mensaje
  let session: any = null;
  if (sessionRaw) {
    const sToPhone = sessionRaw.to_phone || "";
    const mismoNumero = !sToPhone                         // sesión vieja sin to_phone: aceptar
      || sToPhone === toPhoneNorm
      || sToPhone === toPhonePlain;
    if (mismoNumero) {
      session = sessionRaw;
    } else {
      console.log(`Sesión de ${phone} pertenece a ${sToPhone}, no a ${toPhone} — ignorando sesión`);
    }
  }

  console.log("session:", JSON.stringify(session));

  if (!session) {
    // Si ya existe un contacto que completo su registro anteriormente, no reiniciar
    // el flujo desde cero — eso le borraba el estatus y lo regresaba a "nuevo".
    const { data: contactoExistente } = await sb.from("contacts")
      .select("status, flow_id, post_notified").eq("phone", phone).maybeSingle();

    const estatusFinalizados = ["en_proceso", "contratado", "rechazado", "descartado", "no_responde"];
    if (contactoExistente && estatusFinalizados.includes(contactoExistente.status)) {

      // ── Verificar que el contacto existente pertenece a ESTE número de WhatsApp ──
      // Si completó registro en otro número (otra empresa), dejarlo registrarse aquí
      let esMismoNumero = true;
      if (contactoExistente.flow_id) {
        const { data: flowExistente } = await sb.from("flows")
          .select("whatsapp_phone").eq("id", contactoExistente.flow_id).maybeSingle();
        const waExistente = flowExistente?.whatsapp_phone || "";
        if (waExistente) {
          esMismoNumero = waExistente === toPhoneNorm || waExistente === toPhonePlain;
        }
      }

      if (!esMismoNumero) {
        // Candidato escribió a un número diferente (otra empresa) — no bloquearlo
        console.log(`${phone} completó registro en otro número → permitiendo nuevo registro en ${toPhone}`);
        // Continuar hacia el bloque de nuevo flujo (no hacer return)
      } else {
        // Candidato que ya terminó el flujo escribe de nuevo
        // Solo se registra en el log, sin respuesta automática
        await sb.from("message_log").insert({
          phone, direction: "in", content: userMessage, node_key: "post_registro",
        }).catch(() => {});
        console.log(`[POST-REGISTRO] Mensaje de ${phone} registrado silenciosamente`);
        return;
      }
    }

    let { data: flow } = await sb.from("flows").select("id, whatsapp_phone, ycloud_api_key")
      .eq("is_active", true).eq("whatsapp_phone", toPhoneNorm).maybeSingle();

    if (!flow) {
      const { data: flow2 } = await sb.from("flows").select("id, whatsapp_phone, ycloud_api_key")
        .eq("is_active", true).eq("whatsapp_phone", toPhonePlain).maybeSingle();
      flow = flow2;
    }

    // Sin fallback a "cualquier flujo activo" — si el número no tiene flujo
    // asignado, el mensaje se ignora. Esto evita que un número responda
    // con el flujo de otro cliente.
    console.log("flow encontrado para", toPhone, ":", flow?.id || "NINGUNO");
    if (!flow) {
      console.log("NO ACTIVE FLOW para el número", toPhone, "— mensaje ignorado");
      return;
    }

    const cfg: FlowConfig = {
      from: flow.whatsapp_phone || toPhoneNorm,
      apiKey: flow.ycloud_api_key || YCLOUD_KEY_FALLBACK,
      delayMs: normalizarDelay(flow.message_delay ?? 1),
      budgetMs: BUDGET_MAX_MS,
    };

    // Doble check azul + "escribiendo..." también en el primer mensaje
    await marcarLeidoYEscribiendo(inboundId, cfg.apiKey);

    let { data: firstNode } = await sb.from("nodes").select("*")
      .eq("flow_id", flow.id).eq("is_start", true).maybeSingle();

    if (!firstNode) {
      const { data: fallback } = await sb.from("nodes").select("*")
        .eq("flow_id", flow.id).order("created_at", { ascending: true }).limit(1).maybeSingle();
      firstNode = fallback;
    }

    if (!firstNode) { console.log("NO NODES"); return; }

    await sb.from("contacts").upsert(
      { phone, flow_id: flow.id, status: "nuevo", updated_at: new Date().toISOString() },
      { onConflict: "phone" }
    );
    // Guardar sesión — usar onConflict "phone" (el índice que ya existe en la BD)
    await sb.from("sessions").upsert(
      { phone, to_phone: toPhoneNorm, flow_id: flow.id, current_node: firstNode.node_key, updated_at: new Date().toISOString() },
      { onConflict: "phone" }
    );

    const nodeToSend = { ...firstNode, content: await resolveVariables(firstNode.content, phone) };
    await executeNode(phone, nodeToSend, cfg);
    return;
  }

  const cfg = await getFlowConfig(session.flow_id, toPhone);

  // Doble check azul + "escribiendo..." antes de responder
  await marcarLeidoYEscribiendo(inboundId, cfg.apiKey);

  await sb.from("message_log").insert({
    phone, direction: "in", content: userMessage, node_key: session.current_node,
  });

  const { data: currentNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", session.current_node).maybeSingle();
  console.log("currentNode:", JSON.stringify(currentNode));

  if (currentNode?.capture_field) {
    const { data: contact } = await sb.from("contacts").select("id").eq("phone", phone).maybeSingle();
    if (contact) {
      if (currentNode.capture_strict) {
        // PASO 1 — Validación local por reglas (siempre funciona, sin depender de APIs)
        const local = validarLocal(currentNode.capture_field, userMessage.trim(), currentNode);
        if (!local.valido) {
          await sendText(phone, local.error, cfg.from, cfg.apiKey, session.current_node);
          console.log(`[STRICT-LOCAL] Rechazado [${currentNode.capture_field}]: "${userMessage}"`);
          return; // No guardar, no avanzar — re-pregunta
        }

        // PASO 2 — Validación con DeepSeek (capa extra). Si la API falla, ya pasó la local.
        const validacion = await validarRespuesta(
          currentNode.capture_field,
          currentNode.content || '',
          userMessage.trim()
        );
        if (!validacion.valido) {
          const mensajeError = validacion.error ||
            `Disculpa, no alcancé a registrar el dato. ¿Me lo puedes escribir por favor?`;
          await sendText(phone, mensajeError, cfg.from, cfg.apiKey, session.current_node);
          console.log(`[STRICT-IA] Rechazado [${currentNode.capture_field}]: "${userMessage}"`);
          return;
        }
      }

      // Guardar el dato (validado o libre)
      const normalizedValue = await normalizeField(currentNode.capture_field, userMessage.trim());
      await sb.from("contact_data").upsert(
        { contact_id: contact.id, field_key: currentNode.capture_field, field_value: normalizedValue },
        { onConflict: "contact_id,field_key" }
      );
      console.log(`Captured [${currentNode.capture_field}${currentNode.capture_strict ? " strict" : ""}]: "${normalizedValue}"`);

      // Si es la fecha de la cita, se guarda también como fecha real para la agenda
      const campo = currentNode.capture_field.toLowerCase();
      if (campo.includes("disponibilidad") || campo.includes("fecha") || campo.includes("cita")) {
        guardarCita(phone, normalizedValue).catch(e => console.error("guardarCita:", e));
      }
    }
  }

  // ── ESTATUS POR OPCIÓN ──
  // Si la opción elegida tiene un estatus configurado en el editor de flujos,
  // el candidato cambia a ese estatus automáticamente (ej: "no me queda la ruta" → Declino)
  if (Array.isArray(currentNode?.options) && userMessage) {
    const resp = userMessage.trim().toLowerCase();
    const elegida = currentNode.options.find((o: any) =>
      String(o.value ?? "").toLowerCase() === resp ||
      String(o.label ?? "").toLowerCase() === resp
    );
    if (elegida?.status) {
      await sb.from("contacts").update({
        status: elegida.status,
        updated_at: new Date().toISOString(),
      }).eq("phone", phone);
      console.log(`[ESTATUS-OPCION] ${phone} → ${elegida.status} (eligió "${elegida.label}")`);
    }
  }

  let { data: edge } = await sb.from("edges").select("*")
    .eq("flow_id", session.flow_id).eq("from_node", session.current_node)
    .ilike("condition", userMessage.trim()).maybeSingle();

  if (!edge) {
    const { data: freeEdge } = await sb.from("edges").select("*")
      .eq("flow_id", session.flow_id).eq("from_node", session.current_node)
      .is("condition", null).maybeSingle();
    edge = freeEdge;
  }

  if (!edge) {
    await sendText(phone, "No entendí tu respuesta. Por favor elige una de las opciones disponibles.", cfg.from, cfg.apiKey, session.current_node);
    return;
  }

  const { data: nextNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", edge.to_node).maybeSingle();
  if (!nextNode) { console.log("NEXT NODE NOT FOUND:", edge.to_node); return; }

  await sb.from("sessions").update({
    current_node: edge.to_node, updated_at: new Date().toISOString(),
  }).eq("phone", phone);

  const nodeToSend = { ...nextNode, content: await resolveVariables(nextNode.content, phone) };
  await executeNode(phone, nodeToSend, cfg);

  if (nextNode.type === "end") {
    await sb.from("sessions").delete().eq("phone", phone);

    // Respetar un estatus ya asignado por una opción del flujo (ej: Declino)
    const { data: actual } = await sb.from("contacts")
      .select("status").eq("phone", phone).maybeSingle();
    const yaDefinido = ESTATUS_FINALES.includes(String(actual?.status || ""));

    if (yaDefinido) {
      console.log(`[FIN] ${phone} conserva estatus "${actual?.status}" — no se marca en_proceso`);
      await sb.from("contacts").update({ updated_at: new Date().toISOString() }).eq("phone", phone);
      await syncContactToSheet(phone);
      // Sin cita ni notificación al reclutador: el candidato no continúa el proceso
      return;
    }

    await sb.from("contacts").update({
      status: "en_proceso", updated_at: new Date().toISOString(),
    }).eq("phone", phone);
    await syncContactToSheet(phone);
    // Notificaciones automáticas al finalizar el flujo
    await enviarConfirmacionCandidato(phone, session.flow_id, cfg);
    await notificarReclutadorFinFlujo(phone, session.flow_id, cfg);
  }

  if (nextNode.type === "restart") {
    await handleRestart(phone, session.flow_id, nextNode, cfg);
  }
}


// Estatus asignados a propósito (por opción del flujo) que el nodo final
// NO debe sobrescribir con "en_proceso"
const ESTATUS_FINALES = ["declino", "rechazado", "descartado", "contratado", "no_responde"];

// ============================================================
// WEBHOOK HANDLER
// ============================================================

// ============================================================
// EVENTOS DE YCLOUD (además del mensaje entrante)
// ============================================================

// Busca un número activo DISTINTO al afectado para poder mandar la alerta
async function buscarEmisorAlterno(phoneAfectado: string) {
  const { data } = await sb.from("flows")
    .select("whatsapp_phone, ycloud_api_key")
    .eq("is_active", true)
    .not("whatsapp_phone", "is", null);
  const f = (data || []).find((x: any) =>
    x.whatsapp_phone && x.whatsapp_phone !== phoneAfectado && x.ycloud_api_key);
  return f ? { from: f.whatsapp_phone, apiKey: f.ycloud_api_key } : null;
}

// Manda una alerta a los notify_phone de los flujos que usan ese número
async function alertarReclutadores(phoneAfectado: string, mensaje: string) {
  const { data: flows } = await sb.from("flows")
    .select("name, notify_phone, whatsapp_phone, ycloud_api_key")
    .eq("whatsapp_phone", phoneAfectado);

  const destinos = new Set<string>();
  (flows || []).forEach((f: any) => {
    (f.notify_phone || "").split(/[,\n]/)
      .map((x: string) => x.trim())
      .filter((x: string) => x.length > 6)
      .forEach((x: string) => destinos.add(x));
  });
  if (!destinos.size) { console.log("[ALERTA] sin notify_phone configurado"); return; }

  // Preferimos mandar desde otro número: el afectado puede estar caído
  const emisor = await buscarEmisorAlterno(phoneAfectado)
    || ((flows || [])[0]?.ycloud_api_key
        ? { from: (flows || [])[0].whatsapp_phone, apiKey: (flows || [])[0].ycloud_api_key }
        : null);
  if (!emisor) { console.log("[ALERTA] sin número disponible para enviar"); return; }

  for (const dest of destinos) {
    await sendText(dest, mensaje, emisor.from, emisor.apiKey, "alerta_sistema");
  }
}


// ── Alerta a TODOS los reclutadores (la cuenta afecta a todos los números) ──
async function alertarTodos(mensaje: string) {
  const { data: flows } = await sb.from("flows")
    .select("notify_phone, whatsapp_phone, ycloud_api_key, is_active");

  const destinos = new Set<string>();
  (flows || []).forEach((f: any) => {
    (f.notify_phone || "").split(/[,\n]/)
      .map((x: string) => x.trim())
      .filter((x: string) => x.length > 6)
      .forEach((x: string) => destinos.add(x));
  });
  if (!destinos.size) { console.log("[ALERTA-GLOBAL] sin notify_phone configurado"); return; }

  const emisor = (flows || []).find((f: any) => f.is_active && f.whatsapp_phone && f.ycloud_api_key)
              || (flows || []).find((f: any) => f.whatsapp_phone && f.ycloud_api_key);
  if (!emisor) { console.log("[ALERTA-GLOBAL] sin número disponible"); return; }

  for (const dest of destinos) {
    await sendText(dest, mensaje, emisor.whatsapp_phone, emisor.ycloud_api_key, "alerta_sistema");
  }
}

// ── whatsapp.business_account.updated → restricción, baneo o violación ──
async function eventoCuentaActualizada(ba: any) {
  if (!ba) return;
  const evento     = String(ba.updateEvent || "").toUpperCase();
  const banState   = String(ba.banState || "").toUpperCase();
  const revision   = String(ba.accountReviewStatus || "").toUpperCase();
  const violacion  = ba.violationType;
  const restric    = Array.isArray(ba.restrictions) ? ba.restrictions : [];

  console.log(`[CUENTA] ${ba.name || ba.id}: evento=${evento} ban=${banState} revision=${revision}`);

  // Solo alertamos cuando hay algo que atender
  const grave =
    ["ACCOUNT_RESTRICTION", "ACCOUNT_VIOLATION", "ACCOUNT_BANNED", "PARTNER_APP_UNINSTALLED"].includes(evento)
    || (banState && banState !== "NOT_BANNED")
    || revision === "REJECTED"
    || restric.length > 0
    || ba.removed === true;
  if (!grave) { console.log("[CUENTA] cambio sin importancia, ignorado"); return; }

  let msg = `🚨 *ALERTA DE CUENTA — CAUCE IA*\n\n`;
  msg += `Meta reportó un cambio en la cuenta de WhatsApp Business`;
  msg += ba.name ? ` *${ba.name}*.\n\n` : `.\n\n`;
  if (evento)    msg += `• Evento: *${evento}*\n`;
  if (violacion) msg += `• Tipo de violación: *${violacion}*\n`;
  if (banState && banState !== "NOT_BANNED") {
    msg += `• Estado de baneo: *${banState}*\n`;
    if (ba.banDate) msg += `• Fecha: *${ba.banDate}*\n`;
  }
  if (revision) msg += `• Revisión de la cuenta: *${revision}*\n`;
  if (ba.removed) {
    msg += `• La cuenta fue *removida del partner*\n`;
    if (ba.removedReason) msg += `• Motivo: *${ba.removedReason}*\n`;
  }
  restric.forEach((r: any) => {
    msg += `• Restricción: *${r.restrictionType}*`;
    msg += r.expiration ? ` (hasta ${String(r.expiration).slice(0, 10)})\n` : `\n`;
  });
  msg += `\n⚠️ _Esto puede afectar a *todos* los números. Revisa el WhatsApp Manager de Meta cuanto antes._`;

  await alertarTodos(msg);
}

// ── whatsapp.business_account.deleted → la cuenta completa desapareció ──
async function eventoCuentaEliminada(ba: any) {
  console.log(`[CUENTA-ELIMINADA] ${ba?.name || ba?.id || "desconocida"}`);
  const msg =
    `🛑 *CUENTA DE WHATSAPP ELIMINADA — CAUCE IA*\n\n` +
    `La cuenta de WhatsApp Business${ba?.name ? ` *${ba.name}*` : ""} fue eliminada.\n\n` +
    (ba?.removedReason ? `• Motivo: *${ba.removedReason}*\n` : "") +
    `\n🔴 *Todos los chatbots de esta cuenta dejaron de funcionar.* ` +
    `Hay que revisar de inmediato en yCloud y en el WhatsApp Manager de Meta.`;
  await alertarTodos(msg);
}


// ── whatsapp.smb.message.echoes → mensaje enviado desde la app del celular ──
async function eventoEchoCelular(m: any) {
  const to = m?.to;
  if (!to) return;

  let contenido = "";
  if (m.type === "text") {
    contenido = m.text?.body || "";
  } else {
    const med = extraerMedia(m);
    if (med) {
      const { data: fl } = await sb.from("flows")
        .select("ycloud_api_key").eq("whatsapp_phone", m.from).maybeSingle();
      const url = await guardarMedia(med.url, fl?.ycloud_api_key || YCLOUD_KEY_FALLBACK, to);
      const etiqueta = med.tipo === "image" || med.tipo === "sticker" ? "[Imagen]"
                     : med.tipo === "video" ? "[Video]"
                     : med.tipo === "audio" || med.tipo === "voice" ? "[Audio]" : "[Archivo]";
      contenido = `${etiqueta} ${url || ""}${med.caption ? "\n" + med.caption : ""}`;
    } else {
      contenido = `[${m.type || "mensaje"}]`;
    }
  }
  if (!contenido) return;

  await sb.from("message_log").insert({
    phone: to, direction: "out", content: contenido,
    node_key: "desde_celular", wamid: m.wamid || m.id || null,
    status: m.status || "sent",
  }).catch(() => {});
  console.log(`[ECHO] mensaje del celular a ${to} registrado`);
}

// ── whatsapp.smb.history → historial previo al conectar el número ──
async function eventoHistorialCelular(h: any) {
  const mensajes = h?.messages || h?.history || [];
  if (!Array.isArray(mensajes) || !mensajes.length) {
    console.log("[HISTORIAL] sin mensajes o el negocio no compartió el historial");
    return;
  }
  const filas = mensajes.slice(0, 500).map((m: any) => ({
    phone: m.from === h.displayPhoneNumber ? m.to : m.from,
    direction: m.from === h.displayPhoneNumber ? "out" : "in",
    content: m.text?.body || `[${m.type || "mensaje"}]`,
    node_key: "historial_celular",
    wamid: m.wamid || m.id || null,
    created_at: m.sendTime || m.createTime || new Date().toISOString(),
  })).filter((f: any) => f.phone);

  if (filas.length) {
    await sb.from("message_log").insert(filas).catch(() => {});
    console.log(`[HISTORIAL] ${filas.length} mensajes importados`);
  }
}

// ── whatsapp.message.updated → estatus real de cada mensaje ──
async function eventoMensajeActualizado(m: any) {
  const wamid = m?.wamid || m?.id;
  if (!wamid || !m?.status) return;

  const errorMsg = m.errorCode
    ? `${m.errorCode}: ${m.errorMessage || ""}`.slice(0, 500)
    : null;

  const { error } = await sb.from("message_log")
    .update({ status: m.status, error_detail: errorMsg })
    .eq("wamid", wamid);

  console.log(`[MSG-UPDATE] ${wamid} → ${m.status}${error ? " (error: " + error.message + ")" : ""}`);
}

// ── whatsapp.phone_number.quality_updated → alerta de calidad ──
async function eventoCalidadNumero(pn: any) {
  const phone   = pn?.phoneNumber;
  const calidad = pn?.qualityRating;
  const estado  = pn?.status;
  if (!phone) return;

  console.log(`[CALIDAD] ${phone}: ${calidad} / ${estado} / limite ${pn?.whatsappBusinessManagerMessagingLimit || "-"}`);

  // Solo avisamos cuando hay algo que atender
  const preocupante = ["YELLOW", "RED"].includes(String(calidad).toUpperCase())
                   || (estado && String(estado).toUpperCase() !== "CONNECTED");
  if (!preocupante) return;

  const icono = String(calidad).toUpperCase() === "RED" ? "🔴"
              : String(calidad).toUpperCase() === "YELLOW" ? "🟡" : "⚠️";

  const msg =
    `${icono} *ALERTA DE CALIDAD — CAUCE IA*\n\n` +
    `El número *${pn.displayPhoneNumber || phone}* cambió de estado:\n\n` +
    `• Calidad: *${calidad || "—"}*\n` +
    `• Estado: *${estado || "—"}*\n` +
    (pn.whatsappBusinessManagerMessagingLimit ? `• Límite de mensajes: *${pn.whatsappBusinessManagerMessagingLimit}*\n` : "") +
    `\n_Meta baja la calidad cuando varios candidatos bloquean o reportan el número. ` +
    `Si llega a rojo se restringe el envío._`;

  await alertarReclutadores(phone, msg);
}

// ── whatsapp.phone_number.deleted → el número se desvinculó ──
async function eventoNumeroEliminado(pn: any) {
  const phone = pn?.phoneNumber;
  if (!phone) return;
  console.log(`[NUMERO-ELIMINADO] ${phone}`);

  const msg =
    `🛑 *NÚMERO DESVINCULADO — CAUCE IA*\n\n` +
    `El número *${pn.displayPhoneNumber || phone}* fue eliminado de yCloud o de Meta.\n\n` +
    `El chatbot de este número *dejó de funcionar*. Hay que revisarlo en el panel de yCloud.`;

  await alertarReclutadores(phone, msg);
}

// ── whatsapp.user.preferences → el candidato pidió no recibir más ──
async function eventoPreferenciaUsuario(up: any) {
  const phone = up?.contactPhoneNumber;
  const valor = String(up?.value || "").toLowerCase();
  if (!phone) return;

  const detiene = valor === "stop";
  console.log(`[PREFERENCIA] ${phone} → ${valor}`);

  await sb.from("contacts").update({
    opted_out: detiene,
    notes: detiene
      ? "El candidato pidió dejar de recibir mensajes (opt-out de WhatsApp)"
      : null,
    updated_at: new Date().toISOString(),
  }).eq("phone", phone);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method === "GET") return new Response("OK", { status: 200, headers: corsHeaders });

  try {
    const body = await req.json();
    console.log("Body:", JSON.stringify(body));

    // ── Eventos que NO son mensajes entrantes ──
    const tipoEvento = body?.type || "";
    if (tipoEvento && tipoEvento !== "whatsapp.inbound_message.received") {
      console.log("Evento recibido:", tipoEvento);
      try {
        if (tipoEvento === "whatsapp.message.updated" && body.whatsappMessage) {
          await eventoMensajeActualizado(body.whatsappMessage);
        } else if (tipoEvento === "whatsapp.phone_number.quality_updated") {
          await eventoCalidadNumero(body.whatsappPhoneNumber);
        } else if (tipoEvento === "whatsapp.phone_number.deleted") {
          await eventoNumeroEliminado(body.whatsappPhoneNumber);
        } else if (tipoEvento === "whatsapp.user.preferences") {
          await eventoPreferenciaUsuario(body.whatsappUserPreference);
        } else if (tipoEvento === "whatsapp.business_account.updated") {
          await eventoCuentaActualizada(body.whatsappBusinessAccount);
        } else if (tipoEvento === "whatsapp.business_account.deleted") {
          await eventoCuentaEliminada(body.whatsappBusinessAccount);
        } else if (tipoEvento === "whatsapp.smb.message.echoes") {
          await eventoEchoCelular(body.whatsappMessage);
        } else if (tipoEvento === "whatsapp.smb.history") {
          await eventoHistorialCelular(body.whatsappHistory || body.history);
        } else {
          console.log("Evento sin manejador, ignorado:", tipoEvento);
        }
      } catch (e) {
        console.error("Error procesando evento", tipoEvento, e);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let phone = "", userMessage = "", toPhone = "", inboundId = "";
    let media: { url: string; caption: string; tipo: string } | null = null;

    if (body?.whatsappInboundMessage) {
      const msg = body.whatsappInboundMessage;
      phone     = msg.from || "";
      toPhone   = msg.to   || "";
      inboundId = msg.id || msg.wamid || "";
      if (msg.type === "text") userMessage = msg.text?.body || "";
      else if (msg.type === "interactive") {
        userMessage = msg.interactive?.button_reply?.id
          || msg.interactive?.list_reply?.id
          || msg.interactive?.button_reply?.title
          || msg.interactive?.list_reply?.title
          || "";
      }
      else if (msg.type === "button") userMessage = msg.button?.payload || msg.button?.text || "";
      else {
        media = extraerMedia(msg);
        if (media) userMessage = media.caption || "";
      }
    }

    if (!phone && body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const msg = body.entry[0].changes[0].value.messages[0];
      phone = msg.from || ""; toPhone = msg.to || "";
      inboundId = msg.id || "";
      if (!["text","interactive","button"].includes(msg.type)) {
        media = extraerMedia(msg);
        if (media && !userMessage) userMessage = media.caption || "";
      }
      userMessage = msg.text?.body || msg.interactive?.button_reply?.id || "";
    }

    if (!phone && body?.message) {
      const msg = body.message;
      phone = msg.from || ""; toPhone = msg.to || "";
      inboundId = msg.id || msg.wamid || "";
      if (!["text","interactive","button"].includes(msg.type)) {
        media = extraerMedia(msg);
        if (media && !userMessage) userMessage = media.caption || "";
      }
      if (msg.type === "text") userMessage = msg.text?.body || "";
      else if (msg.type === "interactive") userMessage = msg.interactive?.button_reply?.id || "";
      else if (msg.type === "button") userMessage = msg.button?.payload || "";
    }

    console.log("Parsed — phone:", phone, "to:", toPhone, "msg:", userMessage);

    if (phone && userMessage) {
      // Imagen o archivo recibido: se guarda y se registra en la conversación
      if (media) {
        const { data: fl } = await sb.from("flows")
          .select("ycloud_api_key").eq("whatsapp_phone", toPhone).maybeSingle();
        const key = fl?.ycloud_api_key || YCLOUD_KEY_FALLBACK;
        const urlFinal = await guardarMedia(media.url, key, phone);

        const etiqueta = media.tipo === "image" || media.tipo === "sticker" ? "[Imagen]"
                       : media.tipo === "video" ? "[Video]"
                       : media.tipo === "audio" || media.tipo === "voice" ? "[Audio]"
                       : "[Archivo]";
        await sb.from("message_log").insert({
          phone, direction: "in",
          content: `${etiqueta} ${urlFinal || ""}${media.caption ? "\n" + media.caption : ""}`,
          node_key: "media_recibida",
        }).catch(() => {});
        console.log(`[MEDIA-IN] ${media.tipo} de ${phone} registrado`);

        // Sin texto no se puede avanzar el flujo: solo queda registrado
        if (!media.caption) return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await processMessage(phone, userMessage, toPhone, inboundId);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
