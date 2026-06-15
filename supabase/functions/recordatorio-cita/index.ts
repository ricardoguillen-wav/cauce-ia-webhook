import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const YCLOUD_KEY = Deno.env.get("YCLOUD_API_KEY")!;
const YCLOUD_URL = "https://api.ycloud.com/v2/whatsapp/messages";
const DEEPSEEK_KEY = Deno.env.get("DEEPSEEK_API_KEY")!;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Obtener número de WA del flujo ──
async function getFromPhone(flowId: string): Promise<string> {
  const { data } = await sb.from("flows").select("whatsapp_phone").eq("id", flowId).maybeSingle();
  return data?.whatsapp_phone || "+526181239810";
}

// ── Enviar mensaje de texto ──
async function sendText(to: string, text: string, from: string) {
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": YCLOUD_KEY },
    body: JSON.stringify({ from, to, type: "text", text: { body: text } }),
  });
  console.log("sendText:", res.status, await res.text());
}

// ── Interpretar fecha con DeepSeek ──
async function interpretarFecha(disponibilidad: string): Promise<string | null> {
  if (!disponibilidad) return null;

  const hoy = new Date();
  const prompt = `Hoy es ${hoy.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

El candidato escribió esto como disponibilidad para su cita: "${disponibilidad}"

Extrae la fecha exacta de la cita. Responde SOLO con la fecha en formato ISO YYYY-MM-DD.
Si no puedes determinar una fecha exacta, responde "null".
Ejemplos:
- "martes 17 de junio a las 10am" → "2026-06-17"
- "mañana a las 3pm" → "${new Date(Date.now()+86400000).toISOString().slice(0,10)}"
- "la próxima semana" → "null"
- "jueves" → la fecha del próximo jueves en formato ISO`;

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
        max_tokens: 20,
        temperature: 0
      })
    });
    const data = await res.json();
    const fecha = data?.choices?.[0]?.message?.content?.trim();
    console.log(`Fecha interpretada: "${disponibilidad}" → "${fecha}"`);
    return fecha === "null" ? null : fecha;
  } catch(e) {
    console.error("DeepSeek error:", e);
    return null;
  }
}

// ── Procesar recordatorios ──
async function procesarRecordatorios() {
  console.log("Iniciando proceso de recordatorios...");

  // Obtener todos los contactos en estado "nuevo" o "en_proceso"
  // que tengan campo "disponibilidad" capturado
  const { data: contactDataRows, error } = await sb
    .from("contact_data")
    .select("contact_id, field_value")
    .eq("field_key", "disponibilidad");

  if (error) { console.error("Error obteniendo contact_data:", error); return; }
  if (!contactDataRows?.length) { console.log("Sin contactos con disponibilidad"); return; }

  console.log(`${contactDataRows.length} contactos con disponibilidad registrada`);

  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const mananaISO = manana.toISOString().slice(0, 10);
  console.log("Buscando citas para mañana:", mananaISO);

  let enviados = 0;
  let revisados = 0;

  for (const row of contactDataRows) {
    revisados++;

    // Interpretar la fecha con DeepSeek
    const fechaCita = await interpretarFecha(row.field_value);
    if (!fechaCita || fechaCita !== mananaISO) continue;

    // Obtener datos del contacto
    const { data: contact } = await sb
      .from("contacts")
      .select("*, contact_data(*)")
      .eq("id", row.contact_id)
      .maybeSingle();

    if (!contact) continue;
    if (contact.status === "contratado" || contact.status === "rechazado" || contact.status === "descartado") continue;
    if (contact.bot_paused) continue;

    // Armar datos del contacto
    const datos: Record<string, string> = {};
    (contact.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

    const nombre   = datos.nombre   || "Candidato";
    const empresa  = datos.empresa  || "la empresa";
    const puesto   = datos.puesto   || "el puesto";
    const horaCita = row.field_value;

    // Obtener número de WA del flujo
    const from = await getFromPhone(contact.flow_id);

    // Enviar recordatorio
    const mensaje = `¡Hola ${nombre}! 👋

Te recordamos que *mañana* tienes tu entrevista para el puesto de *${puesto}* en *${empresa}*.

📅 Fecha y hora acordada: ${horaCita}

Por favor llega 10 minutos antes. Si necesitas reagendar, responde este mensaje y con gusto te ayudamos.

¡Mucho éxito! 🌟
— Equipo Cauce Talento`;

    await sendText(contact.phone, mensaje, from);

    // Registrar en message_log
    await sb.from("message_log").insert({
      phone: contact.phone,
      direction: "out",
      content: mensaje,
      node_key: "recordatorio_automatico"
    });

    console.log(`Recordatorio enviado a ${contact.phone} (${nombre}) — cita: ${horaCita}`);
    enviados++;

    // Pequeña pausa entre envíos para no saturar la API
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`Proceso completado: ${enviados} recordatorios enviados de ${revisados} revisados`);
  return { revisados, enviados };
}

// ── Handler ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Verificar autorización para llamadas manuales
  // El cron de Deno Deploy llama sin body, las llamadas manuales pueden incluir un token
  const authHeader = req.headers.get("Authorization");
  const cronSecret = Deno.env.get("CRON_SECRET");

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Verificar si es llamada del cron interno de Deno (sin auth header)
    const isDenoCron = req.headers.get("x-deno-cron") === "true";
    if (!isDenoCron) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }

  try {
    const resultado = await procesarRecordatorios();
    return new Response(JSON.stringify({ ok: true, ...resultado }), {
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
});
