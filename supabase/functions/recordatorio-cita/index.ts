import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const YCLOUD_KEY_FALLBACK = Deno.env.get("YCLOUD_API_KEY") || "";
const YCLOUD_URL   = "https://api.ycloud.com/v2/whatsapp/messages";
const DEEPSEEK_KEY = Deno.env.get("DEEPSEEK_API_KEY")!;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Plantillas por defecto — sin emojis, en texto plano con variables {{...}}
const DEFAULT_MSG_NOCHE =
  `Hola {{nombre}}, te recordamos que *mañana* tienes tu entrevista de trabajo.

Puesto: {{puesto}}
Empresa: {{empresa}}
Hora acordada: {{disponibilidad}}

Prepara tu documentación y llega 10 minutos antes. Si necesitas hacer algún cambio, responde este mensaje.

Mucho éxito mañana.`;

const DEFAULT_MSG_MANANA =
  `Hola {{nombre}}, este es tu recordatorio de que *hoy* tienes tu entrevista de trabajo.

Puesto: {{puesto}}
Empresa: {{empresa}}
Hora: {{disponibilidad}}

Recuerda llegar 10 minutos antes.`;

function aplicarVariables(tpl: string, datos: Record<string, string>): string {
  let out = tpl;
  Object.entries(datos).forEach(([k, v]) => {
    out = out.replace(new RegExp(`{{${k}}}`, "g"), v || "");
  });
  return out;
}

async function sendText(to: string, text: string, from: string, apiKey: string) {
  const res = await fetch(YCLOUD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ from, to, type: "text", text: { body: text } }),
  });
  const resText = await res.text();
  console.log("sendText:", res.status, resText);
  return { ok: res.ok, detail: `HTTP ${res.status}: ${resText}` };
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
    return fecha === "null" ? null : fecha;
  } catch(e) {
    console.error("DeepSeek error:", e);
    return null;
  }
}

// Hora actual en Monterrey (UTC-6) como "HH:MM"
function horaMonterreyActual(): string {
  const ahora = new Date();
  const mty = new Date(ahora.getTime() - 6 * 3600000);
  const hh = String(mty.getUTCHours()).padStart(2, "0");
  const mm = String(mty.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Redondea "HH:MM" al bloque de 15 min más cercano hacia abajo, para comparar contra el cron
function redondear15(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const bloque = Math.floor(m / 15) * 15;
  return `${String(h).padStart(2, "0")}:${String(bloque).padStart(2, "0")}`;
}

// ============================================================
// Procesar recordatorios de UN usuario para un tipo (noche/mañana)
// ============================================================
async function procesarParaUsuario(usuario: any, tipo: "noche" | "manana") {
  const assignedPhones: string[] = usuario.assigned_phones || [];
  const esAdmin = usuario.role === "admin" || assignedPhones.length === 0;

  // Flujos visibles para este usuario
  let flowsQuery = sb.from("flows").select("id, whatsapp_phone, ycloud_api_key");
  if (!esAdmin) flowsQuery = flowsQuery.in("whatsapp_phone", assignedPhones);
  const { data: flows } = await flowsQuery;
  if (!flows?.length) return 0;

  const flowIds = flows.map((f: any) => f.id);
  const flowById: Record<string, any> = {};
  flows.forEach((f: any) => { flowById[f.id] = f; });

  // Fecha objetivo: "noche" busca citas de mañana, "manana" busca citas de hoy
  const ahora = new Date();
  const monterrey = new Date(ahora.getTime() - 6 * 3600000);
  const objetivo = new Date(monterrey);
  if (tipo === "noche") objetivo.setDate(objetivo.getDate() + 1);
  const objetivoISO = objetivo.toISOString().slice(0, 10);

  // Contactos de este usuario con campo "disponibilidad"
  const { data: contactsRows } = await sb
    .from("contacts")
    .select("id, phone, flow_id, status, bot_paused, contact_data(field_key, field_value)")
    .in("flow_id", flowIds);

  if (!contactsRows?.length) return 0;

  let enviados = 0;

  for (const contact of contactsRows) {
    try {
      if (["contratado", "rechazado", "descartado"].includes(contact.status)) continue;
      if (contact.bot_paused) continue;

      const datos: Record<string, string> = {};
      (contact.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

      const disponibilidad = datos.disponibilidad;
      if (!disponibilidad) continue;

      const fechaCita = await interpretarFecha(disponibilidad);
      if (!fechaCita || fechaCita !== objetivoISO) continue;

      const flow = flowById[contact.flow_id];
      if (!flow) continue;

      const from   = flow.whatsapp_phone || "+526181239810";
      const apiKey = flow.ycloud_api_key || YCLOUD_KEY_FALLBACK;

      const plantilla = tipo === "noche"
        ? (usuario.reminder_msg_noche || DEFAULT_MSG_NOCHE)
        : (usuario.reminder_msg_manana || DEFAULT_MSG_MANANA);

      const mensaje = aplicarVariables(plantilla, {
        nombre: datos.nombre || "Candidato",
        empresa: datos.empresa || "la empresa",
        puesto: datos.puesto || "el puesto",
        disponibilidad,
      });

      const resultado = await sendText(contact.phone, mensaje, from, apiKey);
      await sb.from("message_log").insert({
        phone: contact.phone, direction: "out", content: mensaje, node_key: `recordatorio_${tipo}`,
        status: resultado.ok ? "sent" : "failed",
        error_detail: resultado.ok ? null : resultado.detail.slice(0, 500),
      });

      console.log(`Recordatorio ${tipo} → ${contact.phone} (usuario: ${usuario.username})`);
      enviados++;
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      // Un contacto con problemas no debe detener al resto de los contactos de este mismo cliente
      console.error(`Error en recordatorio para contacto ${contact.phone} (usuario ${usuario.username}):`, e);
    }
  }

  return enviados;
}

// ============================================================
// CICLO PRINCIPAL — revisa todos los usuarios con recordatorios activos
// ============================================================
async function revisarYEnviarRecordatorios() {
  const horaActual = redondear15(horaMonterreyActual());
  console.log(`Revisando recordatorios — hora Monterrey: ${horaActual}`);

  const { data: usuarios } = await sb
    .from("app_users")
    .select("*")
    .eq("is_active", true)
    .eq("reminders_enabled", true);

  if (!usuarios?.length) {
    console.log("Sin usuarios con recordatorios activos");
    return { revisados: 0, enviados: 0 };
  }

  let totalEnviados = 0;
  const resultadosPorUsuario: Record<string, any> = {};

  for (const usuario of usuarios) {
    const horaNoche  = redondear15(usuario.reminder_hora_noche  || "21:00");
    const horaManana = redondear15(usuario.reminder_hora_manana || "08:00");

    // Cada cliente se procesa de forma aislada — si uno falla, los demás
    // siguen su curso normal en esta misma corrida.
    try {
      if (horaActual === horaNoche) {
        const enviados = await procesarParaUsuario(usuario, "noche");
        totalEnviados += enviados;
        resultadosPorUsuario[usuario.username] = { ok: true, tipo: "noche", enviados };
      }
    } catch(e) {
      console.error(`Error procesando recordatorio "noche" para ${usuario.username}:`, e);
      resultadosPorUsuario[usuario.username] = { ok: false, tipo: "noche", error: String(e) };
    }

    try {
      if (horaActual === horaManana) {
        const enviados = await procesarParaUsuario(usuario, "manana");
        totalEnviados += enviados;
        resultadosPorUsuario[usuario.username] = { ok: true, tipo: "manana", enviados };
      }
    } catch(e) {
      console.error(`Error procesando recordatorio "manana" para ${usuario.username}:`, e);
      resultadosPorUsuario[usuario.username] = { ok: false, tipo: "manana", error: String(e) };
    }
  }

  console.log(`Ciclo completado: ${totalEnviados} recordatorios enviados`);
  return { revisados: usuarios.length, enviados: totalEnviados, detalle: resultadosPorUsuario };
}

// ============================================================
// CRON — corre cada 15 minutos y decide por usuario si toca enviar
// ============================================================
Deno.cron("revisar-recordatorios", "*/15 * * * *", async () => {
  console.log("CRON ejecutándose...", new Date().toISOString());
  await revisarYEnviarRecordatorios();
});

// ============================================================
// HTTP — ejecutar manualmente o probar desde el panel
// ============================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return new Response(JSON.stringify({
      ok: true,
      message: "Servicio de recordatorios activo — configuración por usuario",
      revision: "cada 15 minutos, hora Monterrey",
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));

      // Permite forzar la revisión completa de inmediato (botón "Probar ahora" en el panel)
      if (body?.forzar) {
        const resultado = await revisarYEnviarRecordatorios();
        return new Response(JSON.stringify({ ok: true, ...resultado }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Permite probar un usuario y tipo específico sin esperar al cron
      if (body?.owner_id && body?.tipo) {
        const { data: usuario } = await sb.from("app_users").select("*").eq("id", body.owner_id).maybeSingle();
        if (!usuario) return new Response(JSON.stringify({ error: "Usuario no encontrado" }), { status: 404, headers: corsHeaders });
        const enviados = await procesarParaUsuario(usuario, body.tipo === "manana" ? "manana" : "noche");
        return new Response(JSON.stringify({ ok: true, enviados }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const resultado = await revisarYEnviarRecordatorios();
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
  }

  return new Response("Method not allowed", { status: 405 });
});
