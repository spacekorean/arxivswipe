#!/usr/bin/env python3
"""arXiv 신착 논문을 긁어 data/papers.json 으로 저장한다.

- 표준 라이브러리만 사용 (GitHub Actions에서 별도 설치 불필요)
- arXiv API 권장 사항에 따라 요청 사이에 3초 대기
- 카테고리별로 최신 submittedDate 순으로 가져온 뒤 id 기준으로 합침
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

API = "https://export.arxiv.org/api/query"
NS = {
    "a": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}

# 피드에 노출할 카테고리 (id, 짧은 라벨, 한국어 설명)
CATEGORIES = [
    ("cs.AI", "AI", "인공지능"),
    ("cs.CL", "NLP", "자연어처리"),
    ("cs.CV", "Vision", "컴퓨터비전"),
    ("cs.LG", "ML", "머신러닝"),
    ("cs.RO", "Robotics", "로보틱스"),
    ("cs.CR", "Security", "보안·암호"),
    ("cs.HC", "HCI", "인간-컴퓨터 상호작용"),
    ("stat.ML", "Stats", "통계적 학습"),
]

PER_CATEGORY = int(os.environ.get("PER_CATEGORY", "40"))
SLEEP = float(os.environ.get("ARXIV_SLEEP", "3.0"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "papers.json")


def squash(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def fetch(category, retries=3):
    query = urllib.parse.urlencode(
        {
            "search_query": "cat:%s" % category,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
            "start": 0,
            "max_results": PER_CATEGORY,
        }
    )
    url = "%s?%s" % (API, query)
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "arxiv-swipe/1.0 (+https://github.com/)"}
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception as exc:  # 네트워크/일시적 5xx
            last = exc
            sys.stderr.write("  retry %d for %s: %s\n" % (attempt + 1, category, exc))
            time.sleep(SLEEP * (attempt + 1))
    raise RuntimeError("failed to fetch %s: %s" % (category, last))


def parse(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = []
    for entry in root.findall("a:entry", NS):
        raw_id = entry.findtext("a:id", "", NS)
        m = re.search(r"abs/([^v]+)(v\d+)?$", raw_id)
        if not m:
            continue
        arxiv_id = m.group(1)
        version = (m.group(2) or "v1").lstrip("v")

        cats = [c.get("term") for c in entry.findall("a:category", NS) if c.get("term")]
        primary_el = entry.find("arxiv:primary_category", NS)
        primary = primary_el.get("term") if primary_el is not None else (cats[0] if cats else "")

        authors = [
            squash(a.findtext("a:name", "", NS))
            for a in entry.findall("a:author", NS)
        ]

        out.append(
            {
                "id": arxiv_id,
                "v": version,
                "title": squash(entry.findtext("a:title", "", NS)),
                "summary": squash(entry.findtext("a:summary", "", NS)),
                "authors": [a for a in authors if a],
                "published": entry.findtext("a:published", "", NS),
                "updated": entry.findtext("a:updated", "", NS),
                "primary": primary,
                "cats": cats,
                "comment": squash(entry.findtext("arxiv:comment", "", NS)) or None,
                "journal": squash(entry.findtext("arxiv:journal_ref", "", NS)) or None,
                "abs": "https://arxiv.org/abs/%s" % arxiv_id,
                "pdf": "https://arxiv.org/pdf/%s" % arxiv_id,
            }
        )
    return out


def main():
    merged = {}
    for i, (cat, _label, _ko) in enumerate(CATEGORIES):
        if i:
            time.sleep(SLEEP)
        sys.stderr.write("fetching %s ...\n" % cat)
        papers = parse(fetch(cat))
        sys.stderr.write("  got %d\n" % len(papers))
        for p in papers:
            # 같은 논문이 여러 카테고리에 걸치면 한 번만 담는다
            merged.setdefault(p["id"], p)

    papers = sorted(merged.values(), key=lambda p: p["published"], reverse=True)

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(papers),
        "categories": [
            {"id": c, "label": label, "ko": ko} for (c, label, ko) in CATEGORIES
        ],
        "papers": papers,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    sys.stderr.write(
        "wrote %s (%d papers, %.1f KB)\n"
        % (OUT, len(papers), os.path.getsize(OUT) / 1024.0)
    )


if __name__ == "__main__":
    main()
