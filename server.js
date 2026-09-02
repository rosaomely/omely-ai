import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { promises as fs } from 'fs';
import mammoth from 'mammoth';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

const OLLAMA_URL = "http://localhost:11434/api/generate";
const HISTORIAL_PATH = path.join(__dirname, 'historial_chats.json');
const APRENDIZAJE_PATH = path.join(__dirname, 'memoria_aprendizaje.json');

// --- WORKER GLOBAL DE TESSERACT (OPTIMIZACIÓN DE VELOCIDAD OCR) ---
let tesseractWorker = null;
async function getTesseractWorker() {
    if (!tesseractWorker) {
        tesseractWorker = await createWorker('spa');
    }
    return tesseractWorker;
}

// --- DETECTOR DE IA ---
function detectarIA(texto) {
    if (!texto) return { porcentaje: 0, cliches: [] };

    const clichesDetector = [
        "es crucial destacar", "en el panorama actual", "por lo tanto", 
        "en resumen", "es importante mencionar", "además", "por consiguiente", 
        "en conclusión", "demuestra claramente", "sin embargo", "no obstante", 
        "debido a que", "comunicarse", "utilizar", "adquirir", 
        "fundamental", "cabe destacar", "hoy en día", "al final del día", 
        "en mi opinión", "quiero decir que", "es como si", "se llevan a cabo",
        "por lo general", "de manera eficiente", "software super avanzado"
    ];

    const textoLower = texto.toLowerCase();
    let encontrados = [];
    let contador = 0;

    for (let cliche of clichesDetector) {
        if (textoLower.includes(cliche)) {
            encontrados.push(cliche);
            const matches = textoLower.match(new RegExp(cliche, 'g'));
            if (matches) contador += matches.length;
        }
    }

    const palabrasTotales = texto.split(/\s+/).length;
    if (palabrasTotales === 0) return { porcentaje: 0, cliches: [] };

    let porcentaje = Math.min(100, Math.floor((contador * 100) / Math.max(palabrasTotales, 10) + (contador * 15)));
    if (porcentaje > 98) porcentaje = 98;
    if (contador === 0) porcentaje = 8;

    return { porcentaje, cliches: Array.from(new Set(encontrados)) };
}

// --- RUTA DE ANÁLISIS ---
app.post('/api/analizar-ia', (req, res) => {
    const { texto } = req.body;
    const analisis = detectarIA(texto);
    return res.json(analisis);
});

// --- RUTA DE PARAFRASEO Y HUMANIZACIÓN ---
app.post('/api/humanizar', async (req, res) => {
    try {
        const { texto, tipo, modelo } = req.body;
        if (!texto) return res.status(400).json({ error: "Texto vacío" });

        const modeloActivo = modelo || "llama3.2";
        let promptInstruccionEspecial = "";

        if (tipo === 'parafrasear') {
            promptInstruccionEspecial = `Parafrasea el siguiente texto manteniendo estrictamente su significado original, pero cambiando la redacción para que suene natural, fluida y escrita por una persona real. Elimina clichés formales y varía la longitud de las oraciones sin perder información clave. No agregues saludos ni explicaciones, entrega solo el texto transformado:

Texto original: "${texto}"
Texto parafraseado:`;
        } else {
            promptInstruccionEspecial = `Humaniza el tono del siguiente texto para que suene cálido, conversacional y cercano, conservando absolutamente todas las ideas centrales sin distorsionarlas ni inventar datos nuevos. No agregues saludos ni explicaciones, entrega solo el texto transformado:

Texto original: "${texto}"
Texto humanizado:`;
        }

        const response = await fetch(OLLAMA_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: modeloActivo,
                prompt: promptInstruccionEspecial,
                stream: false,
                options: { 
                    temperature: 0.7,
                    top_p: 0.9,
                    num_predict: 500
                }
            })
        });

        if (!response.ok) throw new Error("Error al conectar con Ollama.");

        const data = await response.json();
        let resultadoFinal = data.response ? data.response.trim() : texto;
        resultadoFinal = resultadoFinal.replace(/^["']|["']$/g, '');

        return res.json({ resultado: resultadoFinal });
    } catch (error) {
        console.error("Error en procesamiento:", error);
        return res.status(500).json({ error: "No se pudo procesar el texto." });
    }
});

// --- RUTA PARA CONSULTAS INDEPENDIENTES A GEMINI ---
app.post('/api/gemini-independiente', async (req, res) => {
    try {
        const { mensaje } = req.body;
        if (!mensaje) return res.status(400).json({ error: "Mensaje vacío" });

        const geminiApiKey = process.env.GEMINI_API_KEY || "TU_API_KEY_DE_GEMINI"; 
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: mensaje }] }]
            })
        });

        if (!geminiRes.ok) throw new Error("Error al conectar con la API de Gemini.");

        const geminiData = await geminiRes.json();
        const respuestaGemini = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "Sin respuesta.";

        return res.json({ respuesta: respuestaGemini });
    } catch (error) {
        console.error("Error en Gemini independiente:", error);
        return res.status(500).json({ error: "No se pudo procesar la consulta en Gemini." });
    }
});

async function inicializarArchivos() {
    try {
        await fs.access(HISTORIAL_PATH).catch(async () => {
            await fs.writeFile(HISTORIAL_PATH, JSON.stringify({ chats: [], ultimaRevision: Date.now() }, null, 2));
        });
        await fs.access(APRENDIZAJE_PATH).catch(async () => {
            await fs.writeFile(APRENDIZAJE_PATH, JSON.stringify({ retroalimentacion: [] }, null, 2));
        });
    } catch (error) {
        console.error("Error al inicializar archivos:", error);
    }
}

inicializarArchivos();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/historial', async (req, res) => {
    try {
        if (await fs.stat(HISTORIAL_PATH).catch(() => false)) {
            const dataArchivo = await fs.readFile(HISTORIAL_PATH, 'utf8');
            const data = JSON.parse(dataArchivo);
            return res.json(data.chats);
        }
        return res.json([]);
    } catch (error) {
        return res.status(500).json({ error: "No se pudo recuperar el historial." });
    }
});

app.delete('/api/historial', async (req, res) => {
    try {
        await fs.writeFile(HISTORIAL_PATH, JSON.stringify({ chats: [], ultimaRevision: Date.now() }, null, 2));
        return res.json({ mensaje: "Historial eliminado definitivamente." });
    } catch (error) {
        return res.status(500).json({ error: "No se pudo limpiar el historial." });
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { mensaje, archivoContenido, archivoNombre, historialChat, modelo } = req.body;

        if ((!mensaje || !mensaje.trim()) && !archivoContenido) {
            return res.status(400).json({ error: "El mensaje no puede estar vacío." });
        }

        const modeloActivo = modelo || "llama3.2";
        let textoExtraidoDelArchivo = "";

        if (archivoContenido && archivoNombre) {
            const extension = archivoNombre.split('.').pop().toLowerCase();
            const bufferBase64 = Buffer.from(archivoContenido.split(',')[1] || archivoContenido, 'base64');

            if (extension === 'pdf') {
                const parsed = await pdfParse(bufferBase64);
                textoExtraidoDelArchivo = parsed.text;
            } else if (extension === 'docx') {
                const result = await mammoth.extractRawText({ buffer: bufferBase64 });
                textoExtraidoDelArchivo = result.value;
            } else if (['jpg', 'jpeg', 'png'].includes(extension)) {
                const worker = await getTesseractWorker();
                const ret = await worker.recognize(archivoContenido);
                textoExtraidoDelArchivo = ret.data.text;
            } else {
                textoExtraidoDelArchivo = bufferBase64.toString('utf8');
            }
        }

        const mensajeMinuscula = mensaje ? mensaje.toLowerCase() : "";
        
        let ultimoTextoAI = "";
        let contextoConversacion = "";
        if (historialChat && Array.isArray(historialChat)) {
            const ultimosTurnos = historialChat.slice(-3);
            ultimosTurnos.forEach(turn => {
                const textoP = turn.pregunta || '';
                const textoR = turn.respuesta || '';
                if (textoP) contextoConversacion += `Usuario: ${textoP}\n`;
                if (textoR) {
                    contextoConversacion += `Omely: ${textoR}\n`;
                    ultimoTextoAI = textoR;
                }
            });
        }

        let promptActual = mensaje || "Analiza el contenido del archivo adjunto:";
        if (textoExtraidoDelArchivo) {
            promptActual = `[Archivo adjuntado: ${archivoNombre}]\nContenido:\n${textoExtraidoDelArchivo}\n\nInstrucción: ${promptActual}`;
        }

        const pideIngles = mensajeMinuscula.includes('en ingles') || mensajeMinuscula.includes('en inglés') || mensajeMinuscula.includes('al ingles') || mensajeMinuscula.includes('al inglés') || mensajeMinuscula.includes('translate');
        const pideEspanol = mensajeMinuscula.includes('en español') || mensajeMinuscula.includes('en espanol') || mensajeMinuscula.includes('al español') || mensajeMinuscula.includes('al espanol');
        const esTraduccionCorta = mensajeMinuscula.includes('tradúcelo') || mensajeMinuscula.includes('traducelo') || mensajeMinuscula.includes('hazlo');

        let promptInstruccion = "";

        if (pideIngles) {
            let partes = mensaje.split(/:|–|-/);
            let textoATraducir = partes.length > 1 ? partes.slice(1).join(':').trim() : "";
            
            if (!textoATraducir || textoATraducir.length < 3) {
                textoATraducir = ultimoTextoAI;
            }

            promptInstruccion = `Traduce el siguiente texto al inglés (utilizando estrictamente las normas gramaticales, ortográficas y de vocabulario del inglés de Estados Unidos / American English). 

REGLA ABSOLUTA: PROHIBIDO agregar comentarios, opiniones, saludos, explicaciones ni introducciones. Devuelve únicamente el texto traducido y absolutamente nada más desde la primera palabra.

Texto a traducir:
"${textoATraducir}"

Traducción:`;
        } 
        else if (pideEspanol) {
            let partes = mensaje.split(/:|–|-/);
            let textoATraducir = partes.length > 1 ? partes.slice(1).join(':').trim() : "";
            
            if (!textoATraducir || textoATraducir.length < 3) {
                textoATraducir = ultimoTextoAI;
            }

            promptInstruccion = `Traduce el siguiente texto al español de manera natural, impecable y fluida.

REGLA ABSOLUTA: PROHIBIDO agregar comentarios, opiniones, saludos, explicaciones ni introducciones. Devuelve únicamente el texto traducido y absolutamente nada más desde la primera palabra.

Texto a traducir:
"${textoATraducir}"

Traducción:`;
        } 
        else if (esTraduccionCorta && ultimoTextoAI) {
            promptInstruccion = `Traduce el siguiente texto al inglés (utilizando estrictamente las normas gramaticales, ortográficas y de vocabulario del inglés de Estados Unidos / American English). 

REGLA ABSOLUTA: PROHIBIDO agregar comentarios, opiniones, saludos, explicaciones ni introducciones. Devuelve únicamente el texto traducido y absolutamente nada más desde la primera palabra.

Texto a traducir:
"${ultimoTextoAI}"

Traducción:`;
        } 
        else {
            // PROMPT DE ASISTENTE EXPERTO MULTIDISCIPLINARIO
            promptInstruccion = `Eres Omely AI, un asistente de inteligencia artificial avanzado, altamente competente, preciso y experto en cualquier área del conocimiento (ciencia, tecnología, programación, cultura, historia, etc.). 

DIRECTRICES DE RESPUESTA:
1. Responde de manera directa, clara, objetiva y con un alto nivel de precisión técnica o teórica según lo requiera la pregunta.
2. Explica los conceptos de forma estructurada y profesional, evitando rodeos innecesarios o suposiciones sobre la vida personal del usuario.
3. Si la pregunta es técnica (como programación, hardware, software o definiciones), aporta explicaciones técnicas exactas, ejemplos o definiciones claras.
4. Mantén un tono servicial, inteligente y natural en español.

Historial reciente:
${contextoConversacion}
Usuario: ${promptActual}
Omely:`;
        }

        const response = await fetch(OLLAMA_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: modeloActivo,
                prompt: promptInstruccion,
                stream: false,
                keep_alive: "30m",
                options: { 
                    num_predict: 600,     
                    temperature: 0.5,     // Temperatura más baja para respuestas más objetivas, precisas y directas
                    top_k: 40,            
                    top_p: 0.9,
                    num_thread: 4         
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama respondió con estado: ${response.status}`);
        }

        const data = await response.json();
        let respuestaIA = data.response ? data.response.trim() : "Sin respuesta.";
        respuestaIA = respuestaIA.replace(/^["']|["']$/g, '');

        try {
            const historialData = JSON.parse(await fs.readFile(HISTORIAL_PATH, 'utf8'));
            historialData.chats.push({
                timestamp: Date.now(),
                pregunta: promptActual,
                respuesta: respuestaIA
            });
            await fs.writeFile(HISTORIAL_PATH, JSON.stringify(historialData, null, 2));
        } catch (err) {
            console.error("Error al actualizar historial:", err);
        }

        return res.json({ respuesta: respuestaIA });

    } catch (error) {
        console.error("Error en el servidor:", error);
        return res.status(500).json({ error: `Error: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de Omely Activo en: http://localhost:${PORT}`);
});