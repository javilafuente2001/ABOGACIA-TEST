import json
import os
import re
import unicodedata
from datetime import datetime
from typing import Any, Dict, List, Optional

import fitz  # PyMuPDF
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None

try:
    from google import genai
except Exception:  # pragma: no cover
    genai = None

try:
    import openpyxl
except Exception:  # pragma: no cover
    openpyxl = None

APP_VERSION = "2.4-pdf-safe-pause-solutions"
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
GEMINI_MODELS = [
    model.strip()
    for model in os.getenv(
        "GEMINI_MODELS",
        "gemini-2.5-flash-lite,gemini-2.5-flash,gemini-2.0-flash,gemini-2.0-flash-lite"
    ).split(",")
    if model.strip()
]
if GEMINI_MODEL and GEMINI_MODEL not in GEMINI_MODELS:
    GEMINI_MODELS.insert(0, GEMINI_MODEL)

app = FastAPI(title="Abogacía Test", version=APP_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def strip_accents(value: str) -> str:
    value = unicodedata.normalize("NFD", value)
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    return value


def normalize_space(value: str) -> str:
    value = value.replace("\u2011", "-").replace("\ufffe", "-").replace("\u00ad", "")
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def is_red_color(color: Optional[int]) -> bool:
    if color is None:
        return False
    r = (int(color) >> 16) & 255
    g = (int(color) >> 8) & 255
    b = int(color) & 255
    return r > 140 and g < 90 and b < 90


def line_text_with_red(line: Dict[str, Any]) -> Dict[str, Any]:
    """Return text plus reliable red-character information for a PDF line.

    The official templates mark the correct option in red. The previous
    version only stored a boolean per line; this version stores how many
    red characters belong to each line so that the parser can decide the
    correct answer at question-finalization time instead of overwriting it
    while reading line continuations.
    """
    text_parts: List[str] = []
    red_parts: List[str] = []
    red_chars = 0
    total_chars = 0

    for span in line.get("spans", []):
        txt = span.get("text", "") or ""
        if not txt:
            continue
        text_parts.append(txt)
        clean_len = len(txt.strip())
        total_chars += clean_len
        if is_red_color(span.get("color")):
            red_parts.append(txt)
            red_chars += clean_len

    bbox = line.get("bbox", [0, 0, 0, 0])
    return {
        "text": normalize_space("".join(text_parts)),
        "red": red_chars > 0,
        "red_chars": red_chars,
        "red_text": normalize_space("".join(red_parts)),
        "total_chars": total_chars,
        "y": bbox[1],
        "x": bbox[0],
    }


def extract_pdf_lines(file_bytes: bytes) -> List[Dict[str, Any]]:
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    lines: List[Dict[str, Any]] = []
    for page_index, page in enumerate(doc):
        data = page.get_text("dict")
        page_lines: List[Dict[str, Any]] = []
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                item = line_text_with_red(line)
                text = item["text"]
                if not text:
                    continue
                if re.fullmatch(r"\d+", text):
                    # Page number. Real questions have a separator after the number.
                    continue
                item["page"] = page_index + 1
                page_lines.append(item)
        page_lines.sort(key=lambda it: (round(it["y"], 1), round(it["x"], 1)))
        lines.extend(page_lines)
    return lines


QUESTION_RE = re.compile(r"^(\d{1,3})\s*(?:[\-–—]+|\.(?!\d))\s*(.*)$")
OPTION_RE = re.compile(r"^([a-zA-Z])\)\s*(.*)$")


def area_from_line(text: str) -> Optional[str]:
    # Never classify a real numbered question as a section heading.
    # Some questions contain words like "especialidad" and
    # "contencioso-administrativo", which previously made the parser
    # lose that question.
    if QUESTION_RE.match(text):
        return None
    low = strip_accents(text).lower()
    if "materias comunes" in low:
        return "general"
    if "administrativo" in low and "contencioso" in low and "especialidad" in low:
        return "administrativo"
    if "especialidad juridica" in low and "administrativo" not in low:
        return "other"
    # Some PDFs split the heading in two lines; this catches the specific line.
    if "administrativo y contencioso" in low:
        return "administrativo"
    return None


def new_question(area: str, number: int, reserve: bool, page: int) -> Dict[str, Any]:
    return {
        "id": "",
        "area": area,
        "number": number,
        "reserve": reserve,
        "question": "",
        "options": [],
        "correct": None,
        "source_page": page,
    }


def register_option_red(q: Dict[str, Any], option_index: int, raw_line: Dict[str, Any]) -> None:
    if option_index < 0 or option_index >= len(q.get("options", [])):
        return
    red_chars = int(raw_line.get("red_chars", 0) or 0)
    if red_chars <= 0:
        return
    opt = q["options"][option_index]
    opt["_red_chars"] = int(opt.get("_red_chars", 0) or 0) + red_chars
    if raw_line.get("red_text"):
        opt.setdefault("_red_text", [])
        opt["_red_text"].append(str(raw_line.get("red_text")))


def is_annulled_question_text(text: str) -> bool:
    low = strip_accents(text).upper()
    return "ANULADA" in low or "PREGUNTA ANULADA" in low


def finalize_question(q: Optional[Dict[str, Any]], questions: List[Dict[str, Any]], exam_slug: str) -> None:
    if not q:
        return

    q["question"] = normalize_space(q.get("question", ""))

    if is_annulled_question_text(q["question"]):
        # Official templates sometimes write only "ANULADA" and use reserve
        # questions instead. We do not keep the annulled item as a test question.
        return

    cleaned_options: List[Dict[str, Any]] = []
    for opt in q.get("options", []):
        text = normalize_space(opt.get("text", ""))
        key = str(opt.get("key", "")).lower().strip()
        if not key or not text:
            continue
        cleaned_options.append({
            "key": key,
            "text": text,
            "_red_chars": int(opt.get("_red_chars", 0) or 0),
            "_red_text": opt.get("_red_text", []),
        })

    if len(cleaned_options) < 2:
        return

    # Decide the correct answer from the complete option, not from the last
    # red line read. This avoids overwrites and supports options that wrap
    # across several lines.
    scored = [(opt["key"], int(opt.get("_red_chars", 0) or 0)) for opt in cleaned_options]
    positive = [(key, score) for key, score in scored if score > 0]
    correct: Optional[str] = None
    needs_review = False

    if len(positive) == 1:
        correct = positive[0][0]
    elif len(positive) > 1:
        ordered = sorted(positive, key=lambda item: item[1], reverse=True)
        # Very defensive fallback: if one option has almost all red text and
        # another only inherited a tiny artifact, accept the dominant one;
        # otherwise do not guess.
        if ordered[0][1] >= 8 and ordered[0][1] >= max(ordered[1][1] * 4, ordered[1][1] + 20):
            correct = ordered[0][0]
        else:
            needs_review = True
    else:
        needs_review = True

    q["options"] = [{"key": opt["key"], "text": opt["text"]} for opt in cleaned_options]
    q["red_scores"] = {key: score for key, score in scored}
    q["correct"] = correct
    q["needs_review"] = needs_review or correct not in [opt["key"] for opt in q["options"]]
    q["correct_source"] = "pdf_red" if not q["needs_review"] else "needs_review"
    q["id"] = f"{exam_slug}-{q['area']}-{'reserva' if q['reserve'] else 'principal'}-{q['number']}"
    questions.append(q)


def promote_reserve_substitutions(questions: List[Dict[str, Any]], pending_substitutions: Dict[str, List[int]]) -> None:
    """Promote reserve questions used to replace annulled main questions.

    Some official templates say e.g. "ANULADA. Se sustituye por la primera
    pregunta de reserva". If we simply drop the annulled question, the main
    test would have fewer questions. This promotes the first reserve questions
    of the same area into the main bank, preserving that they came from reserve
    and renumbering them as the annulled question they replace.
    """
    for area, annulled_numbers in pending_substitutions.items():
        if not annulled_numbers:
            continue
        replacements = list(annulled_numbers)
        replacement_index = 0
        for q in questions:
            if replacement_index >= len(replacements):
                break
            if q.get("area") == area and q.get("reserve"):
                original_reserve_number = q.get("number")
                q["reserve"] = False
                q["was_reserve_substitute"] = True
                q["original_reserve_number"] = original_reserve_number
                q["replaces_annulled_number"] = replacements[replacement_index]
                q["number"] = replacements[replacement_index]
                q["id"] = q["id"].replace("-reserva-", "-sustituta-")
                q["id"] = re.sub(r"-\d+$", f"-{q['number']}", q["id"])
                replacement_index += 1



def parse_pdf_questions(file_bytes: bytes, filename: str = "examen.pdf") -> Dict[str, Any]:
    lines = extract_pdf_lines(file_bytes)
    exam_name = os.path.splitext(os.path.basename(filename))[0].strip() or "Examen importado"
    exam_slug = re.sub(r"[^a-z0-9]+", "-", strip_accents(exam_name.lower())).strip("-")[:60] or "examen"

    questions: List[Dict[str, Any]] = []
    current_area: Optional[str] = None
    reserve = False
    q: Optional[Dict[str, Any]] = None
    current_option_index: Optional[int] = None
    pending_substitutions: Dict[str, List[int]] = {"general": [], "administrativo": []}

    for raw in lines:
        text = normalize_space(raw["text"])
        if not text:
            continue

        detected_area = area_from_line(text)
        if detected_area:
            finalize_question(q, questions, exam_slug)
            q = None
            current_option_index = None
            reserve = False
            current_area = detected_area
            continue

        low = strip_accents(text).lower()
        if "preguntas de reserva" in low:
            finalize_question(q, questions, exam_slug)
            q = None
            current_option_index = None
            reserve = True
            continue

        if current_area not in {"general", "administrativo"}:
            continue

        qm = QUESTION_RE.match(text)
        if qm:
            number = int(qm.group(1))
            after = normalize_space(qm.group(2))
            finalize_question(q, questions, exam_slug)
            q = None
            current_option_index = None

            if is_annulled_question_text(after):
                if current_area in pending_substitutions and not reserve:
                    pending_substitutions[current_area].append(number)
                continue

            q = new_question(current_area, number, reserve, int(raw.get("page", 0) or 0))
            q["question"] = after
            if raw.get("red"):
                q["has_red_in_question"] = True
            continue

        if q is None:
            continue

        om = OPTION_RE.match(text)
        if om:
            key = om.group(1).lower()
            option_text = normalize_space(om.group(2))
            q["options"].append({"key": key, "text": option_text, "_red_chars": 0, "_red_text": []})
            current_option_index = len(q["options"]) - 1
            register_option_red(q, current_option_index, raw)
            continue

        # Continuation line: it belongs to the current option if one has started; otherwise to the question.
        if current_option_index is not None and q.get("options"):
            q["options"][current_option_index]["text"] += " " + text
            register_option_red(q, current_option_index, raw)
        else:
            q["question"] += " " + text

    finalize_question(q, questions, exam_slug)
    promote_reserve_substitutions(questions, pending_substitutions)

    by_area = {
        "general": sum(1 for item in questions if item["area"] == "general" and not item["reserve"]),
        "general_reserva": sum(1 for item in questions if item["area"] == "general" and item["reserve"]),
        "administrativo": sum(1 for item in questions if item["area"] == "administrativo" and not item["reserve"]),
        "administrativo_reserva": sum(1 for item in questions if item["area"] == "administrativo" and item["reserve"]),
    }

    return {
        "source": "pdf",
        "exam_name": exam_name,
        "imported_at": datetime.utcnow().isoformat() + "Z",
        "questions": questions,
        "stats": {
            "total": len(questions),
            "by_area": by_area,
            "needs_review": sum(1 for item in questions if item.get("needs_review")),
        },
    }


def parse_excel_questions(file_bytes: bytes, filename: str = "examen.xlsx") -> Dict[str, Any]:
    if openpyxl is None:
        raise HTTPException(status_code=500, detail="openpyxl no está instalado en el servidor")

    from io import BytesIO

    wb = openpyxl.load_workbook(BytesIO(file_bytes), data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise HTTPException(status_code=400, detail="El Excel está vacío")

    headers = [strip_accents(str(h or "").strip().lower()) for h in rows[0]]

    def find_col(*names: str) -> Optional[int]:
        for name in names:
            n = strip_accents(name.lower())
            if n in headers:
                return headers.index(n)
        return None

    col_question = find_col("pregunta", "question", "enunciado")
    col_a = find_col("a", "opcion a", "respuesta a")
    col_b = find_col("b", "opcion b", "respuesta b")
    col_c = find_col("c", "opcion c", "respuesta c")
    col_d = find_col("d", "opcion d", "respuesta d")
    col_correct = find_col("correcta", "correct", "respuesta correcta")
    col_area = find_col("area", "bloque", "materia")
    col_reserve = find_col("reserva", "reserve")

    if None in [col_question, col_a, col_b, col_c, col_d, col_correct]:
        raise HTTPException(
            status_code=400,
            detail="El Excel debe tener columnas: pregunta, a, b, c, d, correcta. Opcionales: area, reserva.",
        )

    exam_name = os.path.splitext(os.path.basename(filename))[0].strip() or "Examen Excel"
    exam_slug = re.sub(r"[^a-z0-9]+", "-", strip_accents(exam_name.lower())).strip("-")[:60] or "excel"
    questions: List[Dict[str, Any]] = []

    for i, row in enumerate(rows[1:], start=1):
        question_text = normalize_space(str(row[col_question] or ""))
        if not question_text:
            continue
        correct = normalize_space(str(row[col_correct] or "")).lower()[:1]
        if correct not in {"a", "b", "c", "d"}:
            correct = None
        area_raw = normalize_space(str(row[col_area] or "")) if col_area is not None else "general"
        area_low = strip_accents(area_raw).lower()
        area = "administrativo" if "admin" in area_low or "contencioso" in area_low else "general"
        reserve_value = row[col_reserve] if col_reserve is not None else False
        reserve_bool = str(reserve_value).strip().lower() in {"1", "si", "sí", "true", "x", "reserva"}
        q = {
            "id": f"{exam_slug}-{area}-excel-{i}",
            "area": area,
            "number": i,
            "reserve": reserve_bool,
            "question": question_text,
            "options": [
                {"key": "a", "text": normalize_space(str(row[col_a] or ""))},
                {"key": "b", "text": normalize_space(str(row[col_b] or ""))},
                {"key": "c", "text": normalize_space(str(row[col_c] or ""))},
                {"key": "d", "text": normalize_space(str(row[col_d] or ""))},
            ],
            "correct": correct,
            "needs_review": correct is None,
        }
        questions.append(q)

    by_area = {
        "general": sum(1 for item in questions if item["area"] == "general" and not item["reserve"]),
        "general_reserva": sum(1 for item in questions if item["area"] == "general" and item["reserve"]),
        "administrativo": sum(1 for item in questions if item["area"] == "administrativo" and not item["reserve"]),
        "administrativo_reserva": sum(1 for item in questions if item["area"] == "administrativo" and item["reserve"]),
    }

    return {
        "source": "excel",
        "exam_name": exam_name,
        "imported_at": datetime.utcnow().isoformat() + "Z",
        "questions": questions,
        "stats": {"total": len(questions), "by_area": by_area, "needs_review": sum(1 for q in questions if q.get("needs_review"))},
    }


class ExplainRequest(BaseModel):
    question: str
    options: List[Dict[str, str]]
    selected: Optional[str] = None
    correct: str
    area: Optional[str] = None


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/health")
def health():
    has_gemini_key = bool(os.getenv("GEMINI_API_KEY"))
    has_openai_key = bool(os.getenv("OPENAI_API_KEY"))
    ai_provider = "gemini" if has_gemini_key else ("openai" if has_openai_key else None)
    return {
        "ok": True,
        "version": APP_VERSION,
        "pymupdf": fitz.__doc__.splitlines()[0] if getattr(fitz, "__doc__", None) else "PyMuPDF OK",
        "ai_configured": bool(ai_provider),
        "ai_provider": ai_provider,
        # Compatibilidad con el JavaScript anterior
        "openai_configured": bool(ai_provider),
    }


@app.post("/api/import/pdf")
async def import_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Sube un archivo PDF")
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="El PDF es demasiado grande. Máximo recomendado: 20 MB")
    try:
        return JSONResponse(parse_pdf_questions(content, file.filename))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo analizar el PDF: {exc}") from exc


@app.post("/api/import/excel")
async def import_excel(file: UploadFile = File(...)):
    if not file.filename.lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Sube un archivo Excel .xlsx")
    content = await file.read()
    try:
        return JSONResponse(parse_excel_questions(content, file.filename))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo analizar el Excel: {exc}") from exc


@app.post("/api/explain")
async def explain(req: ExplainRequest):
    gemini_key = os.getenv("GEMINI_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")

    if not gemini_key and not openai_key:
        raise HTTPException(
            status_code=400,
            detail="La IA no está configurada. Añade GEMINI_API_KEY en Render > Environment. Opcionalmente también puedes usar OPENAI_API_KEY.",
        )

    option_map = {opt.get("key", "").lower(): opt.get("text", "") for opt in req.options}
    selected_text = option_map.get((req.selected or "").lower(), "Sin respuesta")
    correct_text = option_map.get(req.correct.lower(), "")

    user_payload = {
        "materia": req.area or "",
        "pregunta": req.question,
        "opciones": option_map,
        "respuesta_marcada": {"letra": req.selected, "texto": selected_text},
        "respuesta_correcta": {"letra": req.correct, "texto": correct_text},
    }

    system_msg = "Eres preparador del examen de acceso a la abogacía en España. Explica de forma breve, clara y práctica por qué la opción correcta lo es y por qué la marcada no lo es. No inventes artículos concretos si no estás seguro. Máximo 130 palabras."
    user_msg = json.dumps(user_payload, ensure_ascii=False)

    # Prioridad: Gemini si existe GEMINI_API_KEY. Si un modelo está saturado o falla, probamos el siguiente.
    if gemini_key:
        if genai is None:
            raise HTTPException(status_code=500, detail="El paquete google-genai no está instalado")

        client = genai.Client(api_key=gemini_key)
        prompt = f"{system_msg}\n\nDatos de la pregunta en JSON:\n{user_msg}"
        errors: List[str] = []

        for model_name in GEMINI_MODELS:
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                )
                text = (getattr(response, "text", "") or "").strip()
                if text:
                    return {
                        "ok": True,
                        "provider": "gemini",
                        "model": model_name,
                        "explanation": text,
                    }
                errors.append(f"{model_name}: respuesta vacía")
            except Exception as exc:
                error_text = str(exc)
                errors.append(f"{model_name}: {error_text[:220]}")

                # Si es saturación, cuota, límite temporal o caída del modelo, pasamos al siguiente.
                # Si es clave inválida/permisos, no tiene sentido seguir intentando.
                retryable = any(code in error_text for code in ["503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED", "500", "INTERNAL"])
                auth_error = any(code in error_text for code in ["401", "403", "API key not valid", "PERMISSION_DENIED"])
                if auth_error and not retryable:
                    raise HTTPException(status_code=502, detail=f"Error de Gemini con la clave/permisos: {exc}") from exc

        raise HTTPException(
            status_code=502,
            detail="Gemini no ha respondido con ningún modelo disponible. Intentados: " + " | ".join(errors),
        )

    if OpenAI is None:
        raise HTTPException(status_code=500, detail="El paquete openai no está instalado")

    try:
        client = OpenAI(api_key=openai_key)

        if hasattr(client, "responses"):
            response = client.responses.create(
                model=OPENAI_MODEL,
                instructions=system_msg,
                input=user_msg,
            )
            text = getattr(response, "output_text", "").strip()
        else:
            response = client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_msg},
                ],
                temperature=0.2,
            )
            text = (response.choices[0].message.content or "").strip()

        return {"ok": True, "provider": "openai", "explanation": text or "No se ha podido generar una explicación."}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Error al llamar a OpenAI: {exc}") from exc
