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
// Textos base de los recordatorios. Cada número puede tener el suyo
// desde la sección WhatsApp; si no lo tiene, se usan estos.
const DEFAULT_MSG_NOCHE =
`¡Hola {{nombre}}! 👋 Te recuerdo que *mañana* tienes tu entrevista 📅

🏭 Empresa: *{{empresa}}*
💼 Puesto: *{{puesto}}*
🕗 Horario: *{{disponibilidad}}*

📄 Prepara tu papelería en copia
⏰ Llega 10 minutitos antes

Si necesitas cambiar el día, contéstame este mensaje con confianza 😊

¡Mucho éxito mañana! 💪`;

const DEFAULT_MSG_MANANA =
`¡Buenos días {{nombre}}! ☀️ Hoy es tu entrevista 🎯

🏭 Empresa: *{{empresa}}*
💼 Puesto: *{{puesto}}*
🕗 Horario: *{{disponibilidad}}*

📄 No se te olvide tu papelería
⏰ Llega 10 minutitos antes

¡Aquí te esperamos, mucho éxito! 💪`;

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

  // Leer configuración de recordatorio por número (columnas pueden no existir aún)
  const phonesDelUsuario = flows.map((f: any) => f.whatsapp_phone).filter(Boolean);
  const waCfgByPhone: Record<string, any> = {};
  try {
    const { data: waNumbers } = await sb.from("wa_numbers")
      .select("phone, reminder_enabled, reminder_msg_noche, reminder_msg_manana")
      .in("phone", phonesDelUsuario);
    (waNumbers || []).forEach((n: any) => { waCfgByPhone[n.phone] = n; });
  } catch(e) {
    console.log("wa_numbers sin columnas de recordatorio — usando defaults del usuario");
  }

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

  if (!contactsRows?.length) {
    console.log(`Sin contactos en los flujos de ${usuario.username}`);
    return 0;
  }

  const conDisponibilidad = contactsRows.filter(c => {
    const datos: Record<string, string> = {};
    (c.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });
    return !!datos.disponibilidad;
  });
  console.log(`Contactos totales: ${contactsRows.length} | Con disponibilidad: ${conDisponibilidad.length} | Objetivo: ${objetivoISO}`);

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

      // Mensaje personalizado: primero del wa_number, luego del usuario, luego default
      const waCfg = waCfgByPhone[from] || {};

      // Si el número tiene recordatorios desactivados, saltar
      if (waCfg.reminder_enabled === false) continue;

      const plantilla = tipo === "noche"
        ? (waCfg.reminder_msg_noche || usuario.reminder_msg_noche || DEFAULT_MSG_NOCHE)
        : (waCfg.reminder_msg_manana || usuario.reminder_msg_manana || DEFAULT_MSG_MANANA);

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
// SEGUIMIENTO DE NO-SHOWS
// Corre 1 vez al día a las 10am — detecta candidatos que tenían
// entrevista ayer o antes y siguen sin ser contratados
// ============================================================
async function procesarNoShows() {
  const ahora = new Date();
  const mty = new Date(ahora.getTime() - 6 * 3600000);
  const horaActual = `${String(mty.getUTCHours()).padStart(2,'0')}:${String(mty.getUTCMinutes()).padStart(2,'0')}`;
  const horaRedon = redondear15(horaActual);
  if (horaRedon !== "10:00") return 0; // Solo a las 10am

  const { data: usuarios } = await sb.from("app_users")
    .select("*").eq("is_active", true).eq("noshows_enabled", true);
  if (!usuarios?.length) return 0;

  const hoy = mty.toISOString().slice(0, 10);
  let totalEnviados = 0;

  for (const usuario of usuarios) {
    try {
      const assignedPhones: string[] = usuario.assigned_phones || [];
      const esAdmin = !assignedPhones.length;
      let flowsQuery = sb.from("flows").select("id, whatsapp_phone, ycloud_api_key, name");
      if (!esAdmin) flowsQuery = flowsQuery.in("whatsapp_phone", assignedPhones);
      const { data: flujos } = await flowsQuery;
      if (!flujos?.length) continue;

      const flowIds = flujos.map((f: any) => f.id);
      const flowById: Record<string, any> = {};
      flujos.forEach((f: any) => { flowById[f.id] = f; });

      const { data: contactos } = await sb.from("contacts")
        .select("id, phone, flow_id, status, contact_data(field_key, field_value)")
        .in("flow_id", flowIds)
        .eq("status", "en_proceso");

      for (const c of (contactos || [])) {
        try {
          const datos: Record<string, string> = {};
          (c.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

          if (!datos.disponibilidad) continue;
          const fechaCita = await interpretarFecha(datos.disponibilidad);
          if (!fechaCita || fechaCita >= hoy) continue; // Solo si la fecha ya pasó

          // Verificar que no se le haya mandado ya un mensaje de no-show hoy
          const { data: logs } = await sb.from("message_log")
            .select("id").eq("phone", c.phone).eq("node_key", "noshow_followup")
            .gte("created_at", new Date(Date.now() - 24*3600000).toISOString())
            .limit(1)._get();
          if (logs?.length) continue; // Ya se le mandó hoy

          const flow = flowById[c.flow_id];
          if (!flow) continue;

          const from   = flow.whatsapp_phone;
          const apiKey = flow.ycloud_api_key || YCLOUD_KEY_FALLBACK;
          const plantilla = usuario.noshows_msg ||
            "Hola {{nombre}}, notamos que no pudiste asistir el {{disponibilidad}}. Seguimos con vacantes de {{puesto}} disponibles. Te esperamos cuando puedas.";

          const mensaje = aplicarVariables(plantilla, {
            nombre: datos.nombre || "Candidato",
            puesto: datos.puesto || "el puesto",
            disponibilidad: datos.disponibilidad,
          });

          const resultado = await sendText(c.phone, mensaje, from, apiKey);
          await sb.from("message_log").insert({
            phone: c.phone, direction: "out", content: mensaje, node_key: "noshow_followup",
            status: resultado.ok ? "sent" : "failed",
            error_detail: resultado.ok ? null : resultado.detail?.slice(0, 500),
          });

          totalEnviados++;
          await new Promise(r => setTimeout(r, 500));
        } catch(e) {
          console.error(`Error en no-show para ${c.phone}:`, e);
        }
      }
    } catch(e) {
      console.error(`Error procesando no-shows para ${usuario.username}:`, e);
    }
  }
  return totalEnviados;
}

// ============================================================
// CRON — corre cada 15 minutos y decide por usuario si toca enviar
// ============================================================
Deno.cron("revisar-recordatorios", "*/15 * * * *", async () => {
  console.log("CRON ejecutándose...", new Date().toISOString());
  await revisarYEnviarRecordatorios();
  await procesarNoShows();
});

// ============================================================
// RESUMEN DIARIO — 7 PM Monterrey (01:00 UTC)
// ============================================================
async function enviarResumenDiario() {
  console.log("Ejecutando resumen diario...", new Date().toISOString());

  // Obtener solo candidatos que completaron el flujo HOY (updated_at en Monterrey)
  const ahoraMty = new Date(Date.now() - 6 * 3600 * 1000); // UTC → MTY
  const inicioHoyMty = new Date(ahoraMty.getFullYear(), ahoraMty.getMonth(), ahoraMty.getDate());
  const inicioHoyUTC = new Date(inicioHoyMty.getTime() + 6 * 3600 * 1000);

  const { data: enProceso } = await sb.from("contacts")
    .select("*, contact_data(field_key, field_value)")
    .eq("status", "en_proceso")
    .gte("updated_at", inicioHoyUTC.toISOString());

  if (!enProceso?.length) {
    console.log("Sin candidatos en proceso — resumen omitido");
    return;
  }

  // Obtener todos los flujos con notify_phone
  const { data: allFlows } = await sb.from("flows")
    .select("id, name, notify_phone, recruiter_name, whatsapp_phone, ycloud_api_key");

  // Detectar candidatos que escribieron DESPUÉS de terminar el flujo
  const phones = enProceso.map(c => c.phone);
  const { data: postMensajes } = await sb.from("message_log")
    .select("phone, content, direction, created_at")
    .in("phone", phones)
    .eq("node_key", "post_registro")
    .eq("direction", "in");

  const phonesConMensaje = new Set((postMensajes || []).map(m => m.phone));
  const mensajesPorPhone: Record<string, string> = {};
  (postMensajes || []).forEach(m => {
    if (!mensajesPorPhone[m.phone]) mensajesPorPhone[m.phone] = m.content?.slice(0, 80) || "";
  });

  // Agrupar candidatos por notify_phone
  const resumenPorDest: Record<string, { contactos: any[]; flow: any }> = {};

  for (const c of enProceso) {
    const flow = allFlows?.find(f => f.id === c.flow_id);
    if (!flow) continue;

    // Soportar múltiples notify_phone separados por coma/salto de línea
    const destinos = (flow.notify_phone || "")
      .split(/[,\n]/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 6);

    for (const dest of destinos) {
      if (!resumenPorDest[dest]) resumenPorDest[dest] = { contactos: [], flow };
      resumenPorDest[dest].contactos.push({ c, flow });
    }
  }

  const hoy = new Date().toLocaleDateString("es-MX", {
    timeZone: "America/Monterrey", weekday: "long", day: "numeric", month: "long"
  }).toUpperCase();

  // Enviar un resumen a cada número destino
  for (const [dest, { contactos, flow }] of Object.entries(resumenPorDest)) {
    // Obtener API key y número de origen
    const from   = flow.whatsapp_phone;
    const apiKey = flow.ycloud_api_key || YCLOUD_KEY_FALLBACK;
    if (!from || !apiKey) continue;

    // Categorizar candidatos
    const conDuda: any[]    = [];
    const conCita: any[]    = [];
    const sinCita: any[]    = [];

    for (const { c, flow: f } of contactos) {
      const datos: Record<string, string> = {};
      (c.contact_data || []).forEach((d: any) => { datos[d.field_key] = d.field_value; });

      // Tiene mensaje post-registro (escribió con duda)
      if (phonesConMensaje.has(c.phone)) {
        conDuda.push({ c, datos, f, msg: mensajesPorPhone[c.phone] });
      // Tiene disponibilidad/cita agendada
      } else if (datos.disponibilidad && datos.disponibilidad.trim().length > 3) {
        conCita.push({ c, datos, f });
      } else {
        sinCita.push({ c, datos, f });
      }
    }

    // Construir el mensaje
    let msg = `*RESUMEN DE CANDIDATOS — ${hoy}*\n`;
    msg += `_Registrados hoy: ${contactos.length}_\n`;

    if (conDuda.length) {
      msg += `\n⚠️ *Requieren atención / con preguntas:*\n`;
      conDuda.forEach(({ c, datos, msg: pregunta }) => {
        const nombre = datos.nombre || c.phone;
        const num    = c.phone.replace(/^\+/, "");
        msg += `• ${nombre}`;
        if (pregunta) msg += ` — _"${pregunta}"_`;
        msg += ` 📞 ${num}\n`;
      });
    }

    if (conCita.length) {
      msg += `\n📅 *Con cita agendada:*\n`;
      conCita.forEach(({ c, datos, f }) => {
        const nombre = datos.nombre || c.phone;
        const cita   = datos.disponibilidad || "—";
        const num    = c.phone.replace(/^\+/, "");
        const rec    = f.recruiter_name ? ` (${f.recruiter_name})` : "";
        msg += `• ${nombre}${rec} — ${cita} 📞 ${num}\n`;
      });
    }

    if (sinCita.length) {
      msg += `\n✅ *En proceso (sin cita):*\n`;
      sinCita.forEach(({ c, datos, f }) => {
        const nombre = datos.nombre || c.phone;
        const num    = c.phone.replace(/^\+/, "");
        const rec    = f.recruiter_name ? ` (${f.recruiter_name})` : "";
        msg += `• ${nombre}${rec} 📞 ${num}\n`;
      });
    }

    const result = await sendText(dest, msg, from, apiKey);
    console.log(`Resumen enviado a ${dest}: ${result.ok ? "OK" : result.detail}`);
  }
}

// Cron resumen diario — 7 PM Monterrey = 01:00 UTC
Deno.cron("resumen-diario-7pm", "0 1 * * *", async () => {
  console.log("Resumen diario 7 PM Monterrey...");
  await enviarResumenDiario();
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

      // Disparar resumen diario manualmente (para pruebas)
      if (body?.resumen_diario) {
        await enviarResumenDiario();
        return new Response(JSON.stringify({ ok: true, message: "Resumen diario enviado" }), {
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
