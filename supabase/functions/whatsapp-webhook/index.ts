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
// CONFIGURACIÓN DEL FLUJO — número + API key propios
// ============================================================
type FlowConfig = { from: string; apiKey: string };

async function getFlowConfig(flowId: string): Promise<FlowConfig> {
  const { data } = await sb.from("flows")
    .select("whatsapp_phone, ycloud_api_key")
    .eq("id", flowId)
    .maybeSingle();

  return {
    from: data?.whatsapp_phone || "+526181239810",
    apiKey: data?.ycloud_api_key || YCLOUD_KEY_FALLBACK,
  };
}

// ============================================================
// YCLOUD — Envío de mensajes (cada llamada usa la API key de SU flujo)
// ============================================================
// Registra cada intento de envío saliente, con su estatus real (enviado/fallido)
async function logOutbound(to: string, content: string, nodeKey: string | null, ok: boolean, errorDetail: string | null) {
  try {
    await sb.from("message_log").insert({
      phone: to, direction: "out", content, node_key: nodeKey,
      status: ok ? "sent" : "failed",
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

const CORE_COLS = ["Telefono", "Nombre", "Estatus", "Flujo", "Fecha de registro", "Ultima actualizacion"];

function tituloCampo(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

// Sincroniza UN contacto a su Google Sheet correspondiente. Nunca lanza error
// hacia afuera — si Sheets falla, el chat debe seguir funcionando normal.
async function syncContactToSheet(phone: string) {
  if (!GOOGLE_SA_JSON) return; // integracion no configurada, no hacer nada
  try {
    const { data: contact } = await sb.from("contacts")
      .select("*, contact_data(field_key, field_value)").eq("phone", phone).maybeSingle();
    if (!contact) return;

    const { data: flow } = await sb.from("flows").select("whatsapp_phone, name").eq("id", contact.flow_id).maybeSingle();
    if (!flow?.whatsapp_phone) return;

    const { data: waNumber } = await sb.from("wa_numbers")
      .select("google_sheet_id").eq("phone", flow.whatsapp_phone).maybeSingle();
    const sheetId = waNumber?.google_sheet_id;
    if (!sheetId) return; // este numero no tiene libro asignado

    const datos: Record<string, string> = {};
    (contact.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

    // Leer encabezado actual (fila 1)
    const headerData = await sheetsGet(sheetId, "A1:Z1");
    let header: string[] = headerData?.values?.[0] || [];
    let headerNuevo = false;

    if (header.length === 0) {
      header = [...CORE_COLS];
      headerNuevo = true;
    }

    // Agregar columnas nuevas si aparecen campos que el encabezado no contempla
    for (const key of Object.keys(datos)) {
      const colName = tituloCampo(key);
      if (!header.includes(colName)) { header.push(colName); headerNuevo = true; }
    }

    if (headerNuevo) await sheetsUpdate(sheetId, "A1", [header]);

    // Construir la fila en el mismo orden que el encabezado
    const row = header.map((col) => {
      if (col === "Telefono") return phone;
      if (col === "Nombre") return datos["nombre"] || "";
      if (col === "Estatus") return contact.status || "";
      if (col === "Flujo") return flow.name || "";
      if (col === "Fecha de registro") return contact.created_at || "";
      if (col === "Ultima actualizacion") return new Date().toISOString();
      const key = col.toLowerCase().replace(/ /g, "_");
      return datos[key] ?? "";
    });

    // Buscar si el contacto ya tiene fila (columna A = telefono)
    const colA = await sheetsGet(sheetId, "A2:A2000");
    const existentes: string[] = (colA?.values || []).map((r: any) => r[0]);
    const idx = existentes.indexOf(phone);

    if (idx >= 0) {
      const rowNumber = idx + 2;
      await sheetsUpdate(sheetId, `A${rowNumber}`, [row]);
    } else {
      await sheetsAppend(sheetId, "A1", [row]);
    }
  } catch(e) {
    console.error("Error sincronizando a Google Sheets:", phone, e);
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
  }
}

async function executeNode(phone: string, node: any, cfg: FlowConfig, autoAdvance = true) {
  console.log("executeNode:", node.node_key, "type:", node.type);
  const { from, apiKey } = cfg;

  if (node.media_urls?.length > 1) {
    for (let i = 0; i < node.media_urls.length; i++) {
      const caption = i === 0 ? (node.content || "") : "";
      await sendImage(phone, node.media_urls[i], from, apiKey, caption, node.node_key);
      if (i < node.media_urls.length - 1) await new Promise(r => setTimeout(r, 800));
    }
    if (node.options?.length) {
      await sendButtons(phone, "Elige una opción:", node.options, from, apiKey, node.node_key);
    } else if (autoAdvance) {
      await autoAdvanceNode(phone, node, cfg);
    }
    return;
  }

  if (node.media_url) {
    await sendImage(phone, node.media_url, from, apiKey, node.content || "", node.node_key);
    if (node.options?.length) {
      await sendButtons(phone, "Elige una opción:", node.options, from, apiKey, node.node_key);
    } else if (autoAdvance) {
      await autoAdvanceNode(phone, node, cfg);
    }
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
async function processMessage(phone: string, userMessage: string, toPhone: string) {
  console.log("processMessage — phone:", phone, "msg:", userMessage, "to:", toPhone);

  const { data: session, error: se } = await sb.from("sessions").select("*").eq("phone", phone).maybeSingle();
  console.log("session:", JSON.stringify(session), "err:", JSON.stringify(se));

  if (!session) {
    // Si ya existe un contacto que completo su registro anteriormente, no reiniciar
    // el flujo desde cero — eso le borraba el estatus y lo regresaba a "nuevo".
    const { data: contactoExistente } = await sb.from("contacts")
      .select("status, flow_id").eq("phone", phone).maybeSingle();

    const estatusFinalizados = ["en_proceso", "contratado", "rechazado", "descartado", "no_responde"];
    if (contactoExistente && estatusFinalizados.includes(contactoExistente.status)) {
      const cfgExistente = await getFlowConfig(contactoExistente.flow_id);
      await sendText(
        phone,
        "Hola de nuevo! Tu registro ya quedo completo anteriormente. En breve alguien de nuestro equipo se pondra en contacto contigo.\n\nSi necesitas avisarnos algo en especifico sobre tu proceso, puedes escribirlo aqui y lo revisamos.",
        cfgExistente.from, cfgExistente.apiKey
      );
      await sb.from("message_log").insert({
        phone, direction: "in", content: userMessage, node_key: "post_registro",
      });
      return;
    }

    let { data: flow } = await sb.from("flows").select("id, whatsapp_phone, ycloud_api_key")
      .eq("is_active", true).eq("whatsapp_phone", toPhone).maybeSingle();

    if (!flow) {
      const { data: anyFlow } = await sb.from("flows").select("id, whatsapp_phone, ycloud_api_key")
        .eq("is_active", true).maybeSingle();
      flow = anyFlow;
    }

    console.log("flow:", JSON.stringify(flow));
    if (!flow) { console.log("NO ACTIVE FLOW"); return; }

    const cfg: FlowConfig = {
      from: flow.whatsapp_phone || "+526181239810",
      apiKey: flow.ycloud_api_key || YCLOUD_KEY_FALLBACK,
    };

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
    await sb.from("sessions").upsert(
      { phone, flow_id: flow.id, current_node: firstNode.node_key, updated_at: new Date().toISOString() },
      { onConflict: "phone" }
    );
    await syncContactToSheet(phone); // se espera para garantizar que quede guardado antes de responder

    const nodeToSend = { ...firstNode, content: await resolveVariables(firstNode.content, phone) };
    await executeNode(phone, nodeToSend, cfg);
    return;
  }

  const cfg = await getFlowConfig(session.flow_id);

  await sb.from("message_log").insert({
    phone, direction: "in", content: userMessage, node_key: session.current_node,
  });

  const { data: currentNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", session.current_node).maybeSingle();
  console.log("currentNode:", JSON.stringify(currentNode));

  if (currentNode?.capture_field) {
    const { data: contact } = await sb.from("contacts").select("id").eq("phone", phone).maybeSingle();
    if (contact) {
      const normalizedValue = await normalizeField(currentNode.capture_field, userMessage.trim());

      await sb.from("contact_data").upsert(
        { contact_id: contact.id, field_key: currentNode.capture_field, field_value: normalizedValue },
        { onConflict: "contact_id,field_key" }
      );
      console.log(`Captured & normalized: ${currentNode.capture_field} = "${userMessage}" → "${normalizedValue}"`);
      await syncContactToSheet(phone); // se espera para garantizar que quede guardado antes de responder
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
    await sb.from("contacts").update({
      status: "en_proceso", updated_at: new Date().toISOString(),
    }).eq("phone", phone);
    await syncContactToSheet(phone);
  }
}

// ============================================================
// WEBHOOK HANDLER
// ============================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method === "GET") return new Response("OK", { status: 200, headers: corsHeaders });

  try {
    const body = await req.json();
    console.log("Body:", JSON.stringify(body));

    let phone = "", userMessage = "", toPhone = "";

    if (body?.whatsappInboundMessage) {
      const msg = body.whatsappInboundMessage;
      phone   = msg.from || "";
      toPhone = msg.to   || "";
      if (msg.type === "text") userMessage = msg.text?.body || "";
      else if (msg.type === "interactive") {
        userMessage = msg.interactive?.button_reply?.id
          || msg.interactive?.list_reply?.id
          || msg.interactive?.button_reply?.title
          || msg.interactive?.list_reply?.title
          || "";
      }
      else if (msg.type === "button") userMessage = msg.button?.payload || msg.button?.text || "";
    }

    if (!phone && body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const msg = body.entry[0].changes[0].value.messages[0];
      phone = msg.from || ""; toPhone = msg.to || "";
      userMessage = msg.text?.body || msg.interactive?.button_reply?.id || "";
    }

    if (!phone && body?.message) {
      const msg = body.message;
      phone = msg.from || ""; toPhone = msg.to || "";
      if (msg.type === "text") userMessage = msg.text?.body || "";
      else if (msg.type === "interactive") userMessage = msg.interactive?.button_reply?.id || "";
      else if (msg.type === "button") userMessage = msg.button?.payload || "";
    }

    console.log("Parsed — phone:", phone, "to:", toPhone, "msg:", userMessage);

    if (phone && userMessage) {
      await processMessage(phone, userMessage, toPhone);
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
