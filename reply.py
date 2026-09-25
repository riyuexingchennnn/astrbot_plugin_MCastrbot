"""Minecraft 文本分段，不依赖 AstrBot 运行时。"""
import re


def split_reply(text: str, enabled: bool, threshold: int, mode: str, pattern: str, limit: int = 240) -> list[str]:
    """按句子拆分并强制限制单条 MC 消息长度。"""
    text = re.sub(r"[\t ]+", " ", text).strip()
    if not text:
        return []
    limit = max(1, min(240, limit))
    if not enabled or len(text) <= max(0, threshold):
        return [text[i:i + limit] for i in range(0, len(text), limit)]
    # 超过阈值后，以阈值作为目标段长；任何一段仍不能超过 MC 限制。
    target = min(limit, threshold) if threshold > 0 else limit
    if mode == "regex":
        try:
            matches = list(re.finditer(pattern, text))
            units = []
            start = 0
            for match in matches:
                if match.end() == match.start():
                    continue
                units.append(text[start:match.end()])
                start = match.end()
            if start < len(text):
                units.append(text[start:])
        except re.error:
            units = [text]
    else:
        units = [text]
    result: list[str] = []
    current = ""
    for unit in units:
        while unit:
            space = target - len(current)
            if len(unit) <= space:
                current += unit
                break
            if current:
                result.append(current.strip())
                current = ""
                continue
            result.append(unit[:target].strip())
            unit = unit[target:]
    if current.strip():
        result.append(current.strip())
    return [part for part in result if part]


def filter_reply(parts: list[str], enabled: bool, pattern: str) -> list[str]:
    """可选地删除匹配内容；非法表达式保留原文。"""
    if not enabled or not pattern:
        return parts
    try:
        compiled = re.compile(pattern)
    except re.error:
        return parts
    return [cleaned for part in parts if (cleaned := compiled.sub("", part).strip())]
