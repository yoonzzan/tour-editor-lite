# Quote Response Fixtures

견적답변 OCR 및 텍스트 파서 회귀 확인용 fixture를 둔다.

## Rules

- 이미지 fixture는 실제 고객 개인정보, 전화번호, 이메일, 담당자 실명, 계좌 정보를 포함하지 않는다.
- 일정표 fixture와 섞지 않는다. 여행 일정 파일은 `tests/fixtures/itinerary-golden/`, 견적답변 이미지는 이 폴더에 둔다.
- fixture를 추가하면 가능한 한 `npm run test:quote-response` 또는 `npm run test:parser`에서 확인 가능한 회귀 케이스를 함께 추가한다.

## Current Cases

- `견적답변3.png`: 항공/지상/공동경비 섹션 경계와 비고 금액 제외 확인용
- `견적답변4.png`: 항공료/TAX 분리, 보험료 열 보정 확인용
- `파싱이상.png`: 기존 오인식 사례 보존용
