#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Windows 双击版：从 PPTX 名片中提取人员-设备信息，并按“设备名称”为主汇总到 Excel。

双击运行：弹出窗口选择 .pptx 文件，然后在 PPT 同目录生成：原文件名_设备白名单.xlsx

识别规则：
- 姓名：独立的 2-4 个中文字符，例如 张三、李四。
- 作业区域：包含 区/线/车间/工段/岗位/室/厂/楼/层 等特征。
- 设备：支持类似 “镀膜机 s00-1”、“贴片机 SMT-100 镜”、“检测仪 QC-8 镜 真”。
- 镜/真：作为独立字出现就是“是”，没有就是“否”。
- 支持一个名片里多个文本框：会按 PPT 坐标把同一个名片背景框里的文本合并后解析。

限制：
- 支持 .pptx，不支持旧版 .ppt。
- 不做 OCR，图片里的文字无法识别。
- 不需要第三方库，只用 Python 标准库。
"""

from __future__ import annotations

import argparse
import html
import re
import sys
import zipfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from xml.etree import ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
EMU_PER_INCH = 914400

OUTPUT_COLUMNS = [
    "部门", "设备名称", "设备型号", "位置", "是否镜头安全", "是否真空", "设备ower", "培训时长", "类别", "白名单人员"
]

FIELD_ALIASES = {
    "姓名": "姓名", "名字": "姓名", "人员": "姓名", "员工": "姓名",
    "部门": "部门", "科室": "部门", "班组": "部门",
    "作业区域": "作业区域", "区域": "作业区域", "位置": "作业区域", "地点": "作业区域",
    "设备名称": "设备名称", "设备": "设备名称", "设备名": "设备名称",
    "设备型号": "设备型号", "型号": "设备型号",
    "镜": "镜", "是否镜头安全": "镜", "镜头安全": "镜",
    "真": "真", "是否真空": "真", "真空": "真",
    "设备ower": "设备ower", "设备owner": "设备ower", "设备Owner": "设备ower", "owner": "设备ower",
    "培训时长": "培训时长", "时长": "培训时长",
    "类别": "类别", "类型": "类别",
}
DEVICE_FIELDS = {"设备名称", "设备型号", "镜", "真", "设备ower", "培训时长", "类别"}
PERSON_FIELDS = {"姓名", "部门", "作业区域"}


@dataclass
class Card:
    ppt_file: str
    slide_no: int
    shape_no: int
    raw_text: str
    name: str
    department: str
    area: str
    devices: List[Dict[str, str]]


@dataclass
class PositionedText:
    shape_no: int
    text: str
    x: float
    y: float
    w: float
    h: float


@dataclass
class TableBlock:
    shape_no: int
    text: str
    x: float
    y: float
    w: float
    h: float


def read_xml(zf: zipfile.ZipFile, name: str) -> Optional[ET.Element]:
    try:
        return ET.fromstring(zf.read(name))
    except KeyError:
        return None


def normalize_internal_target(base_part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    base_dir = PurePosixPath(base_part).parent
    parts: List[str] = []
    for piece in str(base_dir / target).split("/"):
        if piece in ("", "."):
            continue
        if piece == "..":
            if parts:
                parts.pop()
        else:
            parts.append(piece)
    return "/".join(parts)


def read_rels(zf: zipfile.ZipFile, rels_name: str) -> Dict[str, Tuple[str, str]]:
    root = read_xml(zf, rels_name)
    if root is None:
        return {}
    out = {}
    for rel in root.findall("rel:Relationship", NS):
        rid = rel.attrib.get("Id", "")
        if rid:
            out[rid] = (rel.attrib.get("Type", ""), rel.attrib.get("Target", ""))
    return out


def get_slide_parts_in_order(zf: zipfile.ZipFile) -> List[str]:
    pres = read_xml(zf, "ppt/presentation.xml")
    if pres is None:
        raise ValueError("不是有效 PPTX：缺少 ppt/presentation.xml")
    rels = read_rels(zf, "ppt/_rels/presentation.xml.rels")
    slide_parts = []
    for slide_id in pres.findall(".//p:sldId", NS):
        rid = slide_id.attrib.get(f"{{{NS['r']}}}id", "")
        rel_type, target = rels.get(rid, ("", ""))
        if rel_type == REL_SLIDE:
            slide_parts.append(normalize_internal_target("ppt/presentation.xml", target))
    if not slide_parts:
        slide_parts = sorted(
            [n for n in zf.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)],
            key=lambda n: int(re.search(r"slide(\d+)\.xml", n).group(1)),
        )
    return slide_parts


def paragraph_text_from_shape(shape: ET.Element) -> List[str]:
    lines = []
    for para in shape.findall(".//a:p", NS):
        text = "".join((t.text or "") for t in para.findall(".//a:t", NS)).strip()
        if text:
            lines.append(text)
    return lines


def text_from_node(node: ET.Element) -> str:
    lines = []
    for para in node.findall(".//a:p", NS):
        text = "".join((t.text or "") for t in para.findall(".//a:t", NS)).strip()
        if text:
            lines.append(text)
    return " ".join(lines).strip()


def shape_bounds(shape: ET.Element) -> Tuple[float, float, float, float]:
    xfrm = shape.find(".//p:spPr/a:xfrm", NS)
    if xfrm is None:
        return 0.0, 0.0, 0.0, 0.0
    off = xfrm.find("a:off", NS)
    ext = xfrm.find("a:ext", NS)
    if off is None or ext is None:
        return 0.0, 0.0, 0.0, 0.0
    return (
        int(off.attrib.get("x", "0")) / EMU_PER_INCH,
        int(off.attrib.get("y", "0")) / EMU_PER_INCH,
        int(ext.attrib.get("cx", "0")) / EMU_PER_INCH,
        int(ext.attrib.get("cy", "0")) / EMU_PER_INCH,
    )


def extract_positioned_texts(slide_root: ET.Element) -> List[PositionedText]:
    texts: List[PositionedText] = []
    for shape_no, shape in enumerate(slide_root.findall(".//p:sp", NS), start=1):
        lines = paragraph_text_from_shape(shape)
        if lines:
            x, y, w, h = shape_bounds(shape)
            texts.append(PositionedText(shape_no, "\n".join(lines), x, y, w, h))
    return texts


def graphic_frame_bounds(frame: ET.Element) -> Tuple[float, float, float, float]:
    xfrm = frame.find("p:xfrm", NS)
    if xfrm is None:
        xfrm = frame.find(".//a:xfrm", NS)
    if xfrm is None:
        return 0.0, 0.0, 0.0, 0.0
    off = xfrm.find("a:off", NS)
    ext = xfrm.find("a:ext", NS)
    if off is None or ext is None:
        return 0.0, 0.0, 0.0, 0.0
    return (
        int(off.attrib.get("x", "0")) / EMU_PER_INCH,
        int(off.attrib.get("y", "0")) / EMU_PER_INCH,
        int(ext.attrib.get("cx", "0")) / EMU_PER_INCH,
        int(ext.attrib.get("cy", "0")) / EMU_PER_INCH,
    )


def extract_table_blocks(slide_root: ET.Element, start_no: int = 10000) -> List[TableBlock]:
    blocks: List[TableBlock] = []
    for idx, frame in enumerate(slide_root.findall(".//p:graphicFrame", NS), start=start_no):
        tbl = frame.find(".//a:tbl", NS)
        if tbl is None:
            continue
        rows = []
        for tr in tbl.findall("a:tr", NS):
            cells = [text_from_node(tc) for tc in tr.findall("a:tc", NS)]
            if any(cells):
                rows.append("\t".join(cells))
        if rows:
            x, y, w, h = graphic_frame_bounds(frame)
            blocks.append(TableBlock(idx, "\n".join(rows), x, y, w, h))
    return blocks


def extract_card_containers(slide_root: ET.Element) -> List[Tuple[int, float, float, float, float]]:
    containers: List[Tuple[int, float, float, float, float]] = []
    for shape_no, shape in enumerate(slide_root.findall(".//p:sp", NS), start=1):
        if paragraph_text_from_shape(shape):
            continue
        x, y, w, h = shape_bounds(shape)
        if w >= 1.5 and h >= 1.0:
            containers.append((shape_no, x, y, w, h))
    return containers


def text_center(t) -> Tuple[float, float]:
    return t.x + t.w / 2, t.y + t.h / 2


def point_in_box(px: float, py: float, box: Tuple[int, float, float, float, float], pad: float = 0.12) -> bool:
    _, x, y, w, h = box
    return x - pad <= px <= x + w + pad and y - pad <= py <= y + h + pad


def item_left(item) -> float:
    return item.x


def item_top(item) -> float:
    return item.y


def group_items_by_spatial_grid(items: Sequence[object]) -> List[Tuple[int, List[object]]]:
    """无可靠名片外框时，按坐标把同一页的文本/表格聚成多张名片。

    适合用户截图这种：一页多个名片呈网格排列，每张名片内部元素相互靠近。
    """
    useful = [item for item in items if getattr(item, "w", 0) > 0 or getattr(item, "h", 0) > 0]
    if not useful:
        return []

    # 先按 x 坐标聚成列。阈值取 2.2 英寸，足够容纳同一列内部的姓名、工号、表格。
    columns: List[List[object]] = []
    for item in sorted(useful, key=lambda it: item_left(it)):
        placed = False
        cx, _ = text_center(item)
        for col in columns:
            col_cx = sum(text_center(it)[0] for it in col) / len(col)
            if abs(cx - col_cx) <= 2.2:
                col.append(item)
                placed = True
                break
        if not placed:
            columns.append([item])

    groups: List[Tuple[int, List[object]]] = []
    for col in columns:
        # 同一列再按 y 坐标分成上下多张名片。名片之间通常有明显纵向间隔。
        current: List[object] = []
        last_y = None
        for item in sorted(col, key=lambda it: item_top(it)):
            y = item_top(item)
            if current and last_y is not None and y - last_y > 1.15:
                current.sort(key=lambda it: (it.y, it.x))
                groups.append((min(getattr(it, "shape_no", 999999) for it in current), current))
                current = []
            current.append(item)
            last_y = max(last_y or y, y + getattr(item, "h", 0))
        if current:
            current.sort(key=lambda it: (it.y, it.x))
            groups.append((min(getattr(it, "shape_no", 999999) for it in current), current))

    groups.sort(key=lambda g: (min(it.y for it in g[1]), min(it.x for it in g[1])))
    return groups


def group_parse_score(text: str) -> int:
    """判断一个分组像不像有效名片。"""
    score = 0
    if "设备名称" in text and ("型号" in text or "设备型号" in text):
        score += 5
    if "作业区域" in text or "区域" in text:
        score += 2
    if find_person_name_from_lines(text.splitlines()):
        score += 2
    _, table_devices = parse_table_devices_from_lines(text.splitlines())
    _, col_devices = parse_columnar_devices_from_lines(text.splitlines())
    score += max(len(table_devices), len(col_devices)) * 3
    return score


def grouped_card_items(slide_root: ET.Element) -> List[Tuple[int, List[object]]]:
    texts = extract_positioned_texts(slide_root)
    tables = extract_table_blocks(slide_root)
    containers = extract_card_containers(slide_root)
    skip_patterns = [r"^第\s*\d+\s*页$", r"PPT 名片示例", r"非标准 PPT 名片示例", r"设备白名单名片示例"]
    texts = [t for t in texts if not any(re.search(pat, t.text) for pat in skip_patterns)]
    items = texts + tables

    container_groups: List[Tuple[int, List[object]]] = []
    if containers:
        used_item_ids = set()
        for box in sorted(containers, key=lambda b: (b[2], b[1])):
            inside = []
            for item in items:
                cx, cy = text_center(item)
                if point_in_box(cx, cy, box):
                    inside.append(item)
                    used_item_ids.add(item.shape_no)
            if inside:
                inside.sort(key=lambda item: (item.y, item.x))
                container_groups.append((box[0], inside))
        leftovers = [item for item in items if item.shape_no not in used_item_ids]
        for item in leftovers:
            container_groups.append((item.shape_no, [item]))

    spatial_groups = group_items_by_spatial_grid(items)

    def total_score(groups: Sequence[Tuple[int, List[object]]]) -> int:
        score = 0
        for _, group_items in groups:
            text = "\n".join(item.text for item in group_items)
            score += group_parse_score(text)
        return score

    # 选择能解析出更多设备/名片特征的分组方式。
    if spatial_groups and total_score(spatial_groups) > total_score(container_groups):
        return spatial_groups
    return container_groups or spatial_groups or [(item.shape_no, [item]) for item in items]


def grouped_card_texts(slide_root: ET.Element) -> List[Tuple[int, str]]:
    return [(shape_no, "\n".join(item.text for item in items)) for shape_no, items in grouped_card_items(slide_root)]


def normalize_key(key: str) -> Optional[str]:
    key = key.strip().replace(" ", "")
    return FIELD_ALIASES.get(key)


def parse_field_line(line: str) -> List[Tuple[str, str]]:
    line = line.strip()
    if not line:
        return []
    m = re.match(r"^([^:：\s]{1,12})\s*[:：]\s*(.+?)\s*$", line)
    if m:
        key = normalize_key(m.group(1))
        return [(key, m.group(2).strip())] if key else []
    keys = sorted(FIELD_ALIASES.keys(), key=len, reverse=True)
    key_pattern = "|".join(re.escape(k) for k in keys)
    matches = list(re.finditer(rf"(?<!\S)({key_pattern})(?!\S)", line))
    pairs = []
    for i, match in enumerate(matches):
        key = normalize_key(match.group(1))
        if not key:
            continue
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
        value = line[start:end].strip(" ：:")
        if value:
            pairs.append((key, value))
    return pairs


def split_device_values(value: str) -> List[str]:
    parts = [p.strip() for p in re.split(r"[、,，;/；]+", value) if p.strip()]
    return parts or [value.strip()]


def looks_like_person_name(text: str) -> bool:
    text = text.strip()
    if not re.fullmatch(r"[\u4e00-\u9fff]{2,4}", text):
        return False
    bad_words = {"设备", "型号", "区域", "部门", "位置", "镜头", "真空", "类别", "作业", "安全", "白名单"}
    device_suffixes = ("机", "仪", "泵", "镜", "炉", "柜", "台", "枪", "秤")
    if text.endswith(device_suffixes):
        return False
    return text not in bad_words and not any(word in text for word in bad_words)


def find_person_name_from_lines(lines: Sequence[str]) -> str:
    """支持横排姓名，也支持截图里那种竖排姓名：陈 / 金 / 涛。"""
    clean_lines = [clean_cell(line) for line in lines if clean_cell(line)]
    # 只优先在表格标题之前找姓名，避免把“点胶机”这类设备名当姓名。
    first_table_idx = len(clean_lines)
    for idx, line in enumerate(clean_lines):
        if line in {"作业区域", "区域", "位置", "设备名称", "型号", "设备型号"}:
            first_table_idx = idx
            break
    prefix = clean_lines[:first_table_idx] if first_table_idx else clean_lines

    for line in prefix:
        compact = re.sub(r"\s+", "", line)
        if looks_like_person_name(compact):
            return compact

    # 竖排姓名：连续 2-4 个单字中文行，优先取完整连续段，例如 陈/金/涛 -> 陈金涛。
    chars: List[str] = []

    def flush_chars() -> str:
        if 2 <= len(chars) <= 4:
            candidate = "".join(chars)
            if looks_like_person_name(candidate):
                return candidate
        return ""

    for line in prefix:
        if re.fullmatch(r"[\u4e00-\u9fff]", line) and line not in {"镜", "真"}:
            chars.append(line)
            if len(chars) == 4:
                candidate = flush_chars()
                if candidate:
                    return candidate
                chars = []
        else:
            candidate = flush_chars()
            if candidate:
                return candidate
            chars = []
    candidate = flush_chars()
    if candidate:
        return candidate
    return ""


def looks_like_area(text: str) -> bool:
    return bool(re.search(r"(区|线|车间|工段|岗位|区域|位置|室|厂|楼|层)", text))


def is_noise_or_header_line(text: str) -> bool:
    compact = re.sub(r"\s+", "", text.strip())
    if not compact:
        return True
    header_words = {
        "姓名", "作业区域", "区域", "位置", "设备名称", "设备型号", "型号", "设备",
        "镜", "真", "镜真", "镜头安全", "真空", "部门", "类别", "培训时长", "有效期", "工号",
    }
    if compact in header_words:
        return True
    # 常见表头组合，例如：设备名称设备型号镜真
    if compact and all(word in "姓名作业区域位置设备名称设备型号型号镜真部门类别培训时长" for word in re.findall(r"[\u4e00-\u9fff]+", compact)):
        if any(word in compact for word in ["设备名称", "设备型号", "作业区域", "姓名"]):
            return True
    return False


def normalize_bool_token(value: str) -> str:
    value = value.strip()
    if value in {"是", "有", "安全", "Y", "y", "YES", "yes", "√", "✓", "1"}:
        return "是"
    if value in {"否", "无", "不", "N", "n", "NO", "no", "×", "x", "0"}:
        return "否"
    return value


def strip_noise_tokens(line: str) -> str:
    line = re.sub(r"(?<!\S)(镜|真)(?!\S)(?:\s*[:：]?\s*(是|否|有|无|Y|N|YES|NO|yes|no|√|✓|×|x|0|1))?", " ", line)
    line = re.sub(r"\b(镜头安全|是否镜头安全|真空|是否真空)\s*[:：]?\s*(是|否|有|无|Y|N|YES|NO|yes|no|√|✓|×|x|0|1)\b", " ", line)
    line = re.sub(r"\s+", " ", line).strip(" -—|，,；;:/：")
    return line


def parse_loose_device_line(line: str) -> Optional[Dict[str, str]]:
    original = line.strip()
    if not original:
        return None
    if is_noise_or_header_line(original) or looks_like_person_name(original) or looks_like_area(original):
        return None

    d: Dict[str, str] = {"镜": "否", "真": "否"}
    for key, out_key in [("镜头安全", "镜"), ("是否镜头安全", "镜"), ("真空", "真"), ("是否真空", "真")]:
        m = re.search(rf"{key}\s*[:：]?\s*(是|否|有|无|Y|N|YES|NO|yes|no|√|✓|×|x|0|1)", original, re.I)
        if m:
            d[out_key] = normalize_bool_token(m.group(1))
    if re.search(r"(?<!\S)镜(?!\S)", original):
        d["镜"] = "是"
    if re.search(r"(?<!\S)真(?!\S)", original):
        d["真"] = "是"

    clean = strip_noise_tokens(original)
    tokens = re.split(r"[\s,，;；/]+", clean)
    model_idx = None
    for idx, token in enumerate(tokens):
        if re.search(r"\d", token) and re.search(r"[A-Za-z0-9]", token) and len(token) >= 2:
            model_idx = idx
            break
    if model_idx is not None:
        d["设备型号"] = tokens[model_idx]
        name = "".join(tokens[:model_idx]).strip() or (tokens[model_idx - 1] if model_idx > 0 else "")
    else:
        # 自由格式下必须同时识别到型号，否则很容易把表头/说明文字误当成设备。
        return None

    name = re.sub(r"^(设备名称|设备|名称)[:：]?", "", name).strip()
    if not name or len(name) > 30:
        return None
    if is_noise_or_header_line(name):
        return None
    if not re.search(r"[\u4e00-\u9fffA-Za-z]", name):
        return None
    # 设备名称应以中文/英文为主，避免把数字、符号或整段说明当成设备名。
    if len(re.findall(r"[\u4e00-\u9fffA-Za-z]", name)) < 2:
        return None
    d["设备名称"] = name
    return d


def split_inline_devices(line: str) -> List[str]:
    # 处理用户编辑示例：镀膜机 s00-1 | 清洗机 z005；PPT 文本抽取后有时会变成很多空格。
    if "|" in line:
        return [p.strip() for p in line.split("|") if p.strip()]
    pattern = re.compile(r"[^\s,，;；/|]+\s+[A-Za-z0-9][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*(?:\s+(?:镜|真))*")
    matches = [m.group(0).strip() for m in pattern.finditer(line)]
    return matches if len(matches) > 1 else [line]


def clean_cell(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def cell_is_marker(text: str, marker: str) -> bool:
    return clean_cell(text) == marker


def looks_like_model(text: str) -> bool:
    text = clean_cell(text)
    if not text or is_noise_or_header_line(text):
        return False
    # 带两个以上中文的通常是设备名称，不是型号，例如“3D显微镜”。
    if len(re.findall(r"[\u4e00-\u9fff]", text)) >= 2:
        return False
    return bool(re.search(r"\d", text) and re.search(r"[A-Za-z0-9]", text))


def looks_like_device_name(text: str) -> bool:
    text = clean_cell(text)
    if not text or is_noise_or_header_line(text) or looks_like_area(text):
        return False
    if looks_like_model(text):
        return False
    if len(text) > 40:
        return False
    # 表格“设备名称”列里允许 2-4 个中文设备名，例如“点胶机/包装机”，不能按姓名过滤。
    return len(re.findall(r"[\u4e00-\u9fffA-Za-z]", text)) >= 2


def split_table_row_cells(line: str) -> List[str]:
    """真实名片底部是多行 2 列表格；支持 PPT 表格的 tab，也支持文本抽取后变成多个空格的情况。"""
    line = line.strip()
    if not line:
        return []
    if "\t" in line:
        return [clean_cell(c) for c in line.split("\t")]
    if "|" in line:
        return [clean_cell(c) for c in line.split("|")]
    # 表格被抽成普通文本时，两列之间通常有多个空格。
    parts = re.split(r"\s{2,}", line)
    if len(parts) >= 2:
        return [clean_cell(c) for c in parts]
    return [clean_cell(line)]


def looks_like_table_model(text: str) -> bool:
    """在明确的“型号”列里，型号不一定含数字，所以比自由文本型号识别更宽松。"""
    text = clean_cell(text)
    if not text or is_noise_or_header_line(text):
        return False
    if text in {"有效期", "工号", "姓名", "作业区域", "区域", "位置", "设备名称", "型号", "设备型号"}:
        return False
    if re.search(r"\d{4}[./-]\d{1,2}[./-]\d{1,2}", text):
        return False
    return bool(re.search(r"[\u4e00-\u9fffA-Za-z0-9]", text))


def parse_table_devices_from_lines(lines: Sequence[str]) -> Tuple[str, List[Dict[str, str]]]:
    """按真实名片底部表格解析：多行 2 列。

    典型结构：
      作业区域 | 6区
      设备名称 | 型号
      设备A   | 型号A
      设备B   | 型号B
    """
    area = ""
    devices: List[Dict[str, str]] = []
    rows = []
    for line in lines:
        cells = split_table_row_cells(line)
        if len(cells) >= 2 and any(cells):
            rows.append(cells)

    # 作业区域行：作业区域 | 6区
    for cells in rows:
        for idx, cell in enumerate(cells[:-1]):
            if cell in {"作业区域", "区域", "位置"}:
                area = cells[idx + 1]
                break
        if area:
            break

    # 找“设备名称 | 型号”表头，后续每行就是一台设备。
    name_col = model_col = None
    start_row = 0
    for r_idx, cells in enumerate(rows):
        for c_idx, cell in enumerate(cells):
            if cell == "设备名称":
                name_col = c_idx
            if cell in {"型号", "设备型号"}:
                model_col = c_idx
        if name_col is not None and model_col is not None:
            start_row = r_idx + 1
            break

    if name_col is None or model_col is None:
        return area, []

    for cells in rows[start_row:]:
        name = cells[name_col] if name_col < len(cells) else ""
        model = cells[model_col] if model_col < len(cells) else ""
        # 到有效期/工号等尾部就停止，避免把页脚当设备。
        joined = "".join(cells)
        if any(word in joined for word in ["有效期", "工号", "姓名"]):
            break
        if looks_like_device_name(name) and looks_like_table_model(model):
            mirror = "是" if any(cell_is_marker(c, "镜") for c in cells) else "否"
            vacuum = "是" if any(cell_is_marker(c, "真") for c in cells) else "否"
            devices.append({"设备名称": name, "设备型号": model, "镜": mirror, "真": vacuum})
    return area, devices


def parse_table_devices_with_positioned_markers(table: TableBlock, marker_items: Sequence[PositionedText]) -> Tuple[str, List[Dict[str, str]]]:
    """解析真实 2 列表格，并按同一设备行附近的独立“镜/真”文本标记设置是否。"""
    lines = [line for line in table.text.splitlines() if line.strip()]
    area, devices = parse_table_devices_from_lines(lines)
    rows = []
    for line in lines:
        cells = split_table_row_cells(line)
        if len(cells) >= 2 and any(cells):
            rows.append(cells)
    if not rows:
        return area, devices

    name_col = model_col = None
    start_row = 0
    for r_idx, cells in enumerate(rows):
        for c_idx, cell in enumerate(cells):
            if cell == "设备名称":
                name_col = c_idx
            if cell in {"型号", "设备型号"}:
                model_col = c_idx
        if name_col is not None and model_col is not None:
            start_row = r_idx + 1
            break
    if name_col is None or model_col is None:
        return area, devices

    row_count = max(len(rows), 1)
    row_h = table.h / row_count if table.h else 0.25
    rebuilt: List[Dict[str, str]] = []
    for r_idx, cells in enumerate(rows[start_row:], start=start_row):
        name = cells[name_col] if name_col < len(cells) else ""
        model = cells[model_col] if model_col < len(cells) else ""
        joined = "".join(cells)
        if any(word in joined for word in ["有效期", "工号", "姓名"]):
            break
        if not (looks_like_device_name(name) and looks_like_table_model(model)):
            continue
        row_top = table.y + row_h * r_idx
        row_bottom = table.y + row_h * (r_idx + 1)
        mirror = "是" if any(cell_is_marker(c, "镜") for c in cells) else "否"
        vacuum = "是" if any(cell_is_marker(c, "真") for c in cells) else "否"
        for marker in marker_items:
            marker_text = clean_cell(marker.text)
            _, marker_y = text_center(marker)
            if row_top - row_h * 0.35 <= marker_y <= row_bottom + row_h * 0.35:
                if marker_text == "镜":
                    mirror = "是"
                if marker_text == "真":
                    vacuum = "是"
        rebuilt.append({"设备名称": name, "设备型号": model, "镜": mirror, "真": vacuum})
    return area, rebuilt or devices


def dedupe_devices(devices: Sequence[Dict[str, str]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    seen = set()
    for d in devices:
        key = (d.get("设备名称", ""), d.get("设备型号", ""), d.get("镜", ""), d.get("真", ""))
        if d.get("设备名称") and key not in seen:
            seen.add(key)
            out.append(d)
    return out


def apply_positioned_table_markers(card: Card, items: Sequence[object]) -> None:
    marker_items = [item for item in items if isinstance(item, PositionedText) and clean_cell(item.text) in {"镜", "真"}]
    table_items = [item for item in items if isinstance(item, TableBlock)]
    for table in table_items:
        area, table_devices = parse_table_devices_with_positioned_markers(table, marker_items)
        if area and not card.area:
            card.area = area
        for dev in table_devices:
            matched = False
            for existing in card.devices:
                if existing.get("设备名称") == dev.get("设备名称") and existing.get("设备型号") == dev.get("设备型号"):
                    existing["镜"] = dev.get("镜", "否")
                    existing["真"] = dev.get("真", "否")
                    matched = True
            if not matched:
                card.devices.append(dev)
    card.devices = dedupe_devices(card.devices)


def parse_columnar_devices_from_lines(lines: Sequence[str]) -> Tuple[str, List[Dict[str, str]]]:
    """解析被拆成很多文本框的表格式名片。

    支持两类真实 PPT 顺序：
    1) 交替顺序：设备A, 型号A, 设备B, 型号B
    2) 两列顺序：设备A, 设备B, 设备C, 型号A, 型号B, 型号C
    """
    clean_lines = [clean_cell(line) for line in lines if clean_cell(line) and "\t" not in line]
    area = ""
    for idx, line in enumerate(clean_lines[:-1]):
        if line in {"作业区域", "区域", "位置"}:
            nxt = clean_lines[idx + 1]
            if looks_like_area(nxt) or re.fullmatch(r"\d+区", nxt) or re.fullmatch(r"[A-Za-z0-9]+", nxt):
                area = nxt
                break

    header_idx = None
    model_header_idx = None
    for idx, line in enumerate(clean_lines):
        if line == "设备名称":
            for j in range(idx + 1, min(idx + 8, len(clean_lines))):
                if clean_lines[j] in {"型号", "设备型号"}:
                    header_idx = idx
                    model_header_idx = j
                    break
        if header_idx is not None:
            break
    if header_idx is None or model_header_idx is None:
        return area, []

    body = []
    for line in clean_lines[model_header_idx + 1:]:
        if line in {"有效期", "工号", "部门", "姓名"} or re.search(r"\d{4}[./-]\d{1,2}[./-]\d{1,2}", line):
            break
        if line in {"设备名称", "型号", "设备型号", "作业区域", "区域", "位置"}:
            continue
        body.append(line)

    devices: List[Dict[str, str]] = []

    # 情况 1：交替顺序，设备名后面紧跟型号。
    idx = 0
    alternating: List[Dict[str, str]] = []
    while idx < len(body):
        line = body[idx]
        if cell_is_marker(line, "镜") or cell_is_marker(line, "真"):
            idx += 1
            continue
        if looks_like_device_name(line) and idx + 1 < len(body) and looks_like_model(body[idx + 1]):
            mirror = "否"
            vacuum = "否"
            j = idx + 2
            while j < len(body) and (cell_is_marker(body[j], "镜") or cell_is_marker(body[j], "真")):
                if cell_is_marker(body[j], "镜"):
                    mirror = "是"
                if cell_is_marker(body[j], "真"):
                    vacuum = "是"
                j += 1
            alternating.append({"设备名称": line, "设备型号": body[idx + 1], "镜": mirror, "真": vacuum})
            idx = j
            continue
        idx += 1

    # 情况 2：两列顺序，先出现一串设备名称，再出现一串型号。
    names = [line for line in body if looks_like_device_name(line)]
    models = [line for line in body if looks_like_model(line)]
    columnar: List[Dict[str, str]] = []
    if names and models:
        for name, model in zip(names, models):
            columnar.append({"设备名称": name, "设备型号": model, "镜": "否", "真": "否"})

    # 选择数量更多的解析结果，避免只配到一两行。
    devices = columnar if len(columnar) > len(alternating) else alternating
    return area, devices


def parse_card_text(ppt_file: str, slide_no: int, shape_no: int, raw_text: str) -> Optional[Card]:
    person = {"姓名": "", "部门": "", "作业区域": ""}
    devices: List[Dict[str, str]] = []
    current: Dict[str, str] = {}
    loose_lines: List[str] = []

    def flush_current() -> None:
        nonlocal current
        if current.get("设备名称"):
            current.setdefault("镜", "否")
            current.setdefault("真", "否")
            devices.append(current)
        current = {}

    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
    table_area, table_devices = parse_table_devices_from_lines(lines)
    column_area, column_devices = parse_columnar_devices_from_lines(lines)
    if table_area and not person["作业区域"]:
        person["作业区域"] = table_area
    if column_area and not person["作业区域"]:
        person["作业区域"] = column_area
    devices.extend(table_devices)
    devices.extend(column_devices)

    for raw_line in lines:
        if "\t" in raw_line:
            # 表格行已按列解析，避免再用自由文本规则误拆。
            continue
        pairs = parse_field_line(raw_line)
        if not pairs:
            loose_lines.append(raw_line)
            continue
        if not any(key == "设备名称" for key, _ in pairs):
            loose_device = parse_loose_device_line(raw_line)
            if loose_device:
                devices.append(loose_device)
                continue
        for key, value in pairs:
            if key in PERSON_FIELDS:
                person[key] = value.strip()
                continue
            if key == "设备名称":
                names = split_device_values(value)
                if len(names) > 1:
                    flush_current()
                    for name in names:
                        devices.append({"设备名称": name, "镜": "否", "真": "否"})
                else:
                    flush_current()
                    current["设备名称"] = names[0]
                continue
            if key in DEVICE_FIELDS:
                if devices and not current.get("设备名称"):
                    for d in devices:
                        d.setdefault(key, value.strip())
                else:
                    current[key] = value.strip()
    flush_current()

    if not person["姓名"]:
        person["姓名"] = find_person_name_from_lines(lines)
    if not person["姓名"]:
        for line in loose_lines:
            compact = re.sub(r"\s+", "", line)
            if looks_like_person_name(compact):
                person["姓名"] = compact
                break
        if not person["姓名"] and lines and looks_like_person_name(re.sub(r"\s+", "", lines[0])):
            person["姓名"] = re.sub(r"\s+", "", lines[0])

    if not person["作业区域"]:
        for line in loose_lines:
            if line != person["姓名"] and looks_like_area(line):
                person["作业区域"] = line
                break

    for line in loose_lines:
        if line in {person["姓名"], person["作业区域"], person["部门"]}:
            continue
        for part in split_inline_devices(line):
            loose_device = parse_loose_device_line(part)
            if loose_device:
                devices.append(loose_device)

    unique_devices: List[Dict[str, str]] = []
    seen = set()
    for d in devices:
        d.setdefault("镜", "否")
        d.setdefault("真", "否")
        key = (d.get("设备名称", ""), d.get("设备型号", ""), d.get("镜", ""), d.get("真", ""))
        if d.get("设备名称") and key not in seen:
            seen.add(key)
            unique_devices.append(d)

    if not person["姓名"] and not unique_devices:
        return None
    return Card(ppt_file, slide_no, shape_no, raw_text, person["姓名"], person["部门"], person["作业区域"], unique_devices)


def extract_cards(pptx: Path) -> List[Card]:
    cards: List[Card] = []
    with zipfile.ZipFile(pptx) as zf:
        for slide_no, slide_part in enumerate(get_slide_parts_in_order(zf), start=1):
            root = read_xml(zf, slide_part)
            if root is None:
                continue
            for shape_no, items in grouped_card_items(root):
                text = "\n".join(item.text for item in items)
                card = parse_card_text(pptx.name, slide_no, shape_no, text)
                if card:
                    apply_positioned_table_markers(card, items)
                if card and card.devices:
                    cards.append(card)
    return cards


def merge_unique(values: Iterable[str]) -> str:
    seen = OrderedDict()
    for value in values:
        value = str(value).strip()
        if value:
            seen[value] = None
    return "，".join(seen.keys())


def aggregate_cards(cards: Sequence[Card]) -> List[List[str]]:
    # 同一个“设备名称 + 设备型号”才算同一台设备；设备名称相同但型号不同要分开成多行。
    grouped: "OrderedDict[Tuple[str, str], Dict[str, object]]" = OrderedDict()
    for card in cards:
        for device in card.devices:
            name = device.get("设备名称", "").strip()
            model = device.get("设备型号", "").strip()
            if not name:
                continue
            key = (name, model)
            bucket = grouped.setdefault(key, {
                "部门": [], "设备名称": name, "设备型号": model, "位置": [], "是否镜头安全": [], "是否真空": [],
                "设备ower": [], "培训时长": [], "类别": [], "白名单人员": OrderedDict(),
            })
            bucket["部门"].append(card.department)
            bucket["位置"].append(card.area)
            bucket["是否镜头安全"].append(device.get("镜", "否"))
            bucket["是否真空"].append(device.get("真", "否"))
            bucket["设备ower"].append(device.get("设备ower", ""))
            bucket["培训时长"].append(device.get("培训时长", ""))
            bucket["类别"].append(device.get("类别", ""))
            if card.name:
                bucket["白名单人员"][card.name] = None

    rows: List[List[str]] = []
    for bucket in grouped.values():
        people = list(bucket["白名单人员"].keys())
        whitelist = "，".join(people)
        rows.append([
            merge_unique(bucket["部门"]), bucket["设备名称"], bucket["设备型号"], merge_unique(bucket["位置"]),
            merge_unique(bucket["是否镜头安全"]), merge_unique(bucket["是否真空"]), merge_unique(bucket["设备ower"]),
            merge_unique(bucket["培训时长"]), merge_unique(bucket["类别"]), whitelist,
        ])
    return rows


def excel_col_name(col_no: int) -> str:
    name = ""
    while col_no:
        col_no, rem = divmod(col_no - 1, 26)
        name = chr(65 + rem) + name
    return name


def xml_text(value: object) -> str:
    text = "" if value is None else str(value)
    text = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F]", "", text)
    return html.escape(text, quote=False)


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class SimpleXlsxWorkbook:
    def __init__(self) -> None:
        self.sheets: List[Tuple[str, List[List[object]]]] = []

    def add_sheet(self, title: str, headers: Sequence[str], rows: Iterable[Sequence[object]]) -> None:
        self.sheets.append((title[:31], [list(headers)] + [list(row) for row in rows]))

    def save(self, output: Path) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", self._content_types())
            zf.writestr("_rels/.rels", self._root_rels())
            zf.writestr("xl/workbook.xml", self._workbook_xml())
            zf.writestr("xl/_rels/workbook.xml.rels", self._workbook_rels())
            zf.writestr("xl/styles.xml", self._styles_xml())
            for idx, (_, rows) in enumerate(self.sheets, start=1):
                zf.writestr(f"xl/worksheets/sheet{idx}.xml", self._worksheet_xml(rows))

    def _content_types(self) -> str:
        sheets = "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, len(self.sheets) + 1))
        return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>{sheets}</Types>'''

    def _root_rels(self) -> str:
        return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'''

    def _workbook_rels(self) -> str:
        rels = []
        for idx in range(1, len(self.sheets) + 1):
            rels.append(f'<Relationship Id="rId{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{idx}.xml"/>')
        rels.append(f'<Relationship Id="rId{len(self.sheets)+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
        return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{''.join(rels)}</Relationships>'''

    def _workbook_xml(self) -> str:
        nodes = []
        for idx, (name, _) in enumerate(self.sheets, start=1):
            safe = re.sub(r"[\\/*?:\[\]]", "_", name)[:31] or f"Sheet{idx}"
            nodes.append(f'<sheet name="{xml_text(safe)}" sheetId="{idx}" r:id="rId{idx}"/>')
        return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{''.join(nodes)}</sheets></workbook>'''

    def _styles_xml(self) -> str:
        return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/></styleSheet>'''

    def _worksheet_xml(self, rows: List[List[object]]) -> str:
        max_cols = max((len(r) for r in rows), default=1)
        max_rows = max(len(rows), 1)
        dimension = f"A1:{excel_col_name(max_cols)}{max_rows}"
        widths = []
        for col_idx in range(1, max_cols + 1):
            max_len = 8
            for row in rows[:2000]:
                if col_idx <= len(row):
                    max_len = max(max_len, min(60, len(str(row[col_idx - 1]))))
            widths.append(f'<col min="{col_idx}" max="{col_idx}" width="{min(max_len + 2, 62)}" customWidth="1"/>')
        row_nodes = []
        for row_idx, row in enumerate(rows, start=1):
            cells = []
            for col_idx, value in enumerate(row, start=1):
                ref = f"{excel_col_name(col_idx)}{row_idx}"
                style = ' s="1"' if row_idx == 1 else ""
                if is_number(value):
                    cells.append(f'<c r="{ref}"{style}><v>{value}</v></c>')
                else:
                    cells.append(f'<c r="{ref}" t="inlineStr"{style}><is><t xml:space="preserve">{xml_text(value)}</t></is></c>')
            row_nodes.append(f'<row r="{row_idx}">{''.join(cells)}</row>')
        return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="{dimension}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>{''.join(widths)}</cols><sheetData>{''.join(row_nodes)}</sheetData></worksheet>'''


def write_excel(output: Path, rows: List[List[str]], cards: Sequence[Card]) -> None:
    wb = SimpleXlsxWorkbook()
    wb.add_sheet("设备白名单", OUTPUT_COLUMNS, rows)
    detail_rows = []
    for card in cards:
        for d in card.devices:
            detail_rows.append([
                card.ppt_file, card.slide_no, card.shape_no, card.name, card.department, card.area,
                d.get("设备名称", ""), d.get("设备型号", ""), d.get("镜", "否"), d.get("真", "否"),
                d.get("设备ower", ""), d.get("培训时长", ""), d.get("类别", ""), card.raw_text,
            ])
    wb.add_sheet("名片明细", ["PPT文件", "页码", "名片序号", "姓名", "部门", "作业区域", "设备名称", "设备型号", "镜", "真", "设备ower", "培训时长", "类别", "原始名片文本"], detail_rows)
    wb.save(output)


def choose_pptx_file() -> Optional[Path]:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        show_error("缺少组件", f"无法打开文件选择窗口：{exc}")
        return None
    root = tk.Tk()
    root.withdraw()
    root.update()
    file_path = filedialog.askopenfilename(title="请选择要统计的 PPTX 文件", filetypes=[("PowerPoint 文件", "*.pptx"), ("所有文件", "*.*")])
    root.destroy()
    return Path(file_path).expanduser().resolve() if file_path else None


def show_info(title: str, message: str) -> None:
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo(title, message)
        root.destroy()
    except Exception:
        print(f"{title}: {message}")


def show_error(title: str, message: str) -> None:
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(title, message)
        root.destroy()
    except Exception:
        print(f"{title}: {message}", file=sys.stderr)


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从 PPTX 名片提取设备白名单 Excel。")
    parser.add_argument("pptx", nargs="?", help="输入 .pptx 文件；不传则弹出文件选择窗口")
    parser.add_argument("-o", "--output", help="输出 .xlsx 文件；默认在 PPT 旁生成 *_设备白名单.xlsx")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    interactive = not args.pptx
    pptx = Path(args.pptx).expanduser().resolve() if args.pptx else choose_pptx_file()
    if pptx is None:
        return 1
    if not pptx.exists() or pptx.suffix.lower() != ".pptx":
        raise FileNotFoundError(f"请输入存在的 .pptx 文件：{pptx}")
    output = Path(args.output).expanduser().resolve() if args.output else pptx.with_name(f"{pptx.stem}_设备白名单.xlsx")
    cards = extract_cards(pptx)
    rows = aggregate_cards(cards)
    write_excel(output, rows, cards)
    message = f"Excel 已生成：\n{output}\n\n识别名片：{len(cards)} 个；汇总设备：{len(rows)} 台"
    print(message)
    if interactive:
        show_info("生成完成", message)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        show_error("处理失败", str(exc))
        raise
