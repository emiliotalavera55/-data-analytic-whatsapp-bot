// ============================================================
//  ROOFING MONKEYS — WhatsApp Bot v2
//  Twilio → Claude API (texto + visión) → Notion
//  Soporta: texto, imágenes, múltiples fotos por mensaje
// ============================================================

const express   = require("express");
const bodyParser = require("body-parser");
const Anthropic  = require("@anthropic-ai/sdk");
const { Client } = require("@notionhq/client");
const https      = require("https");
const http       = require("http");
const { URL }    = require("url");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Clientes ────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Credenciales Twilio para autenticar descarga de imágenes
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// ── IDs de bases de datos en Notion ─────────────────────────
const NOTION_DBS = {
  op:       process.env.NOTION_DB_OP,
  cobranza: process.env.NOTION_DB_COBRANZA,
  // Grupos futuros: agrega aquí
  // ventas: process.env.NOTION_DB_VENTAS,
};

// ── Detectar grupo ───────────────────────────────────────────
function detectarGrupo(body) {
  const texto = JSON.stringify(body).toLowerCase();
  if (texto.includes("cobranza") || texto.includes("sup")) return "cobranza";
  if (texto.includes(" op") || texto.includes("\"op\""))   return "op";
  return null;
}

// ── Descargar imagen de Twilio → Buffer base64 ──────────────
// Twilio requiere autenticación básica para acceder a los media
function descargarImagen(mediaUrl) {
  return new Promise((resolve, reject) => {
    const urlObj  = new URL(mediaUrl);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      headers: {
        Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
        "User-Agent":  "RoofingMonkeysBot/2.0",
      },
    };

    const lib = urlObj.protocol === "https:" ? https : http;

    lib.get(options, (res) => {
      // Seguir redirecciones (Twilio redirige a S3)
      if (res.statusCode === 301 || res.statusCode === 302) {
        return descargarImagen(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} al descargar imagen`));
      }

      const contentType = res.headers["content-type"] || "image/jpeg";
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end",  () => {
        const buffer    = Buffer.concat(chunks);
        const base64    = buffer.toString("base64");
        resolve({ base64, contentType: contentType.split(";")[0] });
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── Extraer URLs de imágenes del body de Twilio ─────────────
// Twilio envía: NumMedia, MediaUrl0, MediaUrl1, MediaContentType0...
function extraerImagenes(body) {
  const num    = parseInt(body.NumMedia || "0", 10);
  const medias = [];
  for (let i = 0; i < num; i++) {
    const url  = body[`MediaUrl${i}`];
    const tipo = body[`MediaContentType${i}`] || "";
    if (url && tipo.startsWith("image/")) {
      medias.push({ url, tipo });
    }
  }
  return medias;
}

// ── Llamar a Claude con texto e imágenes ────────────────────
async function analizarConClaude(grupo, remitente, texto, imagenesB64) {
  const prompt = PROMPTS[grupo];

  // Construir el content: texto + imágenes (si las hay)
  const userContent = [];

  // Agregar imágenes primero (Claude las analiza en contexto del texto)
  for (const img of imagenesB64) {
    userContent.push({
      type: "image",
      source: {
        type:       "base64",
        media_type: img.contentType,
        data:       img.base64,
      },
    });
  }

  // Agregar el texto del mensaje
  const textoMensaje = texto
    ? `Mensaje de ${remitente}:\n${texto}`
    : `Mensaje de ${remitente}: [Solo imágenes, sin texto]`;

  userContent.push({ type: "text", text: `${prompt}\n\n${textoMensaje}` });

  const response = await claude.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 1024,
    messages:   [{ role: "user", content: userContent }],
  });

  return response.content[0].text.trim();
}

// ── Adjuntar imágenes al cuerpo de una página Notion ────────
// Notion no permite subir archivos vía API directamente,
// pero sí agregar bloques "image" con URL externa (la de Twilio/S3).
// Las URLs de Twilio son temporales (~1h); esta solución las guarda
// como bloques de imagen en el body de la página.
async function adjuntarImagenesNotion(pageId, urlsImagenes, remitente) {
  if (!urlsImagenes.length) return;

  const bloques = urlsImagenes.map((url, idx) => ({
    object: "block",
    type:   "image",
    image: {
      type:     "external",
      external: { url },
      caption:  [{
        type: "text",
        text: { content: `Foto ${idx + 1} — ${remitente}` },
      }],
    },
  }));

  // Agregar encabezado antes de las fotos
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        object: "block",
        type:   "heading_3",
        heading_3: {
          rich_text: [{
            type: "text",
            text: { content: `📸 Fotos adjuntas (${urlsImagenes.length})` },
          }],
        },
      },
      ...bloques,
    ],
  });
}

// ── Prompts ──────────────────────────────────────────────────
const PROMPTS = {
  op: `Eres un asistente de Roofing Monkeys. Analiza este mensaje de WhatsApp del grupo OP
(Oportunidades de Mejora operativa). Puede incluir texto, fotos o ambos.
Si hay fotos, descríbelas brevemente en el campo "descripcion_fotos".
Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional:

{
  "direccion": "dirección completa con código postal si la hay, o null",
  "codigo_postal": "código postal canadiense si existe, o null",
  "ciudad": "ciudad y provincia, ej: Toronto, ON, o null",
  "problema": "descripción clara del problema en 1-2 oraciones",
  "categoria": uno de: "📦 Material faltante" | "🔧 Trabajo incompleto" | "🎨 Detalle de calidad" | "💧 Leak / fuga" | "📋 Error de vendedor" | "⚙️ Problema operativo",
  "equipo": array solo de: ["Matias","Parce","Memo/Guillermo","Armando","Alan","Alexis","Jesus","Toro","Vinicio"] o [],
  "vendedor": uno de: "Christian Zamarron" | "Carlos Sales Man" | "Joey Roofing Monkeys" | "Brian Zamarron" | "SNOW MOOSE" | "N/A",
  "reportado_por": "nombre de quien mandó el mensaje",
  "status": uno de: "✅ Resuelto" | "🔴 Retrabajo requerido" | "🔴 Bloqueado" | "⚠️ Acción correctiva" | "⚠️ Pendiente acción" | "⚠️ Revisión pendiente",
  "descripcion_fotos": "descripción breve de lo que muestran las fotos, o null si no hay fotos",
  "notas": "contexto adicional relevante o null",
  "es_operativo": true si contiene información procesable, false si es solo saludo/sticker/emoji
}

Si no hay información procesable: {"es_operativo": false}`,

  cobranza: `Eres un asistente de Roofing Monkeys. Analiza este mensaje de WhatsApp del grupo
Sup & Cobranza. Puede incluir texto, fotos o ambos.
Si hay fotos, descríbelas brevemente en el campo "descripcion_fotos".
Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional:

{
  "direccion": "dirección completa con código postal si la hay, o null",
  "codigo_postal": "código postal canadiense si existe, o null",
  "ciudad": "ciudad y provincia, ej: Toronto, ON, o null",
  "cliente": "nombre del cliente si se menciona, o null",
  "monto": "monto mencionado con símbolo de dólar, o null",
  "vendedor": "nombre del vendedor responsable si se menciona, o null",
  "categorias": array con uno o más de: ["🔴 Pago Pendiente","🟠 No Responde","🟡 Trabajo Incompleto","🔵 Disputa","🟣 Error Factura"],
  "status": uno de: "✅ Resuelto" | "⏳ Pendiente" | "🔴 Bloqueado" | "⚠️ Riesgo alto" | "🔴 Sin respuesta" | "⏳ Pendiente reparación",
  "reportado_por": "nombre de quien mandó el mensaje",
  "descripcion_fotos": "descripción breve de lo que muestran las fotos, o null si no hay fotos",
  "notas": "resumen del problema en 1-2 oraciones",
  "es_operativo": true si contiene información procesable, false si es conversación casual
}

Si no hay información procesable: {"es_operativo": false}`,
};

// ── Crear página en Notion ───────────────────────────────────
async function crearEnNotion(grupo, datos) {
  const dbId = NOTION_DBS[grupo];
  if (!dbId) throw new Error(`Base de datos no configurada para grupo: ${grupo}`);

  const notasCompletas = [
    datos.notas,
    datos.descripcion_fotos ? `📸 Fotos: ${datos.descripcion_fotos}` : null,
  ].filter(Boolean).join("\n\n") || null;

  if (grupo === "op") {
    return await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        "Dirección": { title: [{ text: { content: datos.direccion || "Sin dirección" } }] },
        ...(datos.codigo_postal && { "C.P.":           { rich_text: [{ text: { content: datos.codigo_postal } }] } }),
        ...(datos.ciudad        && { "Ciudad":          { rich_text: [{ text: { content: datos.ciudad } }] } }),
        ...(datos.categoria     && { "Categoría":       { select: { name: datos.categoria } } }),
        ...(datos.equipo?.length && { "Equipo de Trabajo": { multi_select: datos.equipo.map(e => ({ name: e })) } }),
        ...(datos.vendedor && datos.vendedor !== "N/A" && { "Vendedor": { select: { name: datos.vendedor } } }),
        ...(datos.reportado_por && { "Reportado Por":   { rich_text: [{ text: { content: datos.reportado_por } }] } }),
        ...(datos.status        && { "Status":          { select: { name: datos.status } } }),
        ...(datos.problema      && { "Problema Reportado": { rich_text: [{ text: { content: datos.problema } }] } }),
        ...(notasCompletas      && { "Notas":           { rich_text: [{ text: { content: notasCompletas } }] } }),
        "Fecha": { date: { start: new Date().toISOString().split("T")[0] } },
      },
    });
  }

  if (grupo === "cobranza") {
    return await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        "Dirección": { title: [{ text: { content: datos.direccion || "Sin dirección" } }] },
        ...(datos.codigo_postal   && { "C.P.":                  { rich_text: [{ text: { content: datos.codigo_postal } }] } }),
        ...(datos.cliente         && { "Cliente":                { rich_text: [{ text: { content: datos.cliente } }] } }),
        ...(datos.monto           && { "Monto":                  { rich_text: [{ text: { content: datos.monto } }] } }),
        ...(datos.vendedor        && { "Vendedor / Responsable": { rich_text: [{ text: { content: datos.vendedor } }] } }),
        ...(datos.categorias?.length && { "Categorías":          { multi_select: datos.categorias.map(c => ({ name: c })) } }),
        ...(datos.status          && { "Status":                 { select: { name: datos.status } } }),
        ...(datos.reportado_por   && { "Reportado Por":          { rich_text: [{ text: { content: datos.reportado_por } }] } }),
        ...(notasCompletas        && { "Notas":                  { rich_text: [{ text: { content: notasCompletas } }] } }),
        "Última Actividad": { date: { start: new Date().toISOString().split("T")[0] } },
      },
    });
  }
}

// ── Webhook principal ────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("📨 Mensaje recibido:", new Date().toISOString());

  const mensajeTexto  = req.body.Body || "";
  const remitente     = req.body.ProfileName || req.body.From || "Desconocido";
  const imagenesInfo  = extraerImagenes(req.body);

  console.log(`👤 De: ${remitente} | Texto: "${mensajeTexto.slice(0, 60)}" | Imágenes: ${imagenesInfo.length}`);

  // Responder de inmediato a Twilio (tiene timeout de 15s)
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  // Detectar grupo
  const grupo = detectarGrupo(req.body);
  if (!grupo) {
    console.log("⚠️  Grupo no reconocido, ignorando.");
    return;
  }

  // Ignorar si no hay texto ni imágenes
  if (!mensajeTexto.trim() && imagenesInfo.length === 0) {
    console.log("ℹ️  Sin contenido procesable (sticker/audio), ignorando.");
    return;
  }

  try {
    // ── Descargar imágenes en paralelo ──────────────────────
    let imagenesB64 = [];
    if (imagenesInfo.length > 0) {
      console.log(`🖼️  Descargando ${imagenesInfo.length} imagen(es)...`);
      const resultados = await Promise.allSettled(
        imagenesInfo.map(img => descargarImagen(img.url))
      );
      imagenesB64 = resultados
        .filter(r => r.status === "fulfilled")
        .map(r => r.value);
      console.log(`✅ ${imagenesB64.length}/${imagenesInfo.length} imágenes descargadas.`);
    }

    // ── Llamar a Claude (texto + visión si hay fotos) ───────
    const rawText = await analizarConClaude(grupo, remitente, mensajeTexto, imagenesB64);
    console.log("🤖 Claude:", rawText.slice(0, 200));

    // Limpiar posibles ```json ``` que Claude a veces agrega
    const jsonLimpio = rawText.replace(/```json\n?|\n?```/g, "").trim();
    const datos = JSON.parse(jsonLimpio);

    if (!datos.es_operativo) {
      console.log("💬 No es operativo, descartando.");
      return;
    }

    if (!datos.reportado_por) datos.reportado_por = remitente;

    // ── Crear página en Notion ──────────────────────────────
    const pagina = await crearEnNotion(grupo, datos);
    console.log(`✅ Página creada [${grupo}]:`, pagina.id);

    // ── Adjuntar imágenes al cuerpo de la página ────────────
    // Usamos las URLs originales de Twilio (son accesibles por ~1h)
    // Notion las embebe como bloques de imagen en el body de la página
    if (imagenesInfo.length > 0) {
      const urlsParaNotion = imagenesInfo.map(img => img.url);
      await adjuntarImagenesNotion(pagina.id, urlsParaNotion, remitente);
      console.log(`📸 ${urlsParaNotion.length} foto(s) adjuntadas a la página.`);
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    if (err.stack) console.error(err.stack);
  }
});

// ── Health check ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:  "ok",
    version: "2.0",
    mensaje: "🐵 Roofing Monkeys Bot activo — con soporte de imágenes",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bot v2 corriendo en puerto ${PORT}`));
