import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';
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
const MODELO_LOCAL = "llama3.2";
const HISTORIAL_PATH = path.join(__dirname, 'historial_chats.json');

// Función para cargar y limpiar historiales mayores a 90 días
function gestionarHistorial() {
    if (!fs.existsSync(HISTORIAL_PATH)) {
        fs.writeFileSync(HISTORIAL_PATH, JSON.stringify({ chats: [], ultimaRevision: Date.now() }));
    }
    
    const data = JSON.parse(fs.readFileSync(HISTORIAL_PATH, 'utf8'));
    const noventaDiasMs = 90 * 24 * 60 * 60 * 1000;
    const ahora = Date.now();

    // Filtrar chats con menos de 90 días
    const chatsValidos = data.chats.filter(chat => (ahora - chat.timestamp) < noventaDiasMs);
    
    if (chatsValidos.length < data.chats.length) {
        data.chats = chatsValidos;
        fs.writeFileSync(HISTORIAL_PATH, JSON.stringify(data, null, 2));
    }
}

gestionarHistorial();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint para obtener conversaciones guardadas
app.get('/api/historial', (req, res) => {
    if (fs.existsSync(HISTORIAL_PATH)) {
        const data = JSON.parse(fs.readFileSync(HISTORIAL_PATH, 'utf8'));
        res.json(data.chats);
    } else {
        res.json([]);
    }
});

// Endpoint para eliminar el historial definitivamente
app.delete('/api/historial', (req, res) => {
    fs.writeFileSync(HISTORIAL_PATH, JSON.stringify({ chats: [], ultimaRevision: Date.now() }));
    res.json({ mensaje: "Historial eliminado definitivamente." });
});

// Endpoint POST /api/chat con almacenamiento de memoria local
app.post('/api/chat', async (req, res) => {
    try {
        const { mensaje, archivoContenido, archivoNombre } = req.body;

        if ((!mensaje || !mensaje.trim()) && !archivoContenido) {
            return res.status(400).json({ error: "El mensaje no puede estar vacío." });
        }

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
                const worker = await createWorker('spa');
                const ret = await worker.recognize(archivoContenido);
                textoExtraidoDelArchivo = ret.data.text;
                await worker.terminate();
            } else {
                textoExtraidoDelArchivo = bufferBase64.toString('utf8');
            }
        }

        let promptCompleto = mensaje || "Analiza el contenido del archivo adjunto:";
        if (textoExtraidoDelArchivo) {
            promptCompleto = `[Archivo adjuntado: ${archivoNombre}]\nContenido:\n${textoExtraidoDelArchivo}\n\nInstrucción: ${promptCompleto}`;
        }

        const promptInstruccion = `Eres un asistente experto en programación, bases de datos, computación, historia, proyectos, Normas APA, noticias, diseño, presentaciones y análisis de documentos.

Instrucciones obligatorias:
1. Tu idioma principal y exclusivo es el ESPAÑOL. Responde SIEMPRE en español.
2. NO saludes.
3. NO digas quién eres ni menciones frases de cortesía o introducción.
4. Responde ÚNICAMENTE, de forma directa, específica y técnica a lo que se pregunta, usando la primera persona cuando aplique y con verbos ser/estar correctos.
5. Si tienes dudas o no entiendes la consulta, haz una pregunta directa al usuario en lugar de asumir.

Consulta: ${promptCompleto}
Respuesta:`;

        const response = await fetch(OLLAMA_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: MODELO_LOCAL,
                prompt: promptInstruccion,
                stream: false,
                options: { num_predict: 800, temperature: 0.2, top_k: 20 }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama respondió con estado: ${response.status}`);
        }

        const data = await response.json();
        const respuestaIA = data.response ? data.response.trim() : "Sin respuesta.";

        // Guardar en el historial local (retención de 90 días)
        const historialData = JSON.parse(fs.readFileSync(HISTORIAL_PATH, 'utf8'));
        historialData.chats.push({
            timestamp: Date.now(),
            pregunta: promptCompleto,
            respuesta: respuestaIA
        });
        fs.writeFileSync(HISTORIAL_PATH, JSON.stringify(historialData, null, 2));

        return res.json({ respuesta: respuestaIA });

    } catch (error) {
        console.error("Error en el servidor:", error);
        return res.status(500).json({ error: `Error: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor local activo y listo en: http://localhost:${PORT}`);
});