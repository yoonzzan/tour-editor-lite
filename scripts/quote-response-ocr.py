#!/usr/bin/env python3
import contextlib
import io
import json
import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(PROJECT_ROOT / ".paddlex"))


def write_payload(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def error_payload(code: str, message: str) -> dict[str, Any]:
    return {
        "ok": False,
        "text": "",
        "lines": [],
        "error": {"code": code, "message": message},
    }


def is_text_score_tuple(value: Any) -> bool:
    return (
        isinstance(value, Sequence)
        and not isinstance(value, (str, bytes, bytearray))
        and len(value) >= 2
        and isinstance(value[0], str)
        and isinstance(value[1], (int, float))
    )


def collect_lines(value: Any) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []

    def add_line(text: Any, confidence: Any = None) -> None:
        if not isinstance(text, str):
            return
        cleaned = text.strip()
        if not cleaned:
            return
        entry: dict[str, Any] = {"text": cleaned}
        if isinstance(confidence, (int, float)):
            entry["confidence"] = float(confidence)
        lines.append(entry)

    def walk(node: Any) -> None:
        if node is None:
            return

        if is_text_score_tuple(node):
            add_line(node[0], node[1])
            return

        if isinstance(node, Mapping):
            rec_texts = node.get("rec_texts")
            rec_scores = node.get("rec_scores")
            if isinstance(rec_texts, Sequence) and not isinstance(rec_texts, (str, bytes, bytearray)):
                for index, text in enumerate(rec_texts):
                    score = rec_scores[index] if isinstance(rec_scores, Sequence) and index < len(rec_scores) else None
                    add_line(text, score)

            text = node.get("text")
            score = node.get("confidence", node.get("score"))
            add_line(text, score)

            for child in node.values():
                walk(child)
            return

        if isinstance(node, Sequence) and not isinstance(node, (str, bytes, bytearray)):
            if len(node) >= 2 and is_text_score_tuple(node[1]):
                add_line(node[1][0], node[1][1])
                return
            for child in node:
                walk(child)
            return

        if hasattr(node, "json"):
            payload = node.json
            walk(payload() if callable(payload) else payload)
            return

        if hasattr(node, "__dict__"):
            walk(vars(node))

    walk(value)
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line in lines:
        text = line["text"]
        if text in seen:
            continue
        seen.add(text)
        deduped.append(line)
    return deduped


def build_ocr() -> Any:
    from paddleocr import PaddleOCR

    try:
        return PaddleOCR(
            lang="korean",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    except TypeError:
        return PaddleOCR(lang="korean", use_angle_cls=True, show_log=False)


def run_ocr(image_path: str) -> dict[str, Any]:
    captured_stdout = io.StringIO()
    captured_stderr = io.StringIO()
    with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
        ocr = build_ocr()
        if hasattr(ocr, "predict"):
            result = ocr.predict(input=image_path)
        else:
            result = ocr.ocr(image_path, cls=True)

    lines = collect_lines(result)
    return {
        "ok": True,
        "text": "\n".join(line["text"] for line in lines),
        "lines": lines,
        "error": None,
    }


def main() -> int:
    if len(sys.argv) != 2:
        write_payload(error_payload("invalid_args", "이미지 파일 경로를 하나만 전달해야 합니다."))
        return 2

    image_path = Path(sys.argv[1])
    if not image_path.is_file():
        write_payload(error_payload("file_not_found", "OCR 처리할 이미지 파일을 찾지 못했습니다."))
        return 2

    try:
        write_payload(run_ocr(str(image_path)))
        return 0
    except ModuleNotFoundError as exc:
        module_name = exc.name or "paddleocr"
        message = (
            f"로컬 Python 환경에 {module_name} 모듈이 없습니다. "
            "pip install paddleocr 명령으로 PaddleOCR을 설치해 주세요."
        )
        write_payload(error_payload("module_not_found", message))
        return 1
    except Exception as exc:
        write_payload(error_payload("ocr_failed", str(exc) or "로컬 PaddleOCR 실행에 실패했습니다."))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
