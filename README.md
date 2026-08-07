# arXiv Swipe

arXiv 신착 논문을 SNS 피드처럼 위아래로 넘겨보는 모바일 웹앱. 빌드 도구 없는 정적 페이지라 GitHub Pages에 그대로 올라갑니다.

## 어떻게 동작하나

arXiv API(`export.arxiv.org`)는 **CORS 헤더를 주지 않습니다.** 브라우저에서 직접 호출하면 차단되고, 공개 CORS 프록시는 실측 결과 522/521/429로 불안정했습니다. 그래서 수집을 서버 쪽으로 옮겼습니다.

```
GitHub Actions (3시간마다)
  └─ scripts/fetch_papers.py  →  data/papers.json 커밋
                                      │
                                 GitHub Pages
                                      │
                              브라우저는 정적 JSON만 읽음
```

내 PC는 꺼져 있어도 됩니다. 수집은 GitHub 서버에서 돕니다.

## 기능

| | |
|---|---|
| 위/아래 스와이프 | 다음·이전 논문 (CSS scroll-snap, 데스크톱은 ↑↓ · j/k) |
| 더블탭 | 저장 / 저장 해제 (`localStorage`) |
| 카드 탭 | 초록 펼치기·접기 |
| 상단 탭 | 분야 전환 · ★ 저장한 논문 |
| 레일 버튼 | 저장 · 공유(Web Share API) · BibTeX 복사 |
| 상단 배지 | 방문자 수 (오늘 / 전체) |

분야별로 배경 색상각이 달라져서 스크롤만 해도 어떤 분야인지 감이 옵니다. 제목·초록의 LaTeX 마크업(`$\omega$` 등)은 렌더링 전에 벗겨냅니다.

## 파일

```
index.html                     마크업
styles.css                     스타일 (다크 전용, 100dvh + safe-area)
app.js                         피드 렌더링 · 저장 · 방문자 카운터
scripts/fetch_papers.py        arXiv 수집기 (표준 라이브러리만)
data/papers.json               수집 결과 (Actions가 갱신)
.github/workflows/update.yml   수집 + Pages 배포
```

## 로컬 실행

```bash
python3 -m http.server 4173
```

데이터를 직접 다시 받으려면:

```bash
python3 scripts/fetch_papers.py
```

## 설정

- **분야 추가/변경** — `scripts/fetch_papers.py`의 `CATEGORIES`, 색상은 `app.js`의 `HUE`
- **분야당 수집 편수** — 환경변수 `PER_CATEGORY` (기본 40)
- **수집 주기** — `.github/workflows/update.yml`의 `cron`
- **방문자 카운터** — `app.js`의 `COUNTER_NS`. [abacus](https://abacus.jasoncameron.dev) 공개 API를 쓰며, 네임스페이스가 전역 공용이라 포크한다면 값을 바꾸세요. 카운터가 죽으면 배지는 조용히 숨습니다.

## 알아둘 것

- 방문자 수는 abacus라는 외부 무료 API에 의존합니다. 정확한 분석이 필요하면 GoatCounter나 Cloudflare Web Analytics로 바꾸세요.
- 세션당 1회만 집계하므로(새로고침은 재집계 안 함) 순방문에 가깝지만, 브라우저를 새로 열면 다시 셉니다.
- arXiv API는 요청 간 3초 간격을 권장합니다. 수집기가 이를 지킵니다.
