require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { OpenAI } = require('openai');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    defaultHeaders: {
        'X-Group': 'claude'
    }
});

const MODELO_TEXTO = 'claude-sonnet-4-6';

// ========== CONFIGURACIÓN EDITABLE ==========
const CONFIG_VENTAS = {
    NOMBRE_NEGOCIO: 'AG Accesorios',
    CUENTA_BANCOLOMBIA: '#######00',
    TITULAR_CUENTA: 'AX Accesorios',
    NUMERO_NEQUI: '#######65',
    NUMERO_NOTIFICACIONES: '57#######87@s.whatsapp.net',
    URL_CATALOGO: 'https://www.whatalogosale.com/'
};
// ============================================

const SYSTEM_PROMPT =
    process.env.SYSTEM_PROMPT ||
    `Eres el asesor de ventas virtual de AG Accesorios, una joyería especializada en piezas de covergold y acero inoxidable de alta calidad. Tu tono es amable, profesional, cercano y persuasivo.

INFORMACIÓN DEL NEGOCIO:
- Catálogo oficial: ${CONFIG_VENTAS.URL_CATALOGO}
- Formas de pago: transferencia Bancolombia o Nequi
- Compra mínima: X6 o X12 unidades (varía según el producto, se especifica en cada artículo del catálogo)
- Materiales: covergold y acero inoxidable (duraderos e hipoalergénicos)

RESTRICCIONES - NUNCA LAS ROMPAS:
1. SOLO responde sobre joyas, accesorios, materiales, precios, envíos, catálogo y formas de pago.
2. NO respondas sobre política, religión, salud, finanzas personales, recetas, tecnología ajena al negocio ni temas personales.
3. Si te preguntan algo fuera del negocio responde: "Solo puedo ayudarte con nuestras joyas y accesorios 💍. ¿Te gustaría ver nuestro catálogo? 👉 ${CONFIG_VENTAS.URL_CATALOGO}"
4. No inventes modelos, precios ni existencias. Si no lo sabes, remite al catálogo.
5. Si preguntan por modelos específicos, describe el tipo de pieza y remite al catálogo para ver fotos y precios.

REGLAS:
1. Destaca siempre covergold y acero inoxidable: duraderos, elegantes e hipoalergénicos.
2. Si preguntan por cantidades, aclara que la compra mínima es X6 o X12 según el producto.
3. Si envían foto de una joya, identifícala y ofrece información. Si no es joya: "Solo analizo imágenes de joyas y accesorios 💍".
4. Respuestas cortas de WhatsApp, emojis moderados (✨, 💍, 💖).
5. Si el mensaje es un pedido formal con productos y total, no lo proceses: el sistema tiene un flujo automático.`;

const MAX_MENSAJES_HISTORIAL = 6;
const MAX_TOKENS_RESPUESTA = 250;
const MAX_ANCHO_IMAGEN = 1024;
const CALIDAD_JPEG = 80;

const PREGUNTAS_FRECUENTES = {
    'hola': '¡Hola! 👋 Bienvenido a AX Accesorios. ¿En qué puedo ayudarte hoy? Tenemos hermosas joyas en covergold y acero inoxidable. 💍✨',
    'buenos dias': '¡Buenos días! ☀️ ¿En qué puedo ayudarte con nuestras joyas hoy? 💍',
    'buenas tardes': '¡Buenas tardes! 🌤️ ¿Te gustaría ver nuestro catálogo de joyas? 💎',
    'buenas noches': '¡Buenas noches! 🌙 ¿En qué puedo ayudarte con nuestros accesorios? ✨',
    'catalogo': `¡Claro! Aquí está nuestro catálogo actualizado: ${CONFIG_VENTAS.URL_CATALOGO} 💎`,
    'precio': `Los precios varían según el modelo. Míralos todos aquí: ${CONFIG_VENTAS.URL_CATALOGO} 💰`,
    'precios': `Los precios varían según el modelo. Míralos todos aquí: ${CONFIG_VENTAS.URL_CATALOGO} 💰`,
    'pago': '💳 Aceptamos transferencia por Bancolombia y Nequi. ¿Te gustaría hacer un pedido?',
    'formas de pago': '💳 Aceptamos Bancolombia y Nequi. Cuando armes tu pedido te doy los datos. ✨',
    'minimo': '📦 La compra mínima es X6 o X12 unidades según el producto. Lo verás indicado en cada artículo del catálogo.',
    'compra minima': '📦 La compra mínima es X6 o X12 unidades según el producto. ¿Te muestro el catálogo? 💎',
    'envio': `Sí, hacemos envíos 📦. Detalles de costos y tiempos en: ${CONFIG_VENTAS.URL_CATALOGO}`,
    'envios': `Sí, hacemos envíos 📦. Detalles de costos y tiempos en: ${CONFIG_VENTAS.URL_CATALOGO}`,
};

const TEMAS_PROHIBIDOS = [
    'politica', 'presidente', 'elecciones', 'partido',
    'religion', 'iglesia', 'biblia',
    'receta', 'cocinar',
    'enfermedad', 'medicina', 'doctor',
    'bitcoin', 'cripto', 'inversion',
    'tarea', 'matematica', 'fisica',
    'programar', 'html'
];

// ========== SISTEMA DE COMPRAS ==========
const procesosCompra = new Map();

const PASOS_COMPRA = {
    ESPERANDO_NOMBRE: 'nombre',
    ESPERANDO_DIRECCION: 'direccion',
    CONFIRMANDO_DIRECCION: 'confirmar_direccion',
    ESPERANDO_METODO_PAGO: 'metodo_pago',
    ESPERANDO_COMPROBANTE: 'comprobante'
};

function detectarPedidoFormal(texto) {
    const indicadores = [
        /total\s*a\s*pagar/i,
        /realizar.*pedido/i,
        /quiero.*pedido/i,
        /#\d{3,}/,
        /\$\s*[\d.,]+/,
        /x\d+\s*#\d+/i
    ];

    let coincidencias = 0;
    for (const patron of indicadores) {
        if (patron.test(texto)) coincidencias++;
    }

    return coincidencias >= 2;
}

function formatearPesos(valor) {
    const numero = Number(String(valor).replace(/[^\d]/g, ''));
    if (!numero) return String(valor);
    return numero.toLocaleString('es-CO');
}

function extraerInfoPedido(texto) {
    const totalMatch = texto.match(/total\s*a\s*pagar\s*:?\s*\$?\s*([\d.,]+)/i);
    const total = totalMatch ? formatearPesos(totalMatch[1]) : 'No especificado';

    return {
        numeroPedido: `AG-${Date.now().toString().slice(-8)}`,
        textoCompleto: texto,
        total,
        timestamp: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })
    };
}

function limpiarParaPDF(texto) {
    return String(texto)
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu, '')
        .replace(/\*/g, '')
        .replace(/-{3,}/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function generarPDFPedido(pedido, datos, telefonoCliente) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const chunks = [];

            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Encabezado
            doc.fontSize(20).font('Helvetica-Bold')
                .text(CONFIG_VENTAS.NOMBRE_NEGOCIO, { align: 'center' });
            doc.fontSize(12).font('Helvetica')
                .text('Comprobante de pedido', { align: 'center' });
            doc.moveDown(0.5);
            doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown(1);

            // Datos del pedido
            doc.fontSize(11).font('Helvetica-Bold').text(`Pedido No: ${pedido.numeroPedido}`);
            doc.font('Helvetica').text(`Fecha: ${pedido.timestamp}`);
            doc.moveDown(1);

            // Datos del cliente
            doc.font('Helvetica-Bold').fontSize(13).text('Datos del cliente');
            doc.moveDown(0.3);
            doc.fontSize(11).font('Helvetica');
            doc.text(`Nombre: ${limpiarParaPDF(datos.nombre)}`);
            doc.text(`Telefono: ${telefonoCliente}`);
            doc.text(`Direccion: ${limpiarParaPDF(datos.direccion)}`, { width: 495 });
            doc.moveDown(1);

            // Pago
            doc.font('Helvetica-Bold').fontSize(13).text('Informacion de pago');
            doc.moveDown(0.3);
            doc.fontSize(11).font('Helvetica');
            doc.text(`Metodo: ${datos.metodoPago}`);
            doc.text(`Cuenta / Numero destino: ${datos.numeroCuenta}`);
            doc.text(`Total a pagar: $ ${pedido.total}`);
            doc.text(`Comprobante de transferencia: ${datos.comprobante}`);
            doc.moveDown(1);

            // Detalle
            doc.font('Helvetica-Bold').fontSize(13).text('Detalle del pedido');
            doc.moveDown(0.3);
            doc.fontSize(10).font('Helvetica')
                .text(limpiarParaPDF(pedido.textoCompleto), { width: 495, align: 'left' });
            doc.moveDown(1.5);

            // Pie
            doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown(0.5);
            doc.fontSize(9).fillColor('#555555')
                .text('Compra minima X6 o X12 unidades segun el producto. Joyas en covergold y acero inoxidable.', { align: 'center' })
                .text(CONFIG_VENTAS.URL_CATALOGO, { align: 'center' });

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

async function iniciarProcesoCompra(sock, jid, pedido) {
    procesosCompra.set(jid, {
        paso: PASOS_COMPRA.ESPERANDO_NOMBRE,
        pedido,
        jid,
        datos: {}
    });

    await sock.sendMessage(jid, {
        text: '✨ ¡Gracias por estar interesado! Te preguntaré unos datos para hacer la compra efectiva.\n\n📝 Por favor, envíame tu *nombre completo*:'
    });
}

function esRespuestaAfirmativa(texto) {
    return /^(s[ií]|si|sí|correcto|claro|exacto|as[ií] es|confirmo|1|ok|listo|dale)\b/i.test(texto.trim());
}

function esRespuestaNegativa(texto) {
    return /^(no|nop|incorrecto|error|corregir|cambiar|2)\b/i.test(texto.trim());
}

async function procesarRespuestaCompra(sock, jid, mensaje, esImagen, bufferImagen) {
    const proceso = procesosCompra.get(jid);
    if (!proceso) return false;

    switch (proceso.paso) {
        case PASOS_COMPRA.ESPERANDO_NOMBRE: {
            if (!mensaje || mensaje.trim().length < 3) {
                await sock.sendMessage(jid, { text: '📝 Necesito tu *nombre completo* para continuar:' });
                return true;
            }
            proceso.datos.nombre = mensaje.trim();
            proceso.paso = PASOS_COMPRA.ESPERANDO_DIRECCION;
            await sock.sendMessage(jid, {
                text: `Perfecto, ${proceso.datos.nombre} 👍\n\n📍 Ahora envíame tu *dirección completa* (incluye barrio y ciudad):`
            });
            return true;
        }

        case PASOS_COMPRA.ESPERANDO_DIRECCION: {
            if (!mensaje || mensaje.trim().length < 5) {
                await sock.sendMessage(jid, { text: '📍 Envíame tu *dirección completa* incluyendo ciudad:' });
                return true;
            }
            proceso.datos.direccion = mensaje.trim();
            proceso.paso = PASOS_COMPRA.CONFIRMANDO_DIRECCION;
            await sock.sendMessage(jid, {
                text: `🔎 ¿Estás seguro que tu dirección es *${proceso.datos.direccion}*?\n\nResponde *SÍ* para confirmar o *NO* para corregirla.`
            });
            return true;
        }

        case PASOS_COMPRA.CONFIRMANDO_DIRECCION: {
            if (esRespuestaAfirmativa(mensaje)) {
                proceso.paso = PASOS_COMPRA.ESPERANDO_METODO_PAGO;
                await sock.sendMessage(jid, {
                    text: '✅ Dirección confirmada.\n\n💳 ¿Cómo deseas realizar el pago?\n\n1️⃣ Bancolombia\n2️⃣ Nequi\n\nResponde con el número (1 o 2):'
                });
                return true;
            }

            if (esRespuestaNegativa(mensaje)) {
                proceso.paso = PASOS_COMPRA.ESPERANDO_DIRECCION;
                await sock.sendMessage(jid, {
                    text: '📍 Sin problema. Envíame de nuevo tu *dirección completa* (incluye barrio y ciudad):'
                });
                return true;
            }

            await sock.sendMessage(jid, {
                text: `Necesito que me confirmes 🙏\n\n¿Tu dirección es *${proceso.datos.direccion}*?\nResponde *SÍ* o *NO*.`
            });
            return true;
        }

        case PASOS_COMPRA.ESPERANDO_METODO_PAGO: {
            const opcion = (mensaje || '').trim().toLowerCase();
            let metodoPago, numeroCuenta, detalleExtra;

            if (opcion === '1' || opcion.includes('bancolombia')) {
                metodoPago = 'Bancolombia';
                numeroCuenta = CONFIG_VENTAS.CUENTA_BANCOLOMBIA;
                detalleExtra = `\n👤 *Titular:* ${CONFIG_VENTAS.TITULAR_CUENTA}`;
            } else if (opcion === '2' || opcion.includes('nequi')) {
                metodoPago = 'Nequi';
                numeroCuenta = CONFIG_VENTAS.NUMERO_NEQUI;
                detalleExtra = '';
            } else {
                await sock.sendMessage(jid, {
                    text: '❌ Opción no válida. Responde:\n1️⃣ para Bancolombia\n2️⃣ para Nequi'
                });
                return true;
            }

            proceso.datos.metodoPago = metodoPago;
            proceso.datos.numeroCuenta = numeroCuenta;
            proceso.paso = PASOS_COMPRA.ESPERANDO_COMPROBANTE;

            await sock.sendMessage(jid, {
                text: `✅ Listo. Realiza la transferencia a:\n\n💳 *${metodoPago}*\n📱 *Número:* ${numeroCuenta}${detalleExtra}\n💰 *Monto:* $ ${proceso.pedido.total}\n\n📸 Por seguridad, cuando hagas la transferencia *envía la foto del comprobante* para confirmar tu pedido.`
            });
            return true;
        }

        case PASOS_COMPRA.ESPERANDO_COMPROBANTE: {
            if (!esImagen) {
                await sock.sendMessage(jid, {
                    text: '📸 Para confirmar tu pedido necesito la *foto del comprobante* de la transferencia.'
                });
                return true;
            }

            proceso.datos.comprobante = 'Recibido y adjunto';

            await sock.sendMessage(jid, {
                text: `✅ *¡Pedido confirmado!*\n\n🧾 Pedido: *${proceso.pedido.numeroPedido}*\n🎉 Recibimos tu comprobante de pago.\n📦 Verificaremos la transferencia y despacharemos tu pedido.\n\n¡Gracias por tu compra en AG Accesorios! 💍✨`
            });

            await enviarNotificacionPedido(sock, proceso, bufferImagen);

            procesosCompra.delete(jid);
            return true;
        }
    }

    return false;
}

async function enviarNotificacionPedido(sock, proceso, comprobanteBuffer) {
    const { pedido, datos, jid } = proceso;
    const telefonoCliente = jid.split('@')[0];

    try {
        const pdfBuffer = await generarPDFPedido(pedido, datos, telefonoCliente);

        await sock.sendMessage(CONFIG_VENTAS.NUMERO_NOTIFICACIONES, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: `Pedido-${pedido.numeroPedido}-${datos.nombre.replace(/[^\w\s]/g, '').trim()}.pdf`,
            caption: `🔔 Nuevo pedido *${pedido.numeroPedido}*\n👤 ${datos.nombre}\n💰 $ ${pedido.total}\n💳 ${datos.metodoPago}\n📱 wa.me/${telefonoCliente}`
        });

        if (comprobanteBuffer) {
            const comprobanteOptimizado = await optimizarImagen(comprobanteBuffer);
            await sock.sendMessage(CONFIG_VENTAS.NUMERO_NOTIFICACIONES, {
                image: comprobanteOptimizado,
                caption: `📸 Comprobante de pago - ${pedido.numeroPedido} - ${datos.nombre}`
            });
        }

        console.log(`✅ PDF y comprobante enviados al administrador (${pedido.numeroPedido})`);
    } catch (error) {
        console.error('❌ Error enviando notificación:', error);

        try {
            await sock.sendMessage(CONFIG_VENTAS.NUMERO_NOTIFICACIONES, {
                text: `🔔 *NUEVO PEDIDO* (fallo el PDF)\n\n` +
                      `🧾 ${pedido.numeroPedido}\n` +
                      `👤 ${datos.nombre}\n` +
                      `📱 ${telefonoCliente}\n` +
                      `📍 ${datos.direccion}\n` +
                      `💳 ${datos.metodoPago} - ${datos.numeroCuenta}\n` +
                      `💰 $ ${pedido.total}\n\n` +
                      `📦 Detalle:\n${pedido.textoCompleto}`
            });
        } catch (e) {
            console.error('❌ Error enviando respaldo en texto:', e);
        }
    }
}
// ========== FIN SISTEMA DE COMPRAS ==========

const historial = new Map();
const ultimoMensaje = new Map();

function obtenerHistorial(jid) {
    if (!historial.has(jid)) historial.set(jid, []);
    return historial.get(jid);
}

function agregarAlHistorial(jid, role, content) {
    const h = obtenerHistorial(jid);
    h.push({ role, content });
    while (h.length > MAX_MENSAJES_HISTORIAL) h.shift();
}

function buscarRespuestaCache(texto) {
    const textoLimpio = texto.toLowerCase().trim();
    for (const [clave, respuesta] of Object.entries(PREGUNTAS_FRECUENTES)) {
        if (textoLimpio.includes(clave)) return respuesta;
    }
    return null;
}

function esTemaProhibido(texto) {
    const textoLimpio = texto.toLowerCase();
    return TEMAS_PROHIBIDOS.some((tema) => textoLimpio.includes(tema));
}

function respuestaFueraDeTema() {
    return `Solo puedo ayudarte con nuestras joyas y accesorios 💍. ¿Te gustaría ver nuestro catálogo? 👉 ${CONFIG_VENTAS.URL_CATALOGO} ✨`;
}

async function optimizarImagen(buffer) {
    try {
        const imagen = sharp(buffer);
        const metadata = await imagen.metadata();

        if (metadata.width > MAX_ANCHO_IMAGEN) {
            return await imagen
                .resize(MAX_ANCHO_IMAGEN, null, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: CALIDAD_JPEG })
                .toBuffer();
        }

        return await imagen.jpeg({ quality: CALIDAD_JPEG }).toBuffer();
    } catch (error) {
        console.error('Error optimizando imagen:', error);
        return buffer;
    }
}

async function generarRespuesta(jid, textoUsuario, imagenBase64) {
    const historialPrevio = obtenerHistorial(jid);

    const contenidoUsuario = imagenBase64
        ? [
            { type: 'text', text: textoUsuario || '¿Qué joya es?' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imagenBase64}` } }
        ]
        : textoUsuario;

    const mensajes = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...historialPrevio.slice(-4),
        { role: 'user', content: contenidoUsuario }
    ];

    const completion = await openai.chat.completions.create({
        model: MODELO_TEXTO,
        messages: mensajes,
        max_tokens: MAX_TOKENS_RESPUESTA,
        temperature: 0.7
    });

    const respuesta = completion.choices[0].message.content.trim();

    agregarAlHistorial(jid, 'user', textoUsuario || '[IMG]');
    agregarAlHistorial(jid, 'assistant', respuesta);

    return respuesta;
}

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Escanea este código QR desde WhatsApp > Dispositivos vinculados:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const debeReconectar = codigo !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada.', lastDisconnect?.error?.message || '', '¿Reconectar?', debeReconectar);
            if (debeReconectar) {
                iniciarBot();
            } else {
                console.log('Sesión cerrada. Borra la carpeta auth_info_baileys y vuelve a escanear el QR.');
            }
        } else if (connection === 'open') {
            console.log('✅ Bot conectado a WhatsApp.');
            console.log(`📄 Los PDF de pedidos se enviarán a: ${CONFIG_VENTAS.NUMERO_NOTIFICACIONES}`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;
                if (jid.endsWith('@g.us')) continue;

                // ✅ IGNORA MENSAJES ANTIGUOS (más de 30 segundos)
                const messageTimestamp = msg.messageTimestamp * 1000;
                const now = Date.now();
                const messageAge = now - messageTimestamp;
                
                if (messageAge > 30000) {
                    console.log(`⏭️  Mensaje antiguo ignorado de ${jid} (${Math.floor(messageAge / 1000)}s de antigüedad)`);
                    continue;
                }

                const esImagen = !!msg.message.imageMessage;

                const texto =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    '';

                if (!texto && !esImagen) continue;

                const claveMensaje = `${jid}-${texto}-${esImagen}`;
                const ahora = Date.now();
                const ultimoTiempo = ultimoMensaje.get(claveMensaje);

                if (ultimoTiempo && (ahora - ultimoTiempo) < 2000) {
                    console.log(`⏭️  Mensaje duplicado ignorado de ${jid}`);
                    continue;
                }
                ultimoMensaje.set(claveMensaje, ahora);

                console.log(`📩 ${jid}: ${texto.slice(0, 60)}${esImagen ? ' [imagen]' : ''}`);

                // PRIORIDAD 1: compra en curso
                if (procesosCompra.has(jid)) {
                    let bufferImagen = null;
                    if (esImagen) {
                        bufferImagen = await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                        );
                    }

                    await procesarRespuestaCompra(sock, jid, texto, esImagen, bufferImagen);
                    continue;
                }

                // PRIORIDAD 2: nuevo pedido formal
                if (detectarPedidoFormal(texto)) {
                    const pedido = extraerInfoPedido(texto);
                    await iniciarProcesoCompra(sock, jid, pedido);
                    console.log(`🛒 Pedido ${pedido.numeroPedido} iniciado para ${jid}`);
                    continue;
                }

                // PRIORIDAD 3: filtros y respuestas normales
                if (!esImagen && texto && esTemaProhibido(texto)) {
                    await sock.sendMessage(jid, { text: respuestaFueraDeTema() });
                    console.log(`🚫 → ${jid}: [Tema prohibido]`);
                    continue;
                }

                if (!esImagen && texto) {
                    const respuestaCache = buscarRespuestaCache(texto);
                    if (respuestaCache) {
                        await sock.sendMessage(jid, { text: respuestaCache });
                        console.log(`💾 → ${jid}: [Caché]`);
                        continue;
                    }
                }

                let imagenBase64 = null;
                if (esImagen) {
                    await sock.sendPresenceUpdate('composing', jid);

                    let buffer = await downloadMediaMessage(
                        msg,
                        'buffer',
                        {},
                        { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );

                    buffer = await optimizarImagen(buffer);
                    imagenBase64 = buffer.toString('base64');
                }

                await sock.sendPresenceUpdate('composing', jid);

                const respuesta = await generarRespuesta(jid, texto, imagenBase64);

                await sock.sendMessage(jid, { text: respuesta });
                console.log(`🤖 → ${jid}: ${respuesta.slice(0, 50)}...`);

            } catch (err) {
                // ✅ MANEJO ESPECÍFICO DE ERRORES DE CIFRADO
                if (err.message && err.message.includes('Bad MAC')) {
                    console.log(`⚠️  Error de cifrado (mensaje antiguo ignorado) - ${msg.key.remoteJid}`);
                    continue;
                }

                console.error('Error procesando mensaje:', err);

                try {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: 'Disculpa, tuve un problema procesando tu mensaje. ¿Puedes intentarlo de nuevo? 🙏'
                    });
                } catch (e) {
                    console.error('Error enviando mensaje de error:', e);
                }
            }
        }
    });
}

iniciarBot().catch((err) => {
    console.error('Error al iniciar el bot:', err);
    process.exit(1);
});
