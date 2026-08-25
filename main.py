import os
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import AsyncOpenAI
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

client = AsyncOpenAI(
    api_key=os.getenv("OPENROUTER_API_KEY"),
    base_url="https://openrouter.ai/api/v1"
)

class Message(BaseModel):
    role: str
    content: str

class ChatPayload(BaseModel):
    messages: list[Message]

@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    file_path = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(file_path):
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()
    return f"<h1>Error: No se encontró index.html</h1>"

@app.post("/api/chat")
async def chat_endpoint(payload: ChatPayload):
    try:
        user_messages = [msg.model_dump() for msg in payload.messages]
        
        system_instruction = {
            "role": "system",
            "content": (
                "Eres Omely, un asistente de élite especializado en medicina, farmacología y salud. "
                "Reglas estrictas:\n"
                "- Responde con precisión y claridad\n"
                "- Si falta información, pregunta antes de responder\n"
                "- Recomienda consultar con médico para casos graves\n"
                "- Sé profesional, empática y concisa\n"
                "- Usa lenguaje médico accesible\n"
                "- No inventes información que no tengas"
            )
        }

        messages_to_send = [system_instruction] + user_messages

        # Usamos el modelo gratuito oficial de OpenRouter
        response = await client.chat.completions.create(
            model="meta-llama/llama-3.3-70b-instruct:free",
            messages=messages_to_send,
            temperature=0.3,
            max_tokens=800
        )

        return {
            "response": response.choices[0].message.content,
            "provider": response.model,
            "tokens_used": response.usage.total_tokens if hasattr(response, 'usage') else 0
        }

    except Exception as e:
        error_msg = str(e)
        
        if "credits" in error_msg.lower() or "insufficient" in error_msg.lower():
            error_msg = "No tienes suficientes créditos en OpenRouter. Visita https://openrouter.ai/settings/credits para recargar."
        elif "rate limit" in error_msg.lower():
            error_msg = "Has excedido el límite de peticiones. Espera un momento y vuelve a intentar."
        elif "timeout" in error_msg.lower():
            error_msg = "La petición ha tardado demasiado. Intenta con un mensaje más corto."
        
        raise HTTPException(status_code=500, detail={"message": error_msg})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)s