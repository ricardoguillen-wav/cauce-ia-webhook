import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const YCLOUD_KEY   = Deno.env.get("YCLOUD_API_KEY")!;
const YCLOUD_URL   = "https://api.ycloud.com/v2/whatsapp/messages";
const DEEPSEEK_KEY = Deno.env.get("DEEPSEEK_API_KEY")!;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

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
    ciudad:      `El usuario respondió sobre su ciudad o municipio: "${rawValue}". Extrae SOLO el nombre del municipio en formato título. Si mencionan colonia o estado, ignóralos. Ejemplos: "vivo en apodaca nl" → "Apodaca", "soy de san pedro" → "San Pedro Garza García". Responde SOLO con el nombre, sin explicaciones.`,
    municipio:   `El usuario respondió sobre su municipio: "${rawValue}". Extrae SOLO el nombre del municipio en formato título. Responde SOLO con el nombre.`,
    puesto:      `El usuario respondió sobre el puesto que busca: "${rawValue}". Normaliza a un nombre de puesto profesional y conciso. Ejemplos: "quiero ser montacarguista" → "Montacarguista", "manejo montacargas" → "Montacarguista". Responde SOLO con el nombre del puesto.`,
    nombre:      `El usuario respondió con su nombre: "${rawValue}". Extrae SOLO el nombre completo en formato título. Ignora frases como "me llamo" o "soy". Responde SOLO con el nombre.`,
    experiencia: `El usuario respondió sobre sus años de experiencia: "${rawValue}". Extrae SOLO el número de años. Ejemplos: "tengo 3 años" → "3", "cinco años" → "5". Responde SOLO con el número.`,
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
// YCLOUD — Envío de mensajes
// ============================================================
async function getFromPhone(flowId: string): Promise<string> {
  const { data } = await sb.from("flows").select("whatsapp_phone").eq("id", flowId).maybeSingle();
  return data?.whatsapp_phone || "+526181239810";
}

async function sendText(to: string, text: string, from: string) {
  const payload = { from, to, type: "text", text: { body: text } };
  console.log("sendText payload:", JSON.stringify(payload));
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": YCLOUD_KEY },
    body: JSON.stringify(payload),
  });
  console.log("sendText response:", res.status, await res.text());
}

async function sendImage(to: string, url: string, from: string, caption?: string) {
  const payload: any = { from, to, type: "image", image: { link: url } };
  if (caption) payload.image.caption = caption;
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": YCLOUD_KEY },
    body: JSON.stringify(payload),
  });
  console.log("sendImage response:", res.status, await res.text());
}

async function sendButtons(to: string, text: string, options: { label: string; value: string }[], from: string) {
  const buttons = options.slice(0, 3).map((o) => ({
    type: "reply",
    reply: { id: o.value, title: o.label.slice(0, 20) },
  }));
  const payload = {
    from, to, type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons } },
  };
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": YCLOUD_KEY },
    body: JSON.stringify(payload),
  });
  console.log("sendButtons response:", res.status, await res.text());
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

async function autoAdvanceNode(phone: string, node: any, from: string) {
  console.log("autoAdvance desde:", node.node_key);
  const { data: session } = await sb.from("sessions").select("flow_id").eq("phone", phone).maybeSingle();
  if (!session) return;

  const { data: edge } = await sb.from("edges").select("*")
    .eq("flow_id", session.flow_id).eq("from_node", node.node_key).is("condition", null).maybeSingle();
  if (!edge) return;

  const { data: nextNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", edge.to_node).maybeSingle();
  if (!nextNode) return;

  await sb.from("sessions").update({
    current_node: edge.to_node, updated_at: new Date().toISOString()
  }).eq("phone", phone);

  const nodeToSend = { ...nextNode, content: await resolveVariables(nextNode.content, phone) };
  await executeNode(phone, nodeToSend, from);

  if (nextNode.type === "end") {
    await sb.from("sessions").delete().eq("phone", phone);
    await sb.from("contacts").update({
      status: "en_proceso", updated_at: new Date().toISOString()
    }).eq("phone", phone);
  }
}

async function executeNode(phone: string, node: any, from: string, autoAdvance = true) {
  console.log("executeNode:", node.node_key, "type:", node.type);

  if (node.media_url) {
    await sendImage(phone, node.media_url, from, node.content || "");
    if (node.options?.length) {
      await sendButtons(phone, "Elige una opción:", node.options, from);
    } else if (autoAdvance) {
      await autoAdvanceNode(phone, node, from);
    }
    return;
  }

  if (node.options?.length) {
    await sendButtons(phone, node.content || "Elige una opción:", node.options, from);
    return;
  }

  if (node.content) await sendText(phone, node.content, from);

  if (node.type === "message" && autoAdvance) {
    await autoAdvanceNode(phone, node, from);
  }
}

// ============================================================
// PROCESO PRINCIPAL
// ============================================================
async function processMessage(phone: string, userMessage: string, toPhone: string) {
  console.log("processMessage — phone:", phone, "msg:", userMessage, "to:", toPhone);

  // ── Verificar si el bot está pausado para este contacto ──
  const { data: contactCheck } = await sb.from("contacts")
    .select("bot_paused").eq("phone", phone).maybeSingle();
  if (contactCheck?.bot_paused) {
    console.log("Bot pausado para:", phone, "— ignorando mensaje");
    return;
  }

  const { data: session, error: se } = await sb.from("sessions").select("*").eq("phone", phone).maybeSingle();
  console.log("session:", JSON.stringify(session), "err:", JSON.stringify(se));

  if (!session) {
    // Buscar flujo activo por número receptor
    let { data: flow } = await sb.from("flows").select("id, whatsapp_phone")
      .eq("is_active", true).eq("whatsapp_phone", toPhone).maybeSingle();

    if (!flow) {
      const { data: anyFlow } = await sb.from("flows").select("id, whatsapp_phone")
        .eq("is_active", true).maybeSingle();
      flow = anyFlow;
    }

    console.log("flow:", JSON.stringify(flow));
    if (!flow) { console.log("NO ACTIVE FLOW"); return; }

    const from = await getFromPhone(flow.id);

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

    const nodeToSend = { ...firstNode, content: await resolveVariables(firstNode.content, phone) };
    await executeNode(phone, nodeToSend, from);
    return;
  }

  const from = await getFromPhone(session.flow_id);

  await sb.from("message_log").insert({
    phone, direction: "in", content: userMessage, node_key: session.current_node,
  });

  const { data: currentNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", session.current_node).maybeSingle();
  console.log("currentNode:", JSON.stringify(currentNode));

  // ── Capturar y normalizar con DeepSeek ──
  if (currentNode?.capture_field) {
    const { data: contact } = await sb.from("contacts").select("id").eq("phone", phone).maybeSingle();
    if (contact) {
      const normalizedValue = await normalizeField(currentNode.capture_field, userMessage.trim());
      await sb.from("contact_data").upsert(
        { contact_id: contact.id, field_key: currentNode.capture_field, field_value: normalizedValue },
        { onConflict: "contact_id,field_key" }
      );
      console.log(`Captured & normalized: ${currentNode.capture_field} = "${userMessage}" → "${normalizedValue}"`);
    }
  }

  // ── Buscar siguiente nodo ──
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
    await sendText(phone, "No entendí tu respuesta. Por favor elige una de las opciones disponibles.", from);
    return;
  }

  const { data: nextNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", edge.to_node).maybeSingle();
  if (!nextNode) { console.log("NEXT NODE NOT FOUND:", edge.to_node); return; }

  await sb.from("sessions").update({
    current_node: edge.to_node, updated_at: new Date().toISOString(),
  }).eq("phone", phone);

  const nodeToSend = { ...nextNode, content: await resolveVariables(nextNode.content, phone) };
  await executeNode(phone, nodeToSend, from);

  if (nextNode.type === "end") {
    await sb.from("sessions").delete().eq("phone", phone);
    await sb.from("contacts").update({
      status: "en_proceso", updated_at: new Date().toISOString(),
    }).eq("phone", phone);
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
      else if (msg.type === "interactive") userMessage = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "";
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
