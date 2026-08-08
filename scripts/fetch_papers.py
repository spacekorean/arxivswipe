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

# 피드의 주제 탭.
#   query — API에 실제로 던지는 arXiv 카테고리 (OR로 묶어 한 번에 요청)
#   match — 논문을 이 주제로 분류할 때 쓰는 접두사 (프론트엔드 필터와 공유)
#
# astro-ph / cond-mat / physics / math 처럼 하위로 쪼개진 아카이브는 이름만으로
# 질의하면 2007년 이전 논문만 잡힌다. 반드시 하위 카테고리를 나열해야 한다.
TOPICS = [
    ("ai",       "AI",       "인공지능",      ["cs.AI"],  ["cs.AI"]),
    ("astro",    "Astro",    "천체·우주",     [
        "astro-ph.GA", "astro-ph.CO", "astro-ph.EP",
        "astro-ph.HE", "astro-ph.IM", "astro-ph.SR",
    ], ["astro-ph"]),
    ("quantum",  "Quantum",  "양자물리",      ["quant-ph"], ["quant-ph"]),
    ("nlp",      "NLP",      "자연어처리",    ["cs.CL"],  ["cs.CL"]),
    ("vision",   "Vision",   "컴퓨터비전",    ["cs.CV"],  ["cs.CV"]),
    ("ml",       "ML",       "머신러닝",      ["cs.LG", "stat.ML"], ["cs.LG", "stat.ML"]),
    ("hep",      "HEP",      "고에너지",      [
        "hep-th", "hep-ph", "hep-ex", "hep-lat",
    ], ["hep-th", "hep-ph", "hep-ex", "hep-lat"]),
    ("condmat",  "CondMat",  "응집물질",      [
        "cond-mat.dis-nn", "cond-mat.mes-hall", "cond-mat.mtrl-sci",
        "cond-mat.quant-gas", "cond-mat.soft", "cond-mat.stat-mech",
        "cond-mat.str-el", "cond-mat.supr-con",
    ], ["cond-mat"]),
    ("physics",  "Physics",  "광학·응용물리", [
        "physics.optics", "physics.app-ph", "physics.ins-det",
        "physics.plasm-ph", "physics.flu-dyn", "physics.space-ph",
        "physics.atom-ph", "physics.comp-ph",
    ], ["physics"]),
    ("robotics", "Robotics", "로보틱스",      ["cs.RO"],  ["cs.RO"]),
    ("math",     "Math",     "수학",          [
        "math.OC", "math.PR", "math.ST", "math.NA", "math.CO",
        "math.AP", "math.DS", "math.NT", "math.AG",
    ], ["math", "math-ph"]),
    ("gravity",  "Gravity",  "중력·상대성",   ["gr-qc"],  ["gr-qc"]),
    ("nuclear",  "Nuclear",  "핵물리",        ["nucl-th", "nucl-ex"], ["nucl-th", "nucl-ex"]),
    ("bio",      "Bio",      "생명·의학",     [
        "q-bio.BM", "q-bio.CB", "q-bio.GN", "q-bio.MN",
        "q-bio.NC", "q-bio.PE", "q-bio.QM", "q-bio.SC",
    ], ["q-bio", "physics.med-ph", "physics.bio-ph"]),
    ("eess",     "EESS",     "신호·전자",     [
        "eess.AS", "eess.IV", "eess.SP", "eess.SY",
    ], ["eess"]),
    ("stats",    "Stats",    "통계",          [
        "stat.AP", "stat.CO", "stat.ME", "stat.TH",
    ], ["stat"]),
    ("econ",     "Econ",     "경제·금융",     [
        "q-fin.CP", "q-fin.GN", "q-fin.MF", "q-fin.PM",
        "q-fin.PR", "q-fin.RM", "q-fin.ST", "q-fin.TR",
        "econ.EM", "econ.GN", "econ.TH",
    ], ["q-fin", "econ"]),
    ("security", "Security", "보안·암호",     ["cs.CR"],  ["cs.CR"]),
    ("hci",      "HCI",      "HCI",           ["cs.HC"],  ["cs.HC"]),
]

PER_CATEGORY = int(os.environ.get("PER_CATEGORY", "30"))
SLEEP = float(os.environ.get("ARXIV_SLEEP", "3.0"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "papers.json")


def squash(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def fetch(cats, label, retries=3):
    query = urllib.parse.urlencode(
        {
            "search_query": " OR ".join("cat:%s" % c for c in cats),
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
            with urllib.request.urlopen(req, timeout=90) as resp:
                return resp.read()
        except Exception as exc:  # 네트워크/일시적 5xx
            last = exc
            sys.stderr.write("  retry %d for %s: %s\n" % (attempt + 1, label, exc))
            time.sleep(SLEEP * (attempt + 1))
    raise RuntimeError("failed to fetch %s: %s" % (label, last))


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
    for i, (tid, label, ko, query, _match) in enumerate(TOPICS):
        if i:
            time.sleep(SLEEP)   # arXiv는 요청 간 3초 간격을 권장한다
        sys.stderr.write("fetching %s (%s) ...\n" % (tid, ko))
        papers = parse(fetch(query, tid))
        sys.stderr.write("  got %d\n" % len(papers))
        if not papers:
            sys.stderr.write("  !! 빈 응답 — query를 확인할 것: %s\n" % query)
        for p in papers:
            # 같은 논문이 여러 주제에 걸치면 한 번만 담는다
            merged.setdefault(p["id"], p)

    papers = sorted(merged.values(), key=lambda p: p["published"], reverse=True)

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(papers),
        "categories": [
            {"id": tid, "label": label, "ko": ko, "match": match}
            for (tid, label, ko, _query, match) in TOPICS
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
