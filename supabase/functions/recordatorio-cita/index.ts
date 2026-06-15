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

async function getFromPhone(flowId: string): Promise<string> {
  const { data } = await sb.from("flows").select("whatsapp_phone").eq("id", flowId).maybeSingle();
  return data?.whatsapp_phone || "+526181239810";
}

async function sendText(to: string, text: string, from: string) {
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": YCLOUD_KEY },
    body: JSON.stringify({ from, to, type: "text", text: { body: text } }),
  });
  console.log("sendText:", res.status, await res.text());
}

async function interpretarFecha(disponibilidad: string): Promise<string | null> {
  if (!disponibilidad) return null;
  const hoy = new Date();
  const prompt = `Hoy es ${hoy.toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}.
El candidato escribió su disponibilidad: "${disponibilidad}"
Extrae la fecha exacta en formato ISO YYYY-MM-DD. Si no puedes determinar fecha exacta responde "null".
Responde SOLO con la fecha o "null", sin explicaciones.`;

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], max_tokens: 20, temperature: 0 })
    });
    const data = await res.json();
    const fecha = data?.choices?.[0]?.message?.content?.trim();
    console.log(`Fecha: "${disponibilidad}" → "${fecha}"`);
    return fecha === "null" ? null : fecha;
  } catch(e) {
    console.error("DeepSeek error:", e);
    return null;
  }
}

// ── Procesar recordatorios ──
// tipo: "noche" = aviso la noche anterior (cita es mañana)
//       "manana" = recordatorio mañana mismo (cita es hoy)
async function procesarRecordatorios(tipo: "noche" | "manana") {
  console.log(`Procesando recordatorios tipo=${tipo}...`, new Date().toISOString());

  const { data: rows, error } = await sb
    .from("contact_data")
    .select("contact_id, field_value")
    .eq("field_key", "disponibilidad");

  if (error || !rows?.length) {
    console.log("Sin datos:", error);
    return { revisados: 0, enviados: 0 };
  }

  // Fecha objetivo según tipo
  // "noche"  → la cita es mañana (buscamos fecha = hoy + 1 día en hora Monterrey)
  // "manana" → la cita es hoy    (buscamos fecha = hoy en hora Monterrey)
  const ahora = new Date();
  // Convertir a hora Monterrey (UTC-6)
  const monterrey = new Date(ahora.getTime() - 6 * 3600000);
  const objetivo  = new Date(monterrey);
  if (tipo === "noche") objetivo.setDate(objetivo.getDate() + 1);
  const objetivoISO = objetivo.toISOString().slice(0, 10);

  console.log(`Buscando citas para: ${objetivoISO} (tipo: ${tipo}) — ${rows.length} registros a revisar`);

  let enviados = 0;

  for (const row of rows) {
    const fechaCita = await interpretarFecha(row.field_value);
    if (!fechaCita || fechaCita !== objetivoISO) continue;

    const { data: contact } = await sb
      .from("contacts")
      .select("*, contact_data(*)")
      .eq("id", row.contact_id)
      .maybeSingle();

    if (!contact) continue;
    if (['contratado','rechazado','descartado'].includes(contact.status)) continue;
    if (contact.bot_paused) continue;

    const datos: Record<string, string> = {};
    (contact.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

    const nombre  = datos.nombre  || "Candidato";
    const empresa = datos.empresa || "la empresa";
    const puesto  = datos.puesto  || "el puesto";
    const from    = await getFromPhone(contact.flow_id);

    // Mensaje diferente según el tipo
    const mensaje = tipo === "noche"
      ? `¡Buenas noches ${nombre}! 🌙

Te recordamos que *mañana* tienes tu entrevista de trabajo con *Cauce Talento*.

💼 Puesto: *${puesto}*
🏢 Empresa: *${empresa}*
📅 Hora acordada: ${row.field_value}

Prepara tu documentación y llega 10 minutos antes. Si necesitas hacer algún cambio, responde este mensaje esta noche.

¡Descansa bien y mucho éxito mañana! 💪
— Equipo Cauce Talento`
      : `¡Buenos días ${nombre}! ☀️

Este es tu recordatorio de que *hoy* tienes tu entrevista de trabajo.

💼 Puesto: *${puesto}*
🏢 Empresa: *${empresa}*
📅 Hora: ${row.field_value}

Recuerda llegar 10 minutos antes. ¡Ya casi! 🚀
— Equipo Cauce Talento`;

    await sendText(contact.phone, mensaje, from);
    await sb.from("message_log").insert({
      phone: contact.phone,
      direction: "out",
      content: mensaje,
      node_key: `recordatorio_${tipo}`
    });

    console.log(`Recordatorio ${tipo} enviado → ${contact.phone} (${nombre}) cita: ${row.field_value}`);
    enviados++;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Completado: ${enviados} recordatorios enviados`);
  return { revisados: rows.length, enviados };
}

// ============================================================
// CRONS
// ============================================================

// Recordatorio noche anterior — 23:00 Monterrey = 05:00 UTC
Deno.cron("recordatorio-noche", "0 5 * * *", async () => {
  console.log("CRON noche ejecutándose...");
  await procesarRecordatorios("noche");
});

// Recordatorio mañana del día de la cita — 8:00 Monterrey = 14:00 UTC
Deno.cron("recordatorio-manana", "0 14 * * *", async () => {
  console.log("CRON mañana ejecutándose...");
  await procesarRecordatorios("manana");
});

// ============================================================
// HTTP — ejecutar manualmente desde el CRM
// ============================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return new Response(JSON.stringify({
      ok: true,
      message: "Servicio de recordatorios activo",
      crons: [
        { nombre: "Recordatorio noche", hora: "23:00 Monterrey", utc: "05:00 UTC" },
        { nombre: "Recordatorio mañana", hora: "08:00 Monterrey", utc: "14:00 UTC" }
      ]
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));
      const tipo = body?.tipo === "manana" ? "manana" : "noche";
      const resultado = await procesarRecordatorios(tipo);
      return new Response(JSON.stringify({ ok: true, tipo, ...resultado }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch(err) {
      console.error("Error:", err);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
