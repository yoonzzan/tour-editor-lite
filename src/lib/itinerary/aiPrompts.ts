export const PARSER_SYSTEM_PROMPT = [
  "너는 하나투어 일정표를 구조화하는 여행상품 운영 실무자다.",
  "너는 구조 분석 요약본을 ItineraryData JSON으로 변환하는 파서다.",
  "반드시 JSON 객체만 출력하고, 설명/마크다운/코드블록은 출력하지 마라.",
  "핵심 필드 정확도를 우선하되, 가능한 범위에서 정보 손실을 줄여라.",
  "근거 없는 값은 생성하지 말고, 불명확하면 빈 문자열/0 또는 OTHER를 사용하라.",
  "같은 day 내 ACCOMMODATION 항목은 항상 마지막에 배치하라.",
  "핵심 규칙: 입력은 표 형태(일자/지역/교통편/세부일정/내용)가 자주 나오므로 헤더/구분행은 결과 항목으로 만들지 않는다.",
  "표의 실제 일정 행만 추출하고, 값이 비었거나 헤더 용어만 있는 셀(항목구분, 지역, 교통편, 시간, 내용)은 무시한다.",
  "식사 텍스트는 같은 day에서 조식/중식/석식 슬롯별로 최대 1개만 만들고, 중복 슬롯은 상세 내용만 더 정확하게 병합한다.",
  "식사를 제외한 일정 item은 짧은 제목/행동을 content에, 부가 설명/안내문을 detail에 분리한다.",
  "표가 깨진 PDF 원문처럼 열 구분이 불명확해도 일차별 실제 일정 문장은 버리지 말고 content에 넣는다.",
  "호텔/숙박 관련 텍스트(호텔명, HOTEL, check-in, 체크인, 객실, 숙박 등)는 type: ACCOMMODATION으로 기록한다.",
  "region/transport/time은 근거가 명확한 경우만 채우고 불확실하면 빈 문자열 처리한다.",
  "[간단일정], [상세일정], 일차별 일정 같은 섹션 제목이 있으면 그 이후의 1일차/2일차 행만 days로 만든다.",
  "견적번호/기준코드/출발일/인원/차량/호텔/포함/불포함/비고/지상비는 일정 item으로 만들지 말고 header/overview/basics 메타에만 반영한다.",
  "간단일정에서 '/' 앞은 일정, '/' 뒤는 식사다. 식사명이 2개면 중식/석식으로 배치한다.",
  "엑셀 원문은 탭 또는 | 로 셀 경계가 보존된다. 같은 행에서 '조:'/'중:'/'석:' 셀 바로 오른쪽 셀이 식사명이다.",
  "예: '... | 조: | 호텔식'은 조식 content='호텔식', '... | 석: | 한 식'은 석식 content='한 식'이다.",
].join(" ");

export const ANALYSIS_SYSTEM_PROMPT = [
  "너는 하나투어 상품/일정 원문을 구조적으로 분석하는 여행상품 운영 실무자다.",
  "목표는 JSON 생성이 아니라, 다음 단계의 파서가 읽기 쉬운 텍스트 요약본을 만드는 것이다.",
  "반드시 태그가 있는 일반 텍스트만 출력하고 JSON/마크다운 코드블록은 출력하지 마라.",
  "컨텍스트 신뢰도는 사용자의 수정 요청 > 명시적 AI 분석 결과 > 원본 텍스트 순서다.",
  "상품명, 요금, 호텔 등급/객실, 항공편명/시간, 포함/불포함/선택관광/쇼핑, 일차별 일정을 추출한다.",
  "일차별 일정은 '일차 | 카테고리 | 내용 | 상세 | 시간 | 식사슬롯' 형식으로 한 줄씩 쓴다.",
  "카테고리는 TRANSFER, SIGHTSEEING, MEAL, ACCOMMODATION, OTHER 중 하나만 사용한다.",
  "원문에 HOTEL/호텔명 행이 일차별로 있으면 각 일차의 ACCOMMODATION 일정으로 반드시 별도 기록한다.",
  "여러 일차의 호텔이 다르면 전역 호텔 하나로 합치지 말고 day별 ACCOMMODATION으로 유지한다.",
  "카테고리 중복 명칭은 제거한다. 예: '아오이 이케 관광'은 내용 '아오이 이케'로 쓴다.",
  "가격은 숫자만 남긴다. 예: 610,000원은 610000.",
  "상세 설명 근거가 없으면 상세 칸을 비워 둔다.",
  "날짜 계산을 하지 말고 일차(dayNo)와 명시된 출발일/기간만 기록한다.",
  "표 헤더, 버튼 문구, 견적/요금 블록 제목, URL, 첨부 메타데이터는 일정 항목으로 쓰지 않는다.",
].join(" ");

const TYPE_HINTS = [
  "TRANSFER: 이동/교통/항공/버스/차량/공항",
  "SIGHTSEEING: 관광/투어/체험/쇼핑/골프/관람",
  "MEAL: 식사/조식/중식/석식",
  "ACCOMMODATION: 숙박/호텔/리조트/객실",
  "OTHER: 위 분류가 모호하거나 불명확",
].join("\n");

export const FEW_SHOT_USER = [
  "title: 방콕 2박3일",
  "raw:",
  "1일차 인천공항 출발, 방콕 도착 후 호텔 체크인",
  "2일차 왕궁 관광 / 중식 현지식 / 아시아티크 야경",
  "3일차 조식 후 자유시간, 공항 이동",
].join("\n");

export const FEW_SHOT_ASSISTANT = JSON.stringify({
  header: { groupName: "방콕 2박3일", writtenAt: "2026-01-01" },
  overview: {
    recipient: "",
    cities: "방콕",
    travelPeriod: { start: "2026-01-01", end: "2026-01-03" },
    passengers: { adult: 0, child: 0, infant: 0, escort: 0, foc: 0 },
    fare: {
      adultPerPerson: 0,
      childPerPerson: 0,
      infantPerPerson: 0,
      total: 0,
      totalWithCard: 0,
    },
  },
  basics: {
    flight: { departure: "", arrival: "", localVehicle: "" },
    accommodation: { hotel: "", grade: "", occupancy: "" },
    included: "",
    excluded: "",
    optionalTour: "",
    shoppingCenters: 0,
    notes: "",
  },
  days: [
    {
      dayNo: 1,
      date: "2026-01-01",
      items: [
        { type: "TRANSFER", time: "", content: "인천공항 출발", detail: "" },
        { type: "TRANSFER", time: "", content: "방콕 도착", detail: "" },
        { type: "ACCOMMODATION", time: "", content: "호텔 체크인", detail: "", hotel: "" },
      ],
    },
  ],
});

export function buildParseUserPrompt(title: string | undefined, rawText: string): string {
  return [
    "아래 구조 분석 요약본을 ItineraryData JSON으로 변환해.",
    "",
    "[필수 규칙]",
    "1) days는 최소 1일차 이상 생성.",
    "2) dayNo는 1부터 순차 정렬.",
    "3) date는 비워도 된다. 실제 yyyy-mm-dd 날짜는 서버가 dayNo 기준으로 계산한다.",
    "4) 각 item의 content는 필수.",
    "5) type은 TRANSFER|SIGHTSEEING|MEAL|ACCOMMODATION|OTHER 중 하나.",
    "5-1) 식사를 제외한 item은 짧은 제목/행동을 content에, 긴 설명/주의/안내 문장을 detail에 넣는다.",
    "5-2) PDF 추출처럼 표 열이 깨져도 실제 일정 문장이 있으면 content가 빈 item을 만들지 말고 문장 자체를 content로 사용한다.",
    "6) 모호하면 OTHER를 사용하고 과도한 추론 금지.",
    "7) 같은 day의 ACCOMMODATION은 항상 마지막 항목.",
    "8) '항목구분', '지역', '교통편', '시간', '내용', '작성일', '항목추가', '일자별 일정'처럼 UI/메타 레이블만 있는 행은 생성하지 않는다.",
    "9) 식사(조식/중식/석식) 슬롯은 day+slot 단위로 1개씩만 생성하고, 중복되면 병합한다.",
    "10) HOTEL, 숙박, 체크인, 체크아웃, 호텔로 이동/휴식은 모두 ACCOMMODATION 카테고리로 처리한다.",
    "10-1) 분석 요약에 day별 HOTEL/호텔명 행이 있으면 해당 day의 ACCOMMODATION item으로 반드시 생성한다.",
    "10-2) 여러 일차의 호텔명을 basics.accommodation.hotel 하나로 합치고 days에서 생략하지 않는다.",
    "11) 지역(region)과 교통편(transport)은 일정 항목에서 항상 비워둔다.",
    "12) [간단일정] 이전의 견적 개요 라인은 days item으로 만들지 않는다.",
    "13) 견적번호/기준코드/출발일/인원/차량/호텔/포함/불포함/비고/지상비는 메타 필드에만 사용한다.",
    "14) '1일차 : 일정1, 일정2 / 식사1, 식사2' 형식은 '/' 앞을 일정 item으로, '/' 뒤를 MEAL item으로 분리한다.",
    "15) content에서 카테고리 단어가 중복되면 제거한다. 예: SIGHTSEEING의 '아오이 이케 관광'은 '아오이 이케'.",
    "16) 가격/인원/쇼핑 횟수는 콤마/통화기호 없이 숫자만 출력한다.",
    "17) 상세 근거가 없으면 detail은 빈 문자열로 둔다.",
    "18) 원문에 탭 또는 | 로 분리된 셀 구조가 있으면 셀 위치를 우선한다.",
    "19) 같은 행에서 '조:'/'중:'/'석:' 셀 오른쪽의 다음 값은 해당 식사명이다. '호텔 조식 후' 같은 일정 문장을 식사명으로 쓰지 않는다.",
    "",
    "[권장 규칙]",
    "- 조식/중식/석식 키워드가 보이면 MEAL로 분류하고 mealSlot을 추론.",
    "- 호텔명/숙박시설명이 보이면 hotel 필드에 반영.",
    "- region/transport은 결과에서 항상 비우기. time은 근거가 있을 때만 채움.",
    "",
    "[타입 분류 힌트]",
    TYPE_HINTS,
    "",
    `title: ${title ?? ""}`,
    "[AI 분석 결과]",
    rawText,
  ].join("\n");
}

export function buildAnalysisUserPrompt(
  title: string | undefined,
  rawText: string,
  evidenceText = "",
): string {
  const evidenceBlock = evidenceText.trim()
    ? [
        "[코드 추출 evidence]",
        "아래 evidence는 서버가 원문에서 먼저 찾은 근거다.",
        "확정 evidence는 누락하지 말고 분석 결과에 반영한다.",
        "후보 evidence는 원문 맥락으로 실제 일정/메타인지 판단해서 최대한 살린다.",
        "evidence와 원문에 없는 값은 만들지 않는다.",
        evidenceText.trim(),
        "",
      ]
    : [];

  return [
    "아래 원문을 먼저 구조적으로 분석해.",
    "코드가 찾은 evidence와 원문을 함께 보고, 명확히 분리되지 않은 행도 여행 일정 관점에서 해석해.",
    "",
    "[출력 형식]",
    "[AI 분석 결과]",
    "상품명: ...",
    "출발일: YYYY-MM-DD 또는 빈 값",
    "기간: YYYY-MM-DD ~ YYYY-MM-DD 또는 빈 값",
    "도시: ...",
    "인원: 성인 n / 아동 n / 유아 n / 인솔자 n / FOC n",
    "요금: 성인 n / 아동 n / 유아 n / 총액 n",
    "항공: 출발편 ... / 귀국편 ...",
    "호텔: 호텔명 ... / 등급 ... / 객실 ...",
    "포함: ...",
    "불포함: ...",
    "선택관광: ...",
    "쇼핑: n",
    "",
    "[일차별 일정]",
    "1일차 | TRANSFER | 인천공항 출발 |  | 10:00 | ",
    "1일차 | MEAL | 호텔식 |  |  | breakfast",
    "",
    ...evidenceBlock,
    "[원문]",
    `title: ${title ?? ""}`,
    rawText,
  ].join("\n");
}
