import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const YCLOUD_KEY  = Deno.env.get("YCLOUD_API_KEY")!;
const YCLOUD_FROM = "+526181239810";
const YCLOUD_URL  = "https://api.ycloud.com/v2/whatsapp/messages";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function sendText(to: string, text: string) {
  const payload = { from: YCLOUD_FROM, to, type: "text", text: { body: text } };
  console.log("sendText payload:", JSON.stringify(payload));
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": YCLOUD_KEY },
    body: JSON.stringify(payload),
  });
  console.log("sendText response:", res.status, await res.text());
}

async function sendImage(to: string, url: string, caption?: string) {
  const payload: any = { from: YCLOUD_FROM, to, type: "image", image: { link: url } };
  if (caption) payload.image.caption = caption;
  console.log("sendImage payload:", JSON.stringify(payload));
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": YCLOUD_KEY },
    body: JSON.stringify(payload),
  });
  console.log("sendImage response:", res.status, await res.text());
}

async function sendButtons(to: string, text: string, options: { label: string; value: string }[]) {
  const buttons = options.slice(0, 3).map((o) => ({
    type: "reply",
    reply: { id: o.value, title: o.label.slice(0, 20) },
  }));
  const payload = {
    from: YCLOUD_FROM, to, type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons } },
  };
  console.log("sendButtons payload:", JSON.stringify(payload));
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

async function autoAdvanceNode(phone: string, node: any) {
  console.log("autoAdvance desde:", node.node_key);

  const { data: session } = await sb.from("sessions").select("flow_id").eq("phone", phone).maybeSingle();
  if (!session) return;

  const { data: edge } = await sb.from("edges").select("*")
    .eq("flow_id", session.flow_id)
    .eq("from_node", node.node_key)
    .is("condition", null)
    .maybeSingle();
  console.log("autoAdvance edge:", JSON.stringify(edge));
  if (!edge) return;

  const { data: nextNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id)
    .eq("node_key", edge.to_node)
    .maybeSingle();
  console.log("autoAdvance nextNode:", JSON.stringify(nextNode));
  if (!nextNode) return;

  await sb.from("sessions").update({
    current_node: edge.to_node,
    updated_at: new Date().toISOString(),
  }).eq("phone", phone);

  const nodeToSend = { ...nextNode, content: await resolveVariables(nextNode.content, phone) };
  await executeNode(phone, nodeToSend);

  if (nextNode.type === "end") {
    await sb.from("sessions").delete().eq("phone", phone);
    await sb.from("contacts").update({
      status: "en_proceso",
      updated_at: new Date().toISOString(),
    }).eq("phone", phone);
  }
}

async function executeNode(phone: string, node: any, autoAdvance = true) {
  console.log("executeNode:", node.node_key, "type:", node.type);

  if (node.media_url) {
    await sendImage(phone, node.media_url, node.content || "");
    if (node.options?.length) {
      await sendButtons(phone, "Elige una opción:", node.options);
    } else if (autoAdvance) {
      await autoAdvanceNode(phone, node);
    }
    return;
  }

  if (node.options?.length) {
    await sendButtons(phone, node.content || "Elige una opción:", node.options);
    return;
  }

  if (node.content) await sendText(phone, node.content);

  if (node.type === "message" && autoAdvance) {
    await autoAdvanceNode(phone, node);
  }
}

async function processMessage(phone: string, userMessage: string) {
  console.log("processMessage — phone:", phone, "msg:", userMessage);

  const { data: session, error: se } = await sb.from("sessions").select("*").eq("phone", phone).maybeSingle();
  console.log("session:", JSON.stringify(session), "err:", JSON.stringify(se));

  if (!session) {
    const { data: flow, error: fe } = await sb.from("flows").select("id").eq("is_active", true).maybeSingle();
    console.log("flow:", JSON.stringify(flow), "err:", JSON.stringify(fe));
    if (!flow) { console.log("NO ACTIVE FLOW"); return; }

    let { data: firstNode } = await sb.from("nodes").select("*")
      .eq("flow_id", flow.id).eq("is_start", true).maybeSingle();
    console.log("firstNode (is_start):", JSON.stringify(firstNode));

    if (!firstNode) {
      console.log("No is_start — fallback por created_at");
      const { data: fallback } = await sb.from("nodes").select("*")
        .eq("flow_id", flow.id).order("created_at", { ascending: true }).limit(1).maybeSingle();
      firstNode = fallback;
    }

    console.log("firstNode final:", JSON.stringify(firstNode));
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
    await executeNode(phone, nodeToSend);
    return;
  }

  console.log("Session found — node:", session.current_node);
  await sb.from("message_log").insert({
    phone, direction: "in", content: userMessage, node_key: session.current_node,
  });

  const { data: currentNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", session.current_node).maybeSingle();
  console.log("currentNode:", JSON.stringify(currentNode));

  if (currentNode?.capture_field) {
    const { data: contact } = await sb.from("contacts").select("id").eq("phone", phone).maybeSingle();
    if (contact) {
      await sb.from("contact_data").upsert(
        { contact_id: contact.id, field_key: currentNode.capture_field, field_value: userMessage.trim() },
        { onConflict: "contact_id,field_key" }
      );
      console.log("Captured:", currentNode.capture_field, "=", userMessage.trim());
    }
  }

  let { data: edge } = await sb.from("edges").select("*")
    .eq("flow_id", session.flow_id).eq("from_node", session.current_node)
    .ilike("condition", userMessage.trim()).maybeSingle();
  console.log("edge (condition):", JSON.stringify(edge));

  if (!edge) {
    const { data: freeEdge } = await sb.from("edges").select("*")
      .eq("flow_id", session.flow_id).eq("from_node", session.current_node)
      .is("condition", null).maybeSingle();
    console.log("freeEdge:", JSON.stringify(freeEdge));
    edge = freeEdge;
  }

  if (!edge) {
    console.log("NO EDGE FOUND");
    await sendText(phone, "No entendí tu respuesta. Por favor elige una de las opciones disponibles.");
    return;
  }

  const { data: nextNode } = await sb.from("nodes").select("*")
    .eq("flow_id", session.flow_id).eq("node_key", edge.to_node).maybeSingle();
  console.log("nextNode:", JSON.stringify(nextNode));
  if (!nextNode) { console.log("NEXT NODE NOT FOUND:", edge.to_node); return; }

  await sb.from("sessions").update({
    current_node: edge.to_node,
    updated_at: new Date().toISOString(),
  }).eq("phone", phone);

  const nodeToSend = { ...nextNode, content: await resolveVariables(nextNode.content, phone) };
  await executeNode(phone, nodeToSend);

  if (nextNode.type === "end") {
    await sb.from("sessions").delete().eq("phone", phone);
    await sb.from("contacts").update({
      status: "en_proceso",
      updated_at: new Date().toISOString(),
    }).eq("phone", phone);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method === "GET") {
    return new Response("OK", { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    console.log("Body:", JSON.stringify(body));

    let phone = "";
    let userMessage = "";

    if (body?.whatsappInboundMessage) {
      const msg = body.whatsappInboundMessage;
      phone = msg.from || "";
      if (msg.type === "text") userMessage = msg.text?.body || "";
      else if (msg.type === "interactive") userMessage = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "";
      else if (msg.type === "button") userMessage = msg.button?.payload || msg.button?.text || "";
    }

    if (!phone && body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const msg = body.entry[0].changes[0].value.messages[0];
      phone = msg.from || "";
      userMessage = msg.text?.body || msg.interactive?.button_reply?.id || "";
    }

    if (!phone && body?.message) {
      const msg = body.message;
      phone = msg.from || "";
      if (msg.type === "text") userMessage = msg.text?.body || "";
      else if (msg.type === "interactive") userMessage = msg.interactive?.button_reply?.id || "";
      else if (msg.type === "button") userMessage = msg.button?.payload || "";
    }

    console.log("Parsed — phone:", phone, "msg:", userMessage);

    if (phone && userMessage) {
      await processMessage(phone, userMessage);
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
